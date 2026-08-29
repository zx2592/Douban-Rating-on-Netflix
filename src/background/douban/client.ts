import type { Candidate } from '../matcher';
import { RateLimitedError, type RequestQueue } from '../queue';
import { parseSubjectAbstract, parseSubjectHtml, type RatingDetail } from './parse';
import { parseSuggest } from './parse';

const SUGGEST_URL = 'https://www.douban.com/j/subject_suggest';
const ABSTRACT_URL = 'https://movie.douban.com/j/subject_abstract';
const SUBJECT_URL = 'https://movie.douban.com/subject';

const REQUEST_TIMEOUT_MS = 8000;

/** 豆瓣触发风控时会返回一个正常状态码的验证页，靠特征串识别。 */
const ANTI_BOT_MARKERS = ['sec.douban.com', '有异常请求', '检测到有异常', 'window.location.href='];

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
    const body = await this.request(url, 'application/json');
    try {
      return parseSuggest(JSON.parse(body));
    } catch {
      // 返回的不是 JSON，多半是风控页面，但没命中特征串。
      throw new Error('豆瓣检索返回了非预期内容');
    }
  }

  /**
   * 取某个条目的评分。先打轻量的 subject_abstract，失败再回退到解析条目页 HTML。
   *
   * 之所以留两条路：subject_abstract 是没有任何公开承诺的站内接口，
   * 豆瓣改版把它下掉过不止一次；而条目页 HTML 只要页面还在就一定能解析出来，
   * 只是要多下载上百 KB，所以放在后面。
   */
  async fetchRating(id: string): Promise<RatingDetail | null> {
    try {
      const body = await this.request(`${ABSTRACT_URL}?subject_id=${encodeURIComponent(id)}`, 'application/json');
      const detail = parseSubjectAbstract(JSON.parse(body));
      if (detail && detail.score !== null) return detail;
    } catch (error) {
      // 被限流就别再拿 HTML 去撞第二次了，直接抛给上层。
      if (error instanceof RateLimitedError) throw error;
    }

    const html = await this.request(`${SUBJECT_URL}/${encodeURIComponent(id)}/`, 'text/html');
    return parseSubjectHtml(html);
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
