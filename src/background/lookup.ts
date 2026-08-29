import type { RatingCache } from './cache';
import type { InterestStore } from './interest';
import type { RatingProvider } from './provider';
import { RateLimitedError, type Priority } from './queue';
import type { LookupOutcome, MediaQuery } from '../shared/types';

/**
 * 把缓存、并发去重、点击优先级、取数四步串起来，对外只暴露一个 lookup。
 *
 * 这一层对「数据从哪来」是无知的 —— 具体的检索、匹配、取分由 RatingProvider
 * 负责（见 provider.ts）。豆瓣和 IMDb 各持有一个本类的实例，各自一份缓存、
 * 一条请求队列，互不牵连：豆瓣被限流时 IMDb 照常出分。
 *
 * 除了缓存，这里还做了「同一标题的并发去重」：Netflix 首页上同一部片子
 * 经常同时出现在好几个榜单里，一次滚动就会并发触发多次相同查询。没有这层
 * 去重的话，它们会各自排进请求队列，把限速额度白白耗光。
 */
export class RatingLookup {
  private readonly inFlight = new Map<string, Promise<LookupOutcome>>();

  constructor(
    private readonly provider: RatingProvider,
    private readonly cache: RatingCache,
    /** 用户点击过的影片记录。不传则所有查询一视同仁。 */
    private readonly interest: InterestStore | null = null,
  ) {}

  async lookup(query: MediaQuery): Promise<LookupOutcome> {
    if (!query.title.trim()) return { status: 'not_found' };

    const interestedAt = this.interest ? await this.interest.interestedAt(query) : null;
    const key = this.cache.keyFor(query);
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
      const rating = await this.provider.find(query, priority);
      if (!rating) {
        this.cache.set(key, null);
        return { status: 'not_found' };
      }
      this.cache.set(key, rating);
      return { status: 'ok', rating };
    } catch (error) {
      // 网络错误和限流都是暂时的，不写缓存，下次滚到这张卡片时再试。
      // 把它们记成「未收录」会让整页片子在接口恢复后依然空着 —— 这个项目
      // 为此排查过一整轮。
      if (error instanceof RateLimitedError) {
        return { status: 'error', reason: error.message, retryAfterMs: error.retryAfterMs };
      }
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
