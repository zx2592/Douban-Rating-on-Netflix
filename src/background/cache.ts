import { normalizeTitle, splitSeason } from '../shared/text';
import type { DoubanRating, MediaQuery } from '../shared/types';

/**
 * 评分缓存。
 *
 * 这是把豆瓣请求量压下来的主力：同一部片子在 Netflix 首页会反复出现在多个
 * 榜单里，用户来回滚动更会重复触发。缓存写在 chrome.storage.local，
 * service worker 被回收重启后依然有效。
 *
 * 「查不到」也缓存，只是 TTL 短得多 —— 否则每次滚过那张卡片都要再打一次豆瓣。
 */

/** 命中结果的有效期。评分变化很慢，一周足够。 */
export const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 未命中结果的有效期。豆瓣可能过几天就收录了，所以短一些。 */
export const NOT_FOUND_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 缓存键前缀，末尾数字是缓存格式版本。
 *
 * 检索接口或匹配逻辑发生实质变化时必须递增：接口失效期间写进缓存的
 * 「未收录」会存活 12 小时，接口修好后用户看到的还是旧的空结果。第一次
 * 换接口时靠"请用户手动清缓存"来解决，用户没清，白白多排查了一轮 ——
 * 失效必须自动发生，不能依赖人工操作。旧版本的键由 sweepLegacyEntries
 * 在启动时清除。
 */
const KEY_PREFIX = 'r3:';
const LEGACY_KEY_PATTERN = /^r\d*:/;
const MAX_ENTRIES = 4000;
/** 超出上限时一次清掉这么多比例的老条目，避免每写一条都要清理一次。 */
const PRUNE_RATIO = 0.25;

export interface CacheEntry {
  /** 写入时间戳。 */
  at: number;
  /** null 表示「查过，但豆瓣没有可信的匹配」。 */
  rating: DoubanRating | null;
}

/** chrome.storage.local 的最小接口，抽出来是为了单测里能换成内存实现。 */
export interface StorageArea {
  get(keys: string[] | string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/**
 * 缓存键。用归一化标题而不是原始标题，这样 "STRANGER THINGS" 和
 * "Stranger Things" 命中同一条缓存。
 */
export function cacheKey(query: MediaQuery): string {
  const split = splitSeason(query.title);
  const season = query.season ?? split.season ?? '';
  return `${KEY_PREFIX}${normalizeTitle(split.base)}|${season}|${query.year ?? ''}|${query.type}`;
}

function isExpired(entry: CacheEntry, now: number): boolean {
  const ttl = entry.rating === null ? NOT_FOUND_TTL_MS : FOUND_TTL_MS;
  return now - entry.at > ttl;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['at'] === 'number' && 'rating' in record;
}

export class RatingCache {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly pendingWrites = new Map<string, CacheEntry>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: StorageArea,
    private readonly now: () => number = () => Date.now(),
    /** 写入合并窗口。快速滚动时几十次写会被合并成一次 storage 调用。 */
    private readonly flushDelayMs = 800,
  ) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    const cached = this.memory.get(key) ?? this.pendingWrites.get(key);
    if (cached) {
      if (!isExpired(cached, this.now())) return cached;
      // 内存里的副本过期了，落盘的那份必然也过期，一并清掉。
      // 只删内存不删存储的话，这条记录要等到下一次 prune 才会消失。
      this.memory.delete(key);
      this.pendingWrites.delete(key);
      await this.storage.remove([key]);
      return undefined;
    }

    const stored = (await this.storage.get([key]))[key];
    if (!isCacheEntry(stored)) return undefined;
    if (isExpired(stored, this.now())) {
      await this.storage.remove([key]);
      return undefined;
    }
    this.memory.set(key, stored);
    return stored;
  }

  set(key: string, rating: DoubanRating | null): void {
    const entry: CacheEntry = { at: this.now(), rating };
    this.memory.set(key, entry);
    this.pendingWrites.set(key, entry);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  /** 把待写入的条目落盘。正常情况下由定时器触发，单测里可以直接调。 */
  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    const batch = Object.fromEntries(this.pendingWrites);
    this.pendingWrites.clear();
    await this.storage.set(batch);
    await this.pruneIfNeeded();
  }

  /** 当前落盘的条目数，供设置页展示。 */
  async size(): Promise<number> {
    const all = await this.storage.get(null);
    return Object.keys(all).filter((key) => key.startsWith(KEY_PREFIX)).length;
  }

  async clear(): Promise<number> {
    this.memory.clear();
    this.pendingWrites.clear();
    const all = await this.storage.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(KEY_PREFIX));
    if (keys.length > 0) await this.storage.remove(keys);
    return keys.length;
  }

  /**
   * 超出上限时，按写入时间丢掉最老的一批。
   * 顺带把已经过期的条目一并清掉。
   */
  private async pruneIfNeeded(): Promise<void> {
    const all = await this.storage.get(null);
    const entries: Array<[string, CacheEntry]> = [];
    const expired: string[] = [];
    const now = this.now();

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      if (!isCacheEntry(value)) {
        expired.push(key);
        continue;
      }
      if (isExpired(value, now)) expired.push(key);
      else entries.push([key, value]);
    }

    const doomed = [...expired];
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => a[1].at - b[1].at);
      const removeCount = Math.ceil(entries.length * PRUNE_RATIO);
      for (const [key] of entries.slice(0, removeCount)) doomed.push(key);
    }

    if (doomed.length === 0) return;
    for (const key of doomed) this.memory.delete(key);
    await this.storage.remove(doomed);
  }
}

/** 启动时清掉旧版本缓存键，返回清除数量。 */
export async function sweepLegacyEntries(storage: StorageArea): Promise<number> {
  const all = await storage.get(null);
  const doomed = Object.keys(all).filter(
    (key) => LEGACY_KEY_PATTERN.test(key) && !key.startsWith(KEY_PREFIX),
  );
  if (doomed.length > 0) await storage.remove(doomed);
  return doomed.length;
}

/** 包一层 chrome.storage.local，使其符合 StorageArea。 */
export function chromeLocalStorage(): StorageArea {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}
