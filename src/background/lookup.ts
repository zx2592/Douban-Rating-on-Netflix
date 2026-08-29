import { cacheKey, type RatingCache } from './cache';
import type { DoubanClient } from './douban/client';
import { pickBestMatch } from './matcher';
import { RateLimitedError } from './queue';
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
  ) {}

  async lookup(query: MediaQuery): Promise<LookupOutcome> {
    if (!query.title.trim()) return { status: 'not_found' };

    const key = cacheKey(query);
    const cached = await this.cache.get(key);
    if (cached) {
      return cached.rating ? { status: 'ok', rating: cached.rating } : { status: 'not_found' };
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.resolve(query, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async resolve(query: MediaQuery, key: string): Promise<LookupOutcome> {
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
        best = pickBestMatch(query, await this.client.suggest(term));
        if (best) break;
        try {
          best = pickBestMatch(query, await this.client.fullSearch(term));
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
          : await this.client.fetchRating(best.candidate.id);

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
