import type { ImdbClient } from './client';
import { pickBestMatch } from '../matcher';
import type { RatingProvider } from '../provider';
import type { Priority } from '../queue';
import { buildSearchTerms } from '../search-terms';
import type { MediaQuery, Rating } from '../../shared/types';

/**
 * IMDb 来源：下拉建议检索 + 匹配 + 取分。
 *
 * 比豆瓣那边简单一级 —— 只有一类检索入口（虽然客户端内部会在几个域名之间
 * 降级），因为 IMDb 的建议接口本身召回就够宽，英文原名是它的母语。
 */
export class ImdbProvider implements RatingProvider {
  readonly source = 'imdb' as const;

  constructor(private readonly client: ImdbClient) {}

  async find(query: MediaQuery, priority: Priority): Promise<Rating | null> {
    let best = null;
    for (const term of buildSearchTerms(query.title)) {
      best = pickBestMatch(query, await this.client.search(term, priority));
      if (best) break;
    }
    if (!best) return null;

    // 建议接口不带评分，命中后必然要再取一次。
    const detail = await this.client.fetchRating(best.candidate.id, priority);

    return {
      source: this.source,
      id: best.candidate.id,
      title: best.candidate.title,
      score: detail.score,
      votes: detail.votes,
      ...(best.candidate.year !== undefined ? { year: best.candidate.year } : {}),
      type: best.candidate.type,
      url: best.candidate.url,
      confidence: best.confidence,
    };
  }
}
