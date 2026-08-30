import type { Candidate } from '../matcher';
import { RateLimitedError, type Priority, type RequestQueue } from '../queue';
import { parseGraphqlRating, parseSuggestion, type RatingDetail } from './parse';

/**
 * IMDb 站内接口的客户端。
 *
 * 重要背景：IMDb 同样没有面向第三方的免费 API（官方 API 要钱，OMDb 要注册
 * key），所以这里走的是 imdb.com 自己在用的两个入口。和豆瓣一样没有契约
 * 保证，**而且开发环境的网络策略禁止访问 imdb.com，无法像当初排查豆瓣那样
 * 先实测**。因此这一层的写法比豆瓣那边更保守：
 *
 * - 检索和取分都给一组候选路径，逐个尝试，第一个能解析出结构的胜出；
 * - 某条路径返回的结构对不上，就在本进程内标记为不可用，后续直接跳过它，
 *   避免每部片都白费一次请求；
 * - 哪条路径真正可用，由扩展内的「检索接口诊断」页在用户浏览器里跑出来
 *   （见 src/shared/probe.ts）—— 那里才是真实网络环境。
 */

/**
 * 检索入口，按尝试顺序。都是 imdb.com 搜索框自己用的下拉建议接口：
 * 免 key、免 cookie、响应只有几 KB，比抓搜索结果页轻得多。
 */
const SUGGESTION_ENDPOINTS = [
  (query: string) =>
    `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json?includeVideos=0`,
  (query: string) => `https://v2.sg.media-imdb.com/suggestion/t/${encodeURIComponent(query)}.json`,
];

const GRAPHQL_URL = 'https://api.graphql.imdb.com/';

/**
 * GraphQL 必须带上这几个头，否则一律 403。**这是实测出来的，不是抄的。**
 *
 * 同一个地址、同一个查询：裸 POST → 403（正文是 nginx 的 403 页面）；
 * 改用 GET → 403；带上这三个头 → 200 + 444 字节的评分。
 *
 * 为什么是这几个：它们是 imdb.com 前端自己调这个接口时带的。刻意**不用**
 * Origin / Referer —— 那两个是 Fetch 规范里的禁止修改头，扩展设了也会被
 * 浏览器忽略。所幸实测证明不需要它们，只要这三个自定义头就够。
 */
const IMDB_HEADERS: Record<string, string> = {
  'x-imdb-client-name': 'imdb-web-next',
  'x-imdb-user-country': 'US',
  'x-imdb-user-language': 'en-US',
};

/**
 * 取分只要这三个字段，别的一律不取 —— 响应越小越快，也越不容易因为
 * 无关字段改名而整个查询失败。
 */
const RATING_QUERY =
  'query TitleRating($id: ID!) { title(id: $id) { ratingsSummary { aggregateRating voteCount } } }';

const REQUEST_TIMEOUT_MS = 8000;

export interface ImdbClientOptions {
  fetchImpl?: typeof fetch;
}

export class ImdbClient {
  private readonly fetchImpl: typeof fetch;
  /**
   * 本进程内已确认结构对不上的检索入口。
   *
   * 只在内存里，service worker 重启后自动清空 —— 这是有意的：IMDb 改回来或
   * 我们改对了之后，不需要用户做任何操作就能自愈。
   */
  private deadEndpoints = new Set<number>();

  constructor(
    private readonly queue: RequestQueue,
    options: ImdbClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** 诊断页用：当前哪些路径已被判定不可用。 */
  get disabledPaths(): string[] {
    return [...this.deadEndpoints].map((index) => `suggestion#${index}`);
  }

  /**
   * 检索候选条目。逐个尝试检索入口，第一个返回非空结果的胜出。
   *
   * 全部返回空数组时也返回空 —— 和豆瓣的 suggest 一样，这既可能是真没有，
   * 也可能是被限流，无法区分，所以上层绝不能把空结果当成事实长期缓存。
   */
  async search(title: string, priority: Priority = 'normal'): Promise<Candidate[]> {
    let lastError: unknown = null;

    for (const [index, buildUrl] of SUGGESTION_ENDPOINTS.entries()) {
      if (this.deadEndpoints.has(index)) continue;
      try {
        const body = await this.request(buildUrl(title), 'application/json', priority);
        const candidates = parseSuggestion(parseJson(body));
        if (candidates.length > 0) return candidates;
        // 能解析、但没有匹配项：这条入口是通的，不必再试下一条。
        return [];
      } catch (error) {
        // 限流是全局状态，换个入口也没用，直接抛给上层。
        if (error instanceof RateLimitedError) throw error;
        if (error instanceof StructureError) this.deadEndpoints.add(index);
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  /**
   * 取某个条目的评分。
   *
   * 只有 GraphQL 这一条路，**刻意不留条目页 HTML 作兜底**：实测
   * www.imdb.com/title/… 在浏览器里也只返回 1997 字节的反爬拦截页
   * （正文明确含 "enable javascript" 和 "challenge"）。留着它意味着
   * 每次 GraphQL 失败都要再白下一次 2KB 的拦截页、再报一条误导性的
   * 「页面里没有评分数据」。这和当初移除豆瓣条目页兜底是同一个道理。
   *
   * score 为 null 表示「IMDb 确实还没给这部片出分」，是一个有效结果；
   * 接口不可用时抛异常，由上层区分对待 —— 把网络故障显示成
   * 「暂无评分」会误导用户。
   */
  async fetchRating(id: string, priority: Priority = 'normal'): Promise<RatingDetail> {
    const body = await this.request(GRAPHQL_URL, 'application/json', priority, {
      method: 'POST',
      body: JSON.stringify({ query: RATING_QUERY, variables: { id } }),
    });
    const detail = parseGraphqlRating(parseJson(body));
    if (!detail) throw new StructureError('IMDb GraphQL 的返回结构已变化');
    return detail;
  }

  private request(
    url: string,
    accept: string,
    priority: Priority,
    init: { method?: string; body?: string } = {},
  ): Promise<string> {
    return this.queue.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = { Accept: accept, ...IMDB_HEADERS };
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';

        const response = await this.fetchImpl(url, {
          method: init.method ?? 'GET',
          ...(init.body !== undefined ? { body: init.body } : {}),
          // 和豆瓣同一条原则：不带用户的登录态去访问第三方站点。
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
          headers,
        });

        if (response.status === 403 || response.status === 429) {
          const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
          const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
          this.queue.noteRateLimited(retryAfterMs);
          throw new RateLimitedError(retryAfterMs ?? 30_000);
        }
        // 404 是「这条路径不存在」，多半是接口下线或路径写法变了，
        // 和「网络不好」不是一回事，要能触发降级。
        if (response.status === 404) {
          throw new StructureError(`IMDb 返回 HTTP 404：${new URL(url).host}`);
        }
        if (!response.ok) {
          throw new Error(`IMDb 返回 HTTP ${response.status}`);
        }

        this.queue.noteSuccess();
        return await response.text();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('IMDb 请求超时');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }, priority);
  }
}

/**
 * 「响应拿到了，但结构不是我们认识的那个」。
 *
 * 和网络错误分开是有意义的：网络错误换条路径也一样失败，重试才对；
 * 结构错误说明这条路径本身已经不对了，应该立刻降级到下一条，并且
 * 在本进程内不再尝试它。
 */
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new StructureError('IMDb 返回了非 JSON 内容');
  }
}
