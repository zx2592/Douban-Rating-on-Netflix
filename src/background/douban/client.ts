import type { Candidate } from '../matcher';
import { RateLimitedError, type RequestQueue } from '../queue';
import { parseSubjectAbstract, parseSuggest, type RatingDetail } from './parse';

/**
 * 检索接口。原先在 www.douban.com 下，豆瓣已把它下掉（返回 404），
 * 同名接口现在挂在 movie 子域上，参数结构没变。
 */
const SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest';
const ABSTRACT_URL = 'https://movie.douban.com/j/subject_abstract';

const REQUEST_TIMEOUT_MS = 8000;

/** 豆瓣触发风控时会返回一个正常状态码的验证页，靠特征串识别。 */
const ANTI_BOT_MARKERS = ['sec.douban.com', '有异常请求', '检测到有异常'];

export interface DoubanClientOptions {
  /** 单测里替换成假的 fetch。 */
  fetchImpl?: typeof fetch;
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

  constructor(
    private readonly queue: RequestQueue,
    options: DoubanClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** 按标题检索候选条目。返回的候选不含评分。 */
  async search(title: string): Promise<Candidate[]> {
    const url = `${SUGGEST_URL}?q=${encodeURIComponent(title)}`;
    return parseSuggest(this.parseJson(await this.request(url), '豆瓣检索接口'));
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
    const payload = this.parseJson(await this.request(url), '豆瓣评分接口');
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

  private request(url: string): Promise<string> {
    return this.queue.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          credentials: 'omit',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
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
