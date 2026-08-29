import type { DoubanClient } from './client';
import { pickBestMatch } from '../matcher';
import type { RatingProvider } from '../provider';
import { RateLimitedError, type Priority } from '../queue';
import { buildSearchTerms } from '../search-terms';
import type { MediaQuery, Rating } from '../../shared/types';

/** 豆瓣来源：两级检索（suggest 为主、完整搜索兜底）+ 匹配 + 取分。 */
export class DoubanProvider implements RatingProvider {
  readonly source = 'douban' as const;

  constructor(private readonly client: DoubanClient) {}

  async find(query: MediaQuery, priority: Priority): Promise<Rating | null> {
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
      // 完整搜索限流或静默期中会抛 RateLimitedError：suggest 已经没找到，
      // 此时不能断定"豆瓣没这部片"，让它抛到上层按暂时性错误处理，
      // 绝不能落成 null 被写进缓存。
      best = pickBestMatch(query, await this.client.fullSearch(term, priority));
      if (best) break;
    }
    if (!best) return null;

    // 搜索结果里通常已经带着评分，此时不必再单独请求一次 —— 请求数减半，
    // 出分速度直接翻倍，对限流也更友好。只有搜索结果没给分时才回退。
    const detail =
      best.candidate.score !== null
        ? { score: best.candidate.score, votes: best.candidate.votes }
        : await this.client.fetchRating(best.candidate.id, priority);

    return {
      source: this.source,
      id: best.candidate.id,
      title: best.candidate.title,
      score: detail.score,
      votes: detail.votes ?? best.candidate.votes,
      ...(best.candidate.year !== undefined ? { year: best.candidate.year } : {}),
      type: best.candidate.type,
      url: best.candidate.url,
      confidence: best.confidence,
    };
  }
}

/** 重新导出，方便上层只从 provider 模块引这一个错误类型。 */
export { RateLimitedError };
