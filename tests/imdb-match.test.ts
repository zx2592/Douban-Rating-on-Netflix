import { describe, expect, it } from 'vitest';
import { pickImdbMatch } from '../src/background/imdb/match';
import type { Candidate } from '../src/background/matcher';
import type { MediaQuery } from '../src/shared/types';

/**
 * IMDb 的匹配和豆瓣不一样，两处差异都是本机实测逼出来的：
 *
 * 1. IMDb 用中文片名能搜到，但返回的是英文标题（查「鱿鱼游戏」得到
 *    "Squid Game"）。字面相似度是 0，通用匹配器会把它整个扔掉。
 * 2. IMDb 一部剧只有一个条目，不按季拆；豆瓣按季拆。通用匹配器对
 *    「季数对不上」重罚 30 分，放到 IMDb 上就是误伤。
 */

const SQUID: Candidate = {
  id: 'tt10919420',
  title: 'Squid Game',
  year: 2021,
  type: 'tv',
  score: null,
  votes: null,
  url: 'https://www.imdb.com/title/tt10919420/',
};

const SQUID_CHALLENGE: Candidate = {
  id: 'tt28104766',
  title: 'Squid Game: The Challenge',
  year: 2023,
  type: 'tv',
  score: null,
  votes: null,
  url: 'https://www.imdb.com/title/tt28104766/',
};

const BREAKING_BAD: Candidate = {
  id: 'tt0903747',
  title: 'Breaking Bad',
  year: 2008,
  type: 'tv',
  score: null,
  votes: null,
  url: 'https://www.imdb.com/title/tt0903747/',
};

describe('同语种：走通用打分', () => {
  it('英文标题正常命中', () => {
    const query: MediaQuery = { title: 'Breaking Bad', year: 2008, type: 'tv' };
    expect(pickImdbMatch(query, [BREAKING_BAD])?.candidate.id).toBe('tt0903747');
  });

  it('对不上的英文标题照样拒绝', () => {
    const query: MediaQuery = { title: 'Better Call Saul', year: 2015, type: 'tv' };
    expect(pickImdbMatch(query, [BREAKING_BAD])).toBeNull();
  });
});

describe('剧集季数：IMDb 不按季拆条目', () => {
  it('带季数的查询能命中整部剧', () => {
    // 豆瓣把《怪奇物语》拆成一季一个条目，IMDb 只有一个。通用匹配器会因为
    // 「查询有第四季、候选没有季数」扣 30 分，在 IMDb 上那是误伤。
    const query: MediaQuery = { title: 'Stranger Things Season 4', year: 2016, type: 'tv' };
    const series: Candidate = { ...BREAKING_BAD, id: 'tt4574334', title: 'Stranger Things', year: 2016 };
    expect(pickImdbMatch(query, [series])?.candidate.id).toBe('tt4574334');
  });
});

describe('跨语种：中文查询 → 英文候选', () => {
  const query: MediaQuery = { title: '鱿鱼游戏', type: 'unknown' };

  it('中文查询能命中 IMDb 返回的英文条目', () => {
    // 这是整个功能对中文界面用户能不能用的分水岭。没有这条回退，
    // 搜索明明成功了，评分却会被匹配器全部扔掉。
    const match = pickImdbMatch(query, [SQUID, SQUID_CHALLENGE]);
    expect(match?.candidate.id).toBe('tt10919420');
  });

  it('只认检索结果的第一名', () => {
    // 排在后面的是同系列衍生作品，不是同一部片。实测「Breaking Bad」
    // 那次返回 8 条，第三条是《续命之徒》—— 配上去就是错的。
    const match = pickImdbMatch(query, [SQUID_CHALLENGE, SQUID]);
    expect(match?.candidate.id).toBe('tt28104766');
    expect(match?.candidate.id).not.toBe('tt10919420');
  });

  it('类型对不上时拒绝', () => {
    const movieQuery: MediaQuery = { title: '鱿鱼游戏', type: 'movie' };
    expect(pickImdbMatch(movieQuery, [SQUID])).toBeNull();
  });

  it('有年份就必须对得上', () => {
    // 详情弹层里能拿到年份，那是最有力的旁证，不能浪费。
    const wrongYear: MediaQuery = { title: '鱿鱼游戏', year: 2015, type: 'tv' };
    expect(pickImdbMatch(wrongYear, [SQUID])).toBeNull();
  });

  it('年份差一年仍接受（跨年上映很常见）', () => {
    const offByOne: MediaQuery = { title: '鱿鱼游戏', year: 2022, type: 'tv' };
    expect(pickImdbMatch(offByOne, [SQUID])?.candidate.id).toBe('tt10919420');
  });

  it('有年份且完全吻合时置信度更高', () => {
    const exact: MediaQuery = { title: '鱿鱼游戏', year: 2021, type: 'tv' };
    const loose = pickImdbMatch(query, [SQUID])!;
    expect(pickImdbMatch(exact, [SQUID])!.confidence).toBeGreaterThan(loose.confidence);
  });

  it('查询本身带年份但候选没有年份时拒绝', () => {
    const noYear: Candidate = { ...SQUID };
    delete (noYear as { year?: number }).year;
    const withYear: MediaQuery = { title: '鱿鱼游戏', year: 2021, type: 'tv' };
    expect(pickImdbMatch(withYear, [noYear])).toBeNull();
  });

  it('字面本来就可比时不启用这条回退', () => {
    // 两边都是拉丁字母却没匹配上，那就是真的没匹配上，
    // 不该靠"排第一"把一个错的塞进来。
    const english: MediaQuery = { title: 'Some Unrelated Film', type: 'unknown' };
    expect(pickImdbMatch(english, [SQUID])).toBeNull();
  });

  it('空候选返回 null', () => {
    expect(pickImdbMatch(query, [])).toBeNull();
  });
});
