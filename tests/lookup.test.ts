import { describe, expect, it, vi } from 'vitest';
import { RatingCache, type StorageArea } from '../src/background/cache';
import type { DoubanClient } from '../src/background/douban/client';
import type { RatingDetail } from '../src/background/douban/parse';
import { RatingLookup } from '../src/background/lookup';
import type { Candidate } from '../src/background/matcher';
import { RateLimitedError } from '../src/background/queue';
import type { MediaQuery } from '../src/shared/types';

function memoryStorage(): StorageArea {
  const data = new Map<string, unknown>();
  return {
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

interface FakeClientOptions {
  candidates?: Candidate[];
  detail?: RatingDetail | null;
  searchError?: Error;
  ratingError?: Error;
}

function fakeClient(options: FakeClientOptions = {}) {
  const search = vi.fn(async (_term: string): Promise<Candidate[]> => {
    if (options.searchError) throw options.searchError;
    return options.candidates ?? [];
  });
  const fetchRating = vi.fn(async (_id: string): Promise<RatingDetail | null> => {
    if (options.ratingError) throw options.ratingError;
    return options.detail ?? { score: 7.4, votes: 1000 };
  });
  return { search, fetchRating } as unknown as DoubanClient & {
    search: typeof search;
    fetchRating: typeof fetchRating;
  };
}

const matchingCandidate: Candidate = {
  id: '35131346',
  title: '河边的错误',
  year: 2023,
  type: 'movie',
  score: null,
  votes: null,
  url: 'https://movie.douban.com/subject/35131346/',
};

function makeLookup(options: FakeClientOptions = {}) {
  const client = fakeClient(options);
  const cache = new RatingCache(memoryStorage());
  return { lookup: new RatingLookup(cache, client), client, cache };
}

const query: MediaQuery = { title: '河边的错误', year: 2023, type: 'movie' };

describe('RatingLookup 正常路径', () => {
  it('检索 → 匹配 → 取分，返回完整评分', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    const outcome = await lookup.lookup(query);

    expect(outcome).toMatchObject({
      status: 'ok',
      rating: { id: '35131346', title: '河边的错误', score: 7.4, votes: 1000 },
    });
    expect(client.search).toHaveBeenCalledWith('河边的错误');
    expect(client.fetchRating).toHaveBeenCalledWith('35131346');
  });

  it('搜索时用去掉季数后缀的主标题', async () => {
    const { lookup, client } = makeLookup({ candidates: [] });
    await lookup.lookup({ title: '怪奇物语 第四季', type: 'tv' });
    expect(client.search).toHaveBeenCalledWith('怪奇物语');
  });

  it('豆瓣尚未出分时返回 ok 且 score 为 null', async () => {
    const { lookup } = makeLookup({
      candidates: [matchingCandidate],
      detail: { score: null, votes: null },
    });
    const outcome = await lookup.lookup(query);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.rating.score).toBeNull();
  });
});

describe('RatingLookup 缓存', () => {
  it('第二次查询直接命中缓存，不再请求豆瓣', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    await lookup.lookup(query);
    await lookup.lookup(query);
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('未命中的结果也进缓存，不会反复去打豆瓣', async () => {
    const { lookup, client } = makeLookup({ candidates: [] });
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('并发的相同查询只发一次请求', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    // 首页上同一部片子同时出现在多个榜单里，就是这个场景。
    const outcomes = await Promise.all([lookup.lookup(query), lookup.lookup(query), lookup.lookup(query)]);
    expect(client.search).toHaveBeenCalledTimes(1);
    for (const outcome of outcomes) expect(outcome.status).toBe('ok');
  });
});

describe('RatingLookup 未匹配', () => {
  it('豆瓣没有返回任何候选时是 not_found', async () => {
    const { lookup } = makeLookup({ candidates: [] });
    expect((await lookup.lookup(query)).status).toBe('not_found');
  });

  it('有候选但都不够可信时也是 not_found，且不去取评分', async () => {
    const { lookup, client } = makeLookup({
      candidates: [{ ...matchingCandidate, title: '完全不相干的另一部片', year: 1999 }],
    });
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect(client.fetchRating).not.toHaveBeenCalled();
  });

  it('空标题直接返回 not_found，不打扰豆瓣', async () => {
    const { lookup, client } = makeLookup();
    expect((await lookup.lookup({ title: '   ', type: 'unknown' })).status).toBe('not_found');
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe('RatingLookup 错误处理', () => {
  it('被限流时返回 error 并带上建议的重试间隔', async () => {
    const { lookup } = makeLookup({ searchError: new RateLimitedError(30_000) });
    const outcome = await lookup.lookup(query);
    expect(outcome).toMatchObject({ status: 'error', retryAfterMs: 30_000 });
  });

  it('错误结果绝不写入缓存，下次还会重试', async () => {
    // 把网络故障当成"查不到"缓存起来，会让用户在恢复后仍看不到评分。
    const client = fakeClient({ searchError: new Error('网络中断') });
    const lookup = new RatingLookup(new RatingCache(memoryStorage()), client);

    expect((await lookup.lookup(query)).status).toBe('error');
    expect((await lookup.lookup(query)).status).toBe('error');
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it('取评分那一步失败时返回 error，而不是谎报 not_found', async () => {
    const { lookup } = makeLookup({
      candidates: [matchingCandidate],
      ratingError: new Error('豆瓣请求超时'),
    });
    const outcome = await lookup.lookup(query);
    expect(outcome).toMatchObject({ status: 'error', reason: '豆瓣请求超时' });
  });

  it('并发查询失败后，去重表要清干净，不能卡住后续查询', async () => {
    const client = fakeClient({ searchError: new Error('网络中断') });
    const lookup = new RatingLookup(new RatingCache(memoryStorage()), client);

    await Promise.all([lookup.lookup(query), lookup.lookup(query)]);
    // 失败的 promise 若留在 inFlight 里，这一次会拿到上一次的失败结果。
    const client2 = client as unknown as { search: ReturnType<typeof vi.fn> };
    client2.search.mockResolvedValueOnce([matchingCandidate]);
    expect((await lookup.lookup(query)).status).toBe('ok');
  });
});
