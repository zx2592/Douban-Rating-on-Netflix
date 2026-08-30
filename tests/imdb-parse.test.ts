import { describe, expect, it } from 'vitest';
import {
  mediaTypeFromQid,
  normalizeScore,
  parseGraphqlRating,
  parseSuggestion,
} from '../src/background/imdb/parse';

/**
 * 这些样本是**本机实测抓回来的真实响应**，不是照着记忆构造的
 * —— 开发环境访问不了 imdb.com，所以由用户在自己机器上跑
 * `node scripts/imdb-probe.mjs` 打回来，再固化成用例。
 * 项目在 v0.1 吃过「凭记忆写接口」的亏，这次不重蹈覆辙。
 */

/** 实测响应（v3.sg /suggestion/x/Breaking Bad）。 */
const SUGGESTION = {
  d: [
    {
      i: {
        height: 1500,
        imageUrl: 'https://m.media-amazon.com/images/M/MV5BOWE4NTc3YmYt._V1_.jpg',
        width: 1021,
      },
      id: 'tt0903747',
      l: 'Breaking Bad',
      q: 'TV series',
      qid: 'tvSeries',
      rank: 41,
      s: 'Bryan Cranston, Aaron Paul',
      // tl 是展示用的副标题（"2008-2013 TV Series"），不是本地化标题 ——
      // 一度以为它可能带中文名，实测确认不是，所以解析里不用它。
      tl: '2008-2013 TV Series',
      y: 2008,
      yr: '2008-2013',
    },
    {
      // 实测里混着「系列」条目：id 以 in 开头，没有 qid、没有年份。
      i: { height: 1536, imageUrl: 'https://m.media-amazon.com/images/M/x._V1_.jpg', width: 2048 },
      id: 'in0000274',
      l: 'Breaking Bad',
      rank: 231,
      s: 'Franchise',
    },
    {
      id: 'tt9243946',
      l: 'El Camino',
      q: 'feature',
      qid: 'movie',
      rank: 2048,
      s: 'Aaron Paul, Jonathan Banks',
      tl: '2019',
      y: 2019,
    },
  ],
  q: 'breaking bad',
  v: 1,
};

describe('parseSuggestion', () => {
  it('取出 id、标题、年份和类型', () => {
    const [first] = parseSuggestion(SUGGESTION);
    expect(first).toMatchObject({
      id: 'tt0903747',
      title: 'Breaking Bad',
      year: 2008,
      type: 'tv',
      url: 'https://www.imdb.com/title/tt0903747/',
    });
    // 建议接口不带评分，必须留空让上层去补，不能瞎填 0。
    expect(first?.score).toBeNull();
    expect(first?.votes).toBeNull();
  });

  it('过滤掉人名和系列条目', () => {
    // 实测响应里混着演员（nm 开头）和「系列」（in 开头）。
    // 只有 tt 开头的才是影视条目，拿别的去取分只会失败。
    const candidates = parseSuggestion(SUGGESTION);
    expect(candidates.map((c) => c.id)).toEqual(['tt0903747', 'tt9243946']);
  });

  it('过滤掉电子游戏', () => {
    // Netflix 上有云游戏卡片，且不少影视 IP 有同名游戏。
    // 把游戏的评分挂到影片封面上，比不显示更糟。
    const candidates = parseSuggestion({
      d: [{ id: 'tt1234567', l: 'Breaking Bad', qid: 'videoGame' }],
    });
    expect(candidates).toHaveLength(0);
  });

  it('缺字段的条目跳过，不影响同批的其它条目', () => {
    const candidates = parseSuggestion({
      d: [null, 'nonsense', { id: 'tt0903747' }, { l: '没有 id' }, ...SUGGESTION.d],
    });
    expect(candidates).toHaveLength(2);
  });

  it('实测：中文查询能命中，但返回的是英文标题', () => {
    // 这是本机实测查「鱿鱼游戏」拿回来的真实响应。
    // IMDb 认得中文别名，却只回英文标题 —— 匹配层必须为此专门处理，
    // 否则字面相似度是 0，搜索成功了结果也会被扔掉。
    const candidates = parseSuggestion({
      d: [
        {
          id: 'tt10919420',
          l: 'Squid Game',
          q: 'TV series',
          qid: 'tvSeries',
          rank: 914,
          s: 'Lee Jung-jae, Wi Ha-joon',
          tl: '2021-2025 TV Series',
          y: 2021,
          yr: '2021-2025',
        },
      ],
    });
    expect(candidates[0]).toMatchObject({ id: 'tt10919420', title: 'Squid Game', year: 2021, type: 'tv' });
  });

  it('结构完全不对时返回空数组而不是抛错', () => {
    expect(parseSuggestion(null)).toEqual([]);
    expect(parseSuggestion({})).toEqual([]);
    expect(parseSuggestion({ d: 'nope' })).toEqual([]);
  });
});

describe('mediaTypeFromQid', () => {
  it('tv 开头的算剧集，tvMovie 除外', () => {
    expect(mediaTypeFromQid('tvSeries')).toBe('tv');
    expect(mediaTypeFromQid('tvMiniSeries')).toBe('tv');
    // 电视电影本质是电影，豆瓣那边也按电影收录。
    expect(mediaTypeFromQid('tvMovie')).toBe('movie');
  });

  it('游戏和音乐录影带明确排除', () => {
    expect(mediaTypeFromQid('videoGame')).toBeNull();
    expect(mediaTypeFromQid('musicVideo')).toBeNull();
  });

  it('没见过的 qid 归为 unknown，不猜', () => {
    expect(mediaTypeFromQid('podcastSeries')).toBe('unknown');
    expect(mediaTypeFromQid(undefined)).toBe('unknown');
  });
});

describe('normalizeScore', () => {
  it('保留一位小数', () => {
    expect(normalizeScore(9.46)).toBe(9.5);
    expect(normalizeScore('8.4')).toBe(8.4);
  });

  it('0 和越界值一律当作没有评分', () => {
    expect(normalizeScore(0)).toBeNull();
    expect(normalizeScore(11)).toBeNull();
    expect(normalizeScore('暂无')).toBeNull();
    expect(normalizeScore(null)).toBeNull();
  });
});

describe('parseGraphqlRating', () => {
  it('取出评分和票数', () => {
    expect(
      parseGraphqlRating({
        data: { title: { ratingsSummary: { aggregateRating: 9.5, voteCount: 2200000 } } },
      }),
    ).toEqual({ score: 9.5, votes: 2200000 });
  });

  it('票数够但还没出分是有效结果', () => {
    // aggregateRating 缺失但 ratingsSummary 在：IMDb 确实还没给分。
    // 这和「接口坏了」必须分开，否则会把可用路径误判成失效。
    expect(parseGraphqlRating({ data: { title: { ratingsSummary: { voteCount: 3 } } } })).toEqual({
      score: null,
      votes: 3,
    });
  });

  it('结构对不上返回 null，让调用方换下一条路径', () => {
    expect(parseGraphqlRating(null)).toBeNull();
    expect(parseGraphqlRating({ data: { title: null } })).toBeNull();
    expect(parseGraphqlRating({ data: { title: { ratingsSummary: {} } } })).toBeNull();
    expect(parseGraphqlRating({ errors: [{ message: 'boom' }] })).toBeNull();
  });
});
