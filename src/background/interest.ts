import type { StorageArea } from './cache';
import { normalizeTitle, splitSeason } from '../shared/text';
import type { MediaQuery } from '../shared/types';

/**
 * 「用户感兴趣的影片」记录。
 *
 * 点击卡片是最强的兴趣信号 —— 用户主动想了解这部片。而在此之前，扩展对
 * 「主动点开的片」和「随手划过的片」一视同仁：都排同一个队、都按同样的
 * TTL 缓存「未收录」。在匿名配额本就很紧的前提下，这是一处明显的错配。
 *
 * 记下兴趣之后有两个效果（见 lookup.ts）：
 * 1. 该片的查询排进高优先级，插队到普通请求前面；
 * 2. 若它此前被缓存成「未收录」，且那条缓存是在表达兴趣之前写下的，
 *    就重新查一次 —— 未收录很可能只是当时被限流了。
 */

const KEY = 'interest';
/** 记录上限。超出后按时间丢掉最老的。 */
const MAX_ENTRIES = 200;
/**
 * 同一部片的兴趣时间戳在这个窗口内不刷新。
 *
 * 时间戳一刷新就会再触发一次「重查」，连点几下就是几次请求。加个冷却，
 * 让「点击 → 重查一次」这件事对同一部片在半小时内只发生一次。
 */
const REFRESH_COOLDOWN_MS = 30 * 60_000;

/**
 * 兴趣的键只用「归一化标题 + 季数」，刻意不含年份和类型。
 *
 * 列表卡片上拿不到年份（type 也是 unknown），详情弹层却两者都有 —— 用
 * cacheKey 的话，同一部片从卡片点进去和从弹层查询会落在不同的键上，兴趣
 * 就对不上了。
 */
export function interestKey(query: MediaQuery): string {
  const split = splitSeason(query.title);
  const base = normalizeTitle(split.base);
  // 标题为空时返回空串而不是 "|季数"：后者是个真键，会把所有取不到标题的
  // 卡片记成同一部片，调用方的 `if (!key)` 也拦不住。
  if (!base) return '';
  const season = query.season ?? split.season ?? '';
  return `${base}|${season}`;
}

type InterestMap = Record<string, number>;

function isInterestMap(value: unknown): value is InterestMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class InterestStore {
  constructor(
    private readonly storage: StorageArea,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async load(): Promise<InterestMap> {
    const stored = (await this.storage.get([KEY]))[KEY];
    if (!isInterestMap(stored)) return {};
    // 只保留数值项，脏数据直接忽略。
    const clean: InterestMap = {};
    for (const [key, at] of Object.entries(stored)) {
      if (typeof at === 'number' && Number.isFinite(at)) clean[key] = at;
    }
    return clean;
  }

  /**
   * 记下一次兴趣。返回时间戳是否被更新 —— 只有更新了才值得触发重查。
   */
  async mark(query: MediaQuery): Promise<boolean> {
    const key = interestKey(query);
    if (!key) return false;

    const map = await this.load();
    const previous = map[key];
    const now = this.now();
    if (previous !== undefined && now - previous < REFRESH_COOLDOWN_MS) return false;

    map[key] = now;
    await this.storage.set({ [KEY]: prune(map, MAX_ENTRIES) });
    return true;
  }

  /** 表达兴趣的时刻；没记录过则为 null。 */
  async interestedAt(query: MediaQuery): Promise<number | null> {
    const key = interestKey(query);
    if (!key) return null;
    return (await this.load())[key] ?? null;
  }

  /** 记录条数，供设置页展示。 */
  async size(): Promise<number> {
    return Object.keys(await this.load()).length;
  }

  async clear(): Promise<void> {
    await this.storage.remove([KEY]);
  }
}

/** 超出上限时按时间丢掉最老的记录。 */
function prune(map: InterestMap, limit: number): InterestMap {
  const entries = Object.entries(map);
  if (entries.length <= limit) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, limit));
}
