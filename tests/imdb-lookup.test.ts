import { describe, expect, it, vi } from 'vitest';
import { CACHE_PREFIXES, RatingCache, type StorageArea } from '../src/background/cache';
import type { ImdbClient } from '../src/background/imdb/client';
import { ImdbProvider } from '../src/background/imdb/provider';
import { RatingLookup } from '../src/background/lookup';
import type { Candidate } from '../src/background/matcher';
import { RateLimitedError } from '../src/background/queue';
import type { MediaQuery } from '../src/shared/types';

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

const CANDIDATE: Candidate = {
  id: 'tt0903747',
  title: 'Breaking Bad',
  year: 2008,
  type: 'tv',
  score: null,
  votes: null,
  url: 'https://www.imdb.com/title/tt0903747/',
};

function fakeClient(options: { candidates?: Candidate[]; searchError?: Error; ratingError?: Error } = {}) {
  const search = vi.fn(async (): Promise<Candidate[]> => {
    if (options.searchError) throw options.searchError;
    return options.candidates ?? [CANDIDATE];
  });
  const fetchRating = vi.fn(async () => {
    if (options.ratingError) throw options.ratingError;
    return { score: 9.5, votes: 2_200_000 };
  });
  return { search, fetchRating } as unknown as ImdbClient & {
    search: typeof search;
    fetchRating: typeof fetchRating;
  };
}

function makeLookup(options: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient(options);
  const storage = memoryStorage();
  const cache = new RatingCache(storage, undefined, undefined, CACHE_PREFIXES.imdb);
  return { lookup: new RatingLookup(new ImdbProvider(client), cache), client, cache, storage };
}

const query: MediaQuery = { title: 'Breaking Bad', year: 2008, type: 'tv' };

describe('IMDb 查询链路', () => {
  it('检索 → 匹配 → 取分，结果标着 imdb 来源', async () => {
    const { lookup } = makeLookup();
    const outcome = await lookup.lookup(query);

    expect(outcome).toMatchObject({
      status: 'ok',
      rating: {
        source: 'imdb',
        id: 'tt0903747',
        score: 9.5,
        votes: 2_200_000,
        url: 'https://www.imdb.com/title/tt0903747/',
      },
    });
  });

  it('匹配不上时记为未收录，不去取分', async () => {
    const { lookup, client } = makeLookup({
      candidates: [{ ...CANDIDATE, id: 'tt111', title: '毫不相干的片子', year: 1999 }],
    });

    expect(await lookup.lookup(query)).toEqual({ status: 'not_found' });
    expect(client.fetchRating).not.toHaveBeenCalled();
  });

  it('取分失败按暂时性错误处理，绝不写进缓存', async () => {
    // 这是这个项目栽过的那个跟头：把「暂时拿不到」缓存成「没有」，
    // 接口恢复后用户看到的还是空的。IMDb 这边不能重蹈覆辙。
    const { lookup, client, cache } = makeLookup({ ratingError: new Error('IMDb 请求超时') });

    expect(await lookup.lookup(query)).toMatchObject({ status: 'error' });
    await cache.flush();

    client.fetchRating.mockResolvedValue({ score: 9.5, votes: 100 });
    expect(await lookup.lookup(query)).toMatchObject({ status: 'ok' });
  });

  it('限流带上建议重试时间', async () => {
    const { lookup } = makeLookup({ searchError: new RateLimitedError(30_000) });
    expect(await lookup.lookup(query)).toMatchObject({ status: 'error', retryAfterMs: 30_000 });
  });

  it('同一部片的并发查询只发一次请求', async () => {
    const { lookup, client } = makeLookup();
    await Promise.all([lookup.lookup(query), lookup.lookup(query), lookup.lookup(query)]);
    expect(client.search).toHaveBeenCalledTimes(1);
  });
});

describe('两个来源的缓存互不干扰', () => {
  it('IMDb 用自己的键前缀', async () => {
    const { lookup, cache, storage } = makeLookup();
    await lookup.lookup(query);
    await cache.flush();

    const keys = [...storage.data.keys()];
    expect(keys.every((key) => key.startsWith(CACHE_PREFIXES.imdb))).toBe(true);
    expect(CACHE_PREFIXES.imdb).not.toBe(CACHE_PREFIXES.douban);
  });

  it('清空一个来源的缓存不会动到另一个', async () => {
    // 同一个 chrome.storage.local 里放着两套缓存，前缀过滤要是写错了，
    // 清豆瓣会顺手把 IMDb 的一起清掉 —— 表现是"清了一次缓存后 IMDb 也没了"。
    const storage = memoryStorage();
    const douban = new RatingCache(storage, undefined, undefined, CACHE_PREFIXES.douban);
    const imdb = new RatingCache(storage, undefined, undefined, CACHE_PREFIXES.imdb);

    douban.set(douban.keyFor(query), null);
    imdb.set(imdb.keyFor(query), null);
    await douban.flush();
    await imdb.flush();
    expect(await imdb.size()).toBe(1);

    expect(await douban.clear()).toBe(1);
    expect(await imdb.size()).toBe(1);
  });
});
