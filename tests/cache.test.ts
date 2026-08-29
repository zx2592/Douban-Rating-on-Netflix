import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheKey,
  FOUND_TTL_MS,
  NOT_FOUND_TTL_MS,
  RatingCache,
  type StorageArea,
} from '../src/background/cache';
import type { DoubanRating, MediaQuery } from '../src/shared/types';

/** chrome.storage.local 的内存替身。 */
function memoryStorage(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      const result: Record<string, unknown> = {};
      for (const key of list) if (data.has(key)) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
}

const rating: DoubanRating = {
  id: '35131346',
  title: '河边的错误',
  score: 7.4,
  votes: 254321,
  year: 2023,
  type: 'movie',
  url: 'https://movie.douban.com/subject/35131346/',
  confidence: 100,
};

function query(partial: Partial<MediaQuery> & Pick<MediaQuery, 'title'>): MediaQuery {
  return { type: 'unknown', ...partial };
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('cacheKey', () => {
  it('归一化后等价的标题命中同一个键', () => {
    expect(cacheKey(query({ title: 'Stranger Things' }))).toBe(
      cacheKey(query({ title: 'STRANGER  THINGS!' })),
    );
  });

  it('季数不同则键不同', () => {
    expect(cacheKey(query({ title: '怪奇物语', season: 1 }))).not.toBe(
      cacheKey(query({ title: '怪奇物语', season: 2 }))
    );
  });

  it('标题里带季数后缀和显式传 season 得到同一个键', () => {
    expect(cacheKey(query({ title: '怪奇物语 第二季' }))).toBe(
      cacheKey(query({ title: '怪奇物语', season: 2 })),
    );
  });

  it('年份不同则键不同', () => {
    expect(cacheKey(query({ title: '狮子王', year: 1994 }))).not.toBe(
      cacheKey(query({ title: '狮子王', year: 2019 })),
    );
  });
});

describe('RatingCache 读写', () => {
  it('写入后能读出来', async () => {
    const storage = memoryStorage();
    const cache = new RatingCache(storage);
    cache.set('r:a', rating);
    expect((await cache.get('r:a'))?.rating).toEqual(rating);
  });

  it('未命中结果也会被缓存，避免反复打豆瓣', async () => {
    const storage = memoryStorage();
    const cache = new RatingCache(storage);
    cache.set('r:none', null);
    const entry = await cache.get('r:none');
    expect(entry).toBeDefined();
    expect(entry?.rating).toBeNull();
  });

  it('没写过的键返回 undefined', async () => {
    const cache = new RatingCache(memoryStorage());
    expect(await cache.get('r:missing')).toBeUndefined();
  });

  it('多次写入合并成一次落盘', async () => {
    const storage = memoryStorage();
    const setSpy = vi.spyOn(storage, 'set');
    const cache = new RatingCache(storage, () => Date.now(), 800);

    cache.set('r:a', rating);
    cache.set('r:b', rating);
    cache.set('r:c', null);
    expect(setSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(setSpy.mock.calls[0]![0])).toHaveLength(3);
  });

  it('service worker 重启后（内存丢失）仍能从存储里读回', async () => {
    const storage = memoryStorage();
    const first = new RatingCache(storage);
    first.set('r:a', rating);
    await first.flush();

    const restarted = new RatingCache(storage);
    expect((await restarted.get('r:a'))?.rating).toEqual(rating);
  });
});

describe('RatingCache 过期', () => {
  it('命中结果在 TTL 内有效、超出后失效', async () => {
    let time = 1_000_000;
    const storage = memoryStorage();
    const cache = new RatingCache(storage, () => time);

    cache.set('r:a', rating);
    await cache.flush();

    time += FOUND_TTL_MS - 1;
    expect(await cache.get('r:a')).toBeDefined();

    time += 2;
    expect(await cache.get('r:a')).toBeUndefined();
  });

  it('未命中结果的 TTL 明显更短', async () => {
    let time = 1_000_000;
    const storage = memoryStorage();
    const cache = new RatingCache(storage, () => time);

    cache.set('r:none', null);
    await cache.flush();

    time += NOT_FOUND_TTL_MS + 1;
    expect(await cache.get('r:none')).toBeUndefined();
    // 同样的时间跨度下，命中结果应该还活着。
    expect(NOT_FOUND_TTL_MS).toBeLessThan(FOUND_TTL_MS);
  });

  it('过期条目在读取时被顺手删掉', async () => {
    let time = 1_000_000;
    const storage = memoryStorage();
    const cache = new RatingCache(storage, () => time);
    cache.set('r:a', rating);
    await cache.flush();

    time += FOUND_TTL_MS + 1;
    await cache.get('r:a');
    expect(storage.data.has('r:a')).toBe(false);
  });
});

describe('RatingCache 清理', () => {
  it('clear 只删自己的键，不碰设置等其它数据', async () => {
    const storage = memoryStorage();
    storage.data.set('settings', { enabled: true });
    const cache = new RatingCache(storage);
    cache.set('r:a', rating);
    cache.set('r:b', rating);
    await cache.flush();

    expect(await cache.clear()).toBe(2);
    expect(storage.data.has('settings')).toBe(true);
    expect(await cache.get('r:a')).toBeUndefined();
  });

  it('size 只统计评分条目', async () => {
    const storage = memoryStorage();
    storage.data.set('settings', {});
    const cache = new RatingCache(storage);
    cache.set('r:a', rating);
    await cache.flush();
    expect(await cache.size()).toBe(1);
  });

  it('超出容量上限时丢掉最老的一批', async () => {
    let time = 1_000_000;
    const storage = memoryStorage();
    const cache = new RatingCache(storage, () => time);

    // 预置 4001 条历史记录，写入时间依次递增但都早于当前时刻，
    // 这样接下来 set 进去的那条才是最新的。
    for (let i = 0; i < 4001; i += 1) {
      storage.data.set(`r:${i}`, { at: time - 5000 + i, rating });
    }
    cache.set('r:new', rating);
    await cache.flush();

    const remaining = await cache.size();
    expect(remaining).toBeLessThan(4002);
    // 最老的那条应该首先被淘汰，最新写入的应该还在。
    expect(storage.data.has('r:0')).toBe(false);
    expect(storage.data.has('r:new')).toBe(true);
  });

  it('存储里的脏数据不会让读取崩掉', async () => {
    const storage = memoryStorage();
    storage.data.set('r:bad', 'not an entry');
    const cache = new RatingCache(storage);
    expect(await cache.get('r:bad')).toBeUndefined();
  });
});
