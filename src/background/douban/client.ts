import type { Candidate } from '../matcher';
import { RateLimitedError, type RequestQueue } from '../queue';
import { parseSubjectAbstract, parseSuggest, type RatingDetail } from './parse';
import { extractEmbeddedData, parseSearchResults } from './search';

/**
 * 两个检索入口，主备关系（都实测过）：
 *
 * - subject_suggest：主。轻（几百字节）、带年份和原名、简体和英文都能查
 *   （繁体查不到，靠上层先做繁转简）。它被限流时的表现是返回空数组而不是
 *   报错 —— 一度让我们误判它「彻底废了」。
 * - subject_search 完整搜索：备。召回宽得多（会搜「又名」，港台译名靠它），
 *   且结果自带评分；但对无 cookie 访问的限流极严，几次就触发软限流：
 *   HTTP 200 + error_info:"搜索访问太频繁。" + items 空。这个形态曾被当成
 *   有效的空结果缓存成「未收录」，是一整轮全部片子显示未收录的直接原因 ——
 *   所以 error_info 非空必须按限流处理，绝不能当成"豆瓣没这部片"。
 */
const SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest';
const SEARCH_URL = 'https://search.douban.com/movie/subject_search';
const ABSTRACT_URL = 'https://movie.douban.com/j/subject_abstract';

/** 完整搜索触发软限流后的静默期。期间直接跳过它，不再白费请求。 */
const FULL_SEARCH_BACKOFF_MS = 5 * 60_000;

const REQUEST_TIMEOUT_MS = 8000;

/** 豆瓣触发风控时会返回一个正常状态码的验证页，靠特征串识别。 */
const ANTI_BOT_MARKERS = ['sec.douban.com', '有异常请求', '检测到有异常'];

export interface DoubanClientOptions {
  /** 单测里替换成假的 fetch。 */
  fetchImpl?: typeof fetch;
  /** 完整搜索的静默期变化时回调，用于跨 service worker 重启持久化。 */
  onFullSearchBackoffChange?: (until: number) => void;
}

function looksLikeAntiBot(body: string, finalUrl: string): boolean {
  if (finalUrl.includes('sec.douban.com')) return true;
  const head = body.slice(0, 2000);
  return ANTI_BOT_MARKERS.some((marker) => head.includes(marker));
}

/**
 * 豆瓣站内接口的客户端。
 *
 * 所有出网请求都经由 RequestQueue 串行限速，并在识别到风控时让队列进入退避。
 * 请求一律不带 cookie（credentials: 'omit'）：带上用户的豆瓣登录态确实能提高
 * 成功率，但那等于让扩展以用户身份访问豆瓣，风险和收益不成正比。
 *
 * 只用这两个 JSON 接口，不解析条目页 HTML —— 实测扩展直接请求
 * movie.douban.com/subject/<id>/ 会被立刻重定向到 sec.douban.com 的风控页，
 * 拿它兜底不但取不到分，还会白白把队列打进退避、连累后续正常请求。
 */
export class DoubanClient {
  private readonly fetchImpl: typeof fetch;
  private readonly onFullSearchBackoffChange: (until: number) => void;

  constructor(
    private readonly queue: RequestQueue,
    options: DoubanClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onFullSearchBackoffChange = options.onFullSearchBackoffChange ?? (() => {});
  }

  /** 恢复上次进程留下的完整搜索静默期。service worker 重启后由 background 调用。 */
  restoreFullSearchBackoff(until: number): void {
    if (until > Date.now()) this.fullSearchBackoffUntil = until;
  }

  /** 完整搜索的软限流截止时刻。只限制这一个接口，不牵连 suggest。 */
  private fullSearchBackoffUntil = 0;

  /**
   * 主检索：subject_suggest。轻量，候选带年份和原名，但不带评分
   * （由上层用 fetchRating 补）。返回空数组既可能是真没有，也可能是它在
   * 限流 —— 无法区分，所以上层拿不到可信匹配时要再试 fullSearch。
   */
  async suggest(title: string): Promise<Candidate[]> {
    const url = `${SUGGEST_URL}?q=${encodeURIComponent(title)}`;
    const body = await this.request(url, 'application/json');
    return parseSuggest(this.parseJson(body, '豆瓣检索接口'));
  }

  /**
   * 兜底检索：完整搜索。召回宽（含港台译名），候选自带评分；
   * 软限流严，触发后本方法静默 5 分钟，避免每张卡片都去撞一次。
   */
  async fullSearch(title: string): Promise<Candidate[]> {
    if (Date.now() < this.fullSearchBackoffUntil) {
      throw new Error('豆瓣完整搜索仍在限流静默期');
    }
    const url = `${SEARCH_URL}?cat=1002&search_text=${encodeURIComponent(title)}`;
    const data = extractEmbeddedData(await this.request(url, 'text/html'));
    if (data === null) throw new Error('豆瓣搜索页的结构已变化');

    const errorInfo = (data as Record<string, unknown>)['error_info'];
    if (typeof errorInfo === 'string' && errorInfo.trim()) {
      // 软限流：HTTP 200、结构完好、items 为空、只有这个字段说了实话。
      // 只静默本接口，不动全局队列 —— suggest 和取分不受它牵连。
      this.fullSearchBackoffUntil = Date.now() + FULL_SEARCH_BACKOFF_MS;
      this.onFullSearchBackoffChange(this.fullSearchBackoffUntil);
      throw new RateLimitedError(FULL_SEARCH_BACKOFF_MS);
    }
    return parseSearchResults(data);
  }

  /**
   * 取某个条目的评分。
   *
   * 返回值里的 score 为 null 表示「豆瓣确实还没给这部片出分」（评价人数太少），
   * 是一个有效结果；接口本身不可用时抛异常，由上层区分对待 —— 把网络故障
   * 显示成「暂无评分」会误导用户。
   */
  async fetchRating(id: string): Promise<RatingDetail> {
    const url = `${ABSTRACT_URL}?subject_id=${encodeURIComponent(id)}`;
    const payload = this.parseJson(await this.request(url, 'application/json'), '豆瓣评分接口');
    const detail = parseSubjectAbstract(payload);
    if (!detail) throw new Error('豆瓣评分接口的返回结构已变化');
    return detail;
  }

  private parseJson(body: string, label: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      // 返回的不是 JSON，多半是改版或风控页面但没命中特征串。
      throw new Error(`${label}返回了非预期内容`);
    }
  }

  private request(url: string, accept: string): Promise<string> {
    return this.queue.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: accept },
        });

        if (response.status === 403 || response.status === 429) {
          const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
          const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
          this.queue.noteRateLimited(retryAfterMs);
          throw new RateLimitedError(retryAfterMs ?? 30_000);
        }
        if (!response.ok) {
          throw new Error(`豆瓣返回 HTTP ${response.status}`);
        }

        const body = await response.text();
        if (looksLikeAntiBot(body, response.url)) {
          this.queue.noteRateLimited();
          throw new RateLimitedError(30_000);
        }

        this.queue.noteSuccess();
        return body;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('豆瓣请求超时');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
