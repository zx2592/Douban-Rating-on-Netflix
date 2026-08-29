import { cacheKey, type RatingCache } from './cache';
import type { DoubanClient } from './douban/client';
import type { InterestStore } from './interest';
import { pickBestMatch } from './matcher';
import { RateLimitedError, type Priority } from './queue';
import { buildSearchTerms } from './search-terms';
import type { DoubanRating, LookupOutcome, MediaQuery } from '../shared/types';

/**
 * 把缓存、检索、匹配、取分四步串起来，对外只暴露一个 lookup。
 *
 * 除了缓存，这里还做了「同一标题的并发去重」：Netflix 首页上同一部片子
 * 经常同时出现在好几个榜单里，一次滚动就会并发触发多次相同查询。没有这层
 * 去重的话，它们会各自排进请求队列，把限速额度白白耗光。
 */
export class RatingLookup {
  private readonly inFlight = new Map<string, Promise<LookupOutcome>>();

  constructor(
    private readonly cache: RatingCache,
    private readonly client: DoubanClient,
    /** 用户点击过的影片记录。不传则所有查询一视同仁。 */
    private readonly interest: InterestStore | null = null,
  ) {}

  async lookup(query: MediaQuery): Promise<LookupOutcome> {
    if (!query.title.trim()) return { status: 'not_found' };

    const interestedAt = this.interest ? await this.interest.interestedAt(query) : null;
    const key = cacheKey(query);
    const cached = await this.cache.get(key);
    if (cached) {
      if (cached.rating) return { status: 'ok', rating: cached.rating };
      // 缓存里是「未收录」。若用户后来点开过这部片，而这条记录是在那之前
      // 写下的，就不认它 —— 「未收录」相当一部分其实是当时被限流的结果，
      // 而用户明确表达过兴趣的片子值得再花一次配额确认。
      //
      // 重查后无论结果如何都会以当前时间重新写入缓存，于是 at 追上兴趣
      // 时间戳，这个绕过就自动失效；下一次绕过要等到 mark() 的冷却期
      // 过去、用户再次点击。所以它不会变成对同一部片的反复重查。
      if (interestedAt === null || cached.at >= interestedAt) return { status: 'not_found' };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const priority: Priority = interestedAt !== null ? 'high' : 'normal';
    const pending = this.resolve(query, key, priority).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async resolve(query: MediaQuery, key: string, priority: Priority): Promise<LookupOutcome> {
    try {
      // 依次尝试各个检索词，命中即止。用去掉季数后缀的主标题去搜，召回更广；
      // 具体是哪一季交给匹配器判断，因为豆瓣的候选标题里本来就带着
      // "第二季" 这样的后缀。
      //
      // 每个检索词走两级：先 suggest（轻、限流松），拿不到可信匹配再上
      // 完整搜索（召回宽、限流严）。suggest 返回空既可能是真没有也可能是
      // 它在限流，无法区分，所以必须有第二级兜底。
      let best = null;
      for (const term of buildSearchTerms(query.title)) {
        best = pickBestMatch(query, await this.client.suggest(term, priority));
        if (best) break;
        try {
          best = pickBestMatch(query, await this.client.fullSearch(term, priority));
        } catch (error) {
          // 完整搜索限流或静默期中：suggest 已经没找到，此时不能断定
          // "豆瓣没这部片"，按暂时性错误处理，绝不能写进缓存。
          if (error instanceof RateLimitedError) {
            return { status: 'error', reason: error.message, retryAfterMs: error.retryAfterMs };
          }
          throw error;
        }
        if (best) break;
      }
      if (!best) {
        this.cache.set(key, null);
        return { status: 'not_found' };
      }

      // 搜索结果里通常已经带着评分，此时不必再单独请求一次 —— 请求数减半，
      // 出分速度直接翻倍，对限流也更友好。只有搜索结果没给分时才回退。
      const detail =
        best.candidate.score !== null
          ? { score: best.candidate.score, votes: best.candidate.votes }
          : await this.client.fetchRating(best.candidate.id, priority);

      const rating: DoubanRating = {
        id: best.candidate.id,
        title: best.candidate.title,
        score: detail.score,
        votes: detail.votes ?? best.candidate.votes,
        year: best.candidate.year,
        type: best.candidate.type,
        url: best.candidate.url,
        confidence: best.confidence,
      };
      this.cache.set(key, rating);
      return { status: 'ok', rating };
    } catch (error) {
      // 网络错误和限流都是暂时的，不写缓存，下次滚到这张卡片时再试。
      if (error instanceof RateLimitedError) {
        return { status: 'error', reason: error.message, retryAfterMs: error.retryAfterMs };
      }
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
