import { describe, expect, it, vi } from 'vitest';
import { RatingCache, type StorageArea } from '../src/background/cache';
import type { DoubanClient } from '../src/background/douban/client';
import type { RatingDetail } from '../src/background/douban/parse';
import { InterestStore } from '../src/background/interest';
import { DoubanProvider } from '../src/background/douban/provider';
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
  /** suggest（主检索）返回的候选。 */
  candidates?: Candidate[];
  /** fullSearch（兜底检索）返回的候选，默认为空。 */
  fullSearchCandidates?: Candidate[];
  detail?: RatingDetail | null;
  searchError?: Error;
  fullSearchError?: Error;
  ratingError?: Error;
}

function fakeClient(options: FakeClientOptions = {}) {
  const suggest = vi.fn(async (_term: string): Promise<Candidate[]> => {
    if (options.searchError) throw options.searchError;
    return options.candidates ?? [];
  });
  const fullSearch = vi.fn(async (_term: string): Promise<Candidate[]> => {
    if (options.fullSearchError) throw options.fullSearchError;
    return options.fullSearchCandidates ?? [];
  });
  const fetchRating = vi.fn(async (_id: string): Promise<RatingDetail | null> => {
    if (options.ratingError) throw options.ratingError;
    return options.detail ?? { score: 7.4, votes: 1000 };
  });
  return { suggest, fullSearch, fetchRating } as unknown as DoubanClient & {
    suggest: typeof suggest;
    fullSearch: typeof fullSearch;
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
  return { lookup: new RatingLookup(new DoubanProvider(client), cache), client, cache };
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
    expect(client.suggest).toHaveBeenCalledWith('河边的错误', 'normal');
    expect(client.fetchRating).toHaveBeenCalledWith('35131346', 'normal');
  });

  it('搜索时用去掉季数后缀的主标题', async () => {
    const { lookup, client } = makeLookup({ candidates: [] });
    await lookup.lookup({ title: '怪奇物语 第四季', type: 'tv' });
    expect(client.suggest).toHaveBeenCalledWith('怪奇物语', 'normal');
  });

  it('Netflix 界面为英文时，靠豆瓣的英文原名匹配上中文条目', async () => {
    // 这是把 Netflix 语言设成英文后的主路径：查询词是英文，豆瓣条目主标题
    // 是中文译名，两者靠 sub_title（原名）对上。
    const { lookup, client } = makeLookup({
      candidates: [
        {
          id: '1291841',
          title: '星河战队',
          originalTitle: 'Starship Troopers',
          year: 1997,
          type: 'movie',
          score: null,
          votes: null,
          url: 'https://movie.douban.com/subject/1291841/',
        },
      ],
    });

    const outcome = await lookup.lookup({ title: 'Starship Troopers', year: 1997, type: 'unknown' });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.rating.title).toBe('星河战队');
    // 英文查询只发一次检索请求，不需要再试别的写法。
    expect(client.suggest).toHaveBeenCalledTimes(1);
    expect(client.suggest).toHaveBeenCalledWith('Starship Troopers', 'normal');
  });

  it('繁体片名先用简体去搜', async () => {
    const { lookup, client } = makeLookup({
      candidates: [
        {
          id: '35088562',
          title: '鱿鱼游戏',
          year: 2021,
          type: 'tv',
          score: null,
          votes: null,
          url: 'https://movie.douban.com/subject/35088562/',
        },
      ],
    });

    const outcome = await lookup.lookup({ title: '魷魚遊戲', year: 2021, type: 'tv' });
    expect(outcome.status).toBe('ok');
    expect(client.suggest).toHaveBeenCalledWith('鱿鱼游戏', 'normal');
  });

  it('第一个检索词没命中时会换下一个再试', async () => {
    const client = fakeClient();
    (client.suggest as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: '1',
          title: '魷魚遊戲',
          year: 2021,
          type: 'tv',
          score: null,
          votes: null,
          url: 'https://movie.douban.com/subject/1/',
        },
      ]);
    const lookup = new RatingLookup(new DoubanProvider(client), new RatingCache(memoryStorage()));

    const outcome = await lookup.lookup({ title: '魷魚遊戲', year: 2021, type: 'tv' });
    expect(outcome.status).toBe('ok');
    expect(client.suggest).toHaveBeenCalledTimes(2);
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

describe('RatingLookup 三种输入都要能命中同一部片', () => {
  /** 线上搜索结果的形状：中英合并的标题、abstract 里带港台译名、评分内联。 */
  const starship: Candidate = {
    id: '1293544',
    title: '星河战队',
    originalTitle: 'Starship Troopers',
    aliases: ['星舰战将', '太空战士'],
    year: 1997,
    type: 'movie',
    score: 7.9,
    votes: 172000,
    url: 'https://movie.douban.com/subject/1293544/',
  };

  it.each([
    ['英文原名（英文界面）', 'Starship Troopers'],
    ['简体大陆译名', '星河战队'],
    ['繁体台湾译名', '星艦戰將'],
  ])('%s → 命中同一条目', async (_label, title) => {
    // 列表卡片上拿不到年份，走的是收紧后的阈值，能过说明匹配是干净的。
    const { lookup } = makeLookup({ candidates: [starship] });
    const outcome = await lookup.lookup({ title, type: 'unknown' });

    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.rating.id).toBe('1293544');
      expect(outcome.rating.score).toBe(7.9);
    }
  });

  it('搜索结果自带评分时不再单独取一次分', async () => {
    // 请求数减半，出分速度直接翻倍，对限流也更友好。
    const { lookup, client } = makeLookup({ candidates: [starship] });
    await lookup.lookup({ title: 'Starship Troopers', type: 'unknown' });

    expect(client.suggest).toHaveBeenCalledTimes(1);
    expect(client.fetchRating).not.toHaveBeenCalled();
  });

  it('搜索结果没给分时才回退到单独取分', async () => {
    const { lookup, client } = makeLookup({
      candidates: [{ ...starship, score: null }],
      detail: { score: 7.9, votes: null },
    });
    const outcome = await lookup.lookup({ title: 'Starship Troopers', type: 'unknown' });

    expect(client.fetchRating).toHaveBeenCalledWith('1293544', 'normal');
    if (outcome.status === 'ok') expect(outcome.rating.score).toBe(7.9);
  });

  it('评价人数会一并带出来', async () => {
    // 换到完整搜索之后重新拿得到评价人数，tooltip 里能显示了。
    const { lookup } = makeLookup({ candidates: [starship] });
    const outcome = await lookup.lookup({ title: 'Starship Troopers', type: 'unknown' });
    if (outcome.status === 'ok') expect(outcome.rating.votes).toBe(172000);
  });
});

describe('两级检索', () => {
  it('suggest 没有可信匹配时，用完整搜索兜底', async () => {
    // suggest 被限流时的表现是返回空数组，和"真没有"无法区分，必须兜底。
    const { lookup, client } = makeLookup({
      candidates: [],
      fullSearchCandidates: [matchingCandidate],
    });

    const outcome = await lookup.lookup(query);
    expect(outcome.status).toBe('ok');
    expect(client.fullSearch).toHaveBeenCalled();
  });

  it('suggest 直接命中时不动完整搜索（它限流严，能省则省）', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    await lookup.lookup(query);
    expect(client.fullSearch).not.toHaveBeenCalled();
  });

  it('suggest 未中且完整搜索被软限流时，返回 error 且绝不写缓存', async () => {
    // 这是「全部显示未收录」事故的根源：搜索被限流曾被当成"豆瓣没这部片"
    // 缓存 12 小时。suggest 没找到 + 搜索被限，此时什么结论都下不了。
    const client = fakeClient({
      candidates: [],
      fullSearchError: new RateLimitedError(300_000),
    });
    const lookup = new RatingLookup(new DoubanProvider(client), new RatingCache(memoryStorage()));

    const first = await lookup.lookup(query);
    expect(first).toMatchObject({ status: 'error', retryAfterMs: 300_000 });

    // 第二次查询必须重新发请求 —— 证明上一次没有被缓存成 not_found。
    (client.fullSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([matchingCandidate]);
    expect((await lookup.lookup(query)).status).toBe('ok');
  });

  it('两级都真的没有结果时才是 not_found', async () => {
    const { lookup, client } = makeLookup({ candidates: [], fullSearchCandidates: [] });
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect(client.suggest).toHaveBeenCalled();
    expect(client.fullSearch).toHaveBeenCalled();
  });
});

describe('RatingLookup 缓存', () => {
  it('第二次查询直接命中缓存，不再请求豆瓣', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    await lookup.lookup(query);
    await lookup.lookup(query);
    expect(client.suggest).toHaveBeenCalledTimes(1);
  });

  it('未命中的结果也进缓存，不会反复去打豆瓣', async () => {
    const { lookup, client } = makeLookup({ candidates: [] });
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect((await lookup.lookup(query)).status).toBe('not_found');
    expect(client.suggest).toHaveBeenCalledTimes(1);
  });

  it('并发的相同查询只发一次请求', async () => {
    const { lookup, client } = makeLookup({ candidates: [matchingCandidate] });
    // 首页上同一部片子同时出现在多个榜单里，就是这个场景。
    const outcomes = await Promise.all([lookup.lookup(query), lookup.lookup(query), lookup.lookup(query)]);
    expect(client.suggest).toHaveBeenCalledTimes(1);
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
    expect(client.suggest).not.toHaveBeenCalled();
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
    const lookup = new RatingLookup(new DoubanProvider(client), new RatingCache(memoryStorage()));

    expect((await lookup.lookup(query)).status).toBe('error');
    expect((await lookup.lookup(query)).status).toBe('error');
    expect(client.suggest).toHaveBeenCalledTimes(2);
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
    const lookup = new RatingLookup(new DoubanProvider(client), new RatingCache(memoryStorage()));

    await Promise.all([lookup.lookup(query), lookup.lookup(query)]);
    // 失败的 promise 若留在 inFlight 里，这一次会拿到上一次的失败结果。
    const client2 = client as unknown as { suggest: ReturnType<typeof vi.fn> };
    client2.suggest.mockResolvedValueOnce([matchingCandidate]);
    expect((await lookup.lookup(query)).status).toBe('ok');
  });
});

describe('RatingLookup 与「感兴趣」记录', () => {
  /** 组装一套带兴趣记录的 lookup，时钟可控。 */
  function makeInterestedLookup(options: FakeClientOptions = {}) {
    let time = 1_000_000;
    const now = () => time;
    const storage = memoryStorage();
    const client = fakeClient(options);
    const cache = new RatingCache(storage, now);
    const interest = new InterestStore(storage, now);
    return {
      lookup: new RatingLookup(new DoubanProvider(client), cache, interest),
      client,
      cache,
      interest,
      advance: (ms: number) => (time += ms),
      now,
    };
  }

  it('点击过的影片，查询按高优先级下发', async () => {
    const { lookup, client, interest } = makeInterestedLookup({ candidates: [matchingCandidate] });
    await interest.mark(query);

    await lookup.lookup(query);

    expect(client.suggest).toHaveBeenCalledWith(expect.any(String), 'high');
  });

  it('没点击过的影片仍是普通优先级', async () => {
    const { lookup, client } = makeInterestedLookup({ candidates: [matchingCandidate] });

    await lookup.lookup(query);

    expect(client.suggest).toHaveBeenCalledWith(expect.any(String), 'normal');
  });

  it('点击之前记下的「未收录」会被重查一次', async () => {
    // 「未收录」有相当一部分其实是当时被限流的结果。用户既然点开了这部片，
    // 就值得再花一次配额确认，而不是让它在缓存里躺满 12 小时。
    const { lookup, client, cache, interest, advance } = makeInterestedLookup();
    expect(await lookup.lookup(query)).toEqual({ status: 'not_found' });
    await cache.flush();
    expect(client.suggest).toHaveBeenCalledTimes(1);

    // 缓存生效：不点击的话不会再查。
    await lookup.lookup(query);
    expect(client.suggest).toHaveBeenCalledTimes(1);

    advance(60_000);
    await interest.mark(query);
    client.suggest.mockResolvedValue([matchingCandidate]);

    expect(await lookup.lookup(query)).toMatchObject({ status: 'ok' });
    expect(client.suggest).toHaveBeenCalledTimes(2);
  });

  it('重查后仍未收录的，不会每次都再查一遍', async () => {
    // 重查会以当前时间重写缓存，at 追上兴趣时间戳，绕过自动失效。
    // 少了这一条，点过一次的冷门片会在之后每张卡片上反复消耗配额。
    const { lookup, client, cache, interest, advance } = makeInterestedLookup();
    await lookup.lookup(query);
    await cache.flush();

    advance(60_000);
    await interest.mark(query);
    await lookup.lookup(query);
    await cache.flush();
    expect(client.suggest).toHaveBeenCalledTimes(2);

    advance(60_000);
    expect(await lookup.lookup(query)).toEqual({ status: 'not_found' });
    expect(client.suggest).toHaveBeenCalledTimes(2);
  });

  it('已有评分的缓存不会因为点击而重查', async () => {
    const { lookup, client, cache, interest, advance } = makeInterestedLookup({
      candidates: [matchingCandidate],
    });
    await lookup.lookup(query);
    await cache.flush();

    advance(60_000);
    await interest.mark(query);

    expect(await lookup.lookup(query)).toMatchObject({ status: 'ok' });
    expect(client.suggest).toHaveBeenCalledTimes(1);
  });

  it('重查撞上限流时不写缓存，下次还能再试', async () => {
    const { lookup, client, cache, interest, advance } = makeInterestedLookup();
    await lookup.lookup(query);
    await cache.flush();

    advance(60_000);
    await interest.mark(query);
    client.fullSearch.mockRejectedValue(new RateLimitedError(30_000));

    expect(await lookup.lookup(query)).toMatchObject({ status: 'error' });
    await cache.flush();

    // 限流不是「豆瓣没这部片」的证据，缓存必须保持原样，绕过依然成立。
    client.suggest.mockResolvedValue([matchingCandidate]);
    expect(await lookup.lookup(query)).toMatchObject({ status: 'ok' });
  });
});
