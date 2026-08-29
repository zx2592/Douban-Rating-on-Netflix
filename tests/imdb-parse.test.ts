import { describe, expect, it } from 'vitest';
import {
  mediaTypeFromQid,
  normalizeScore,
  parseGraphqlRating,
  parseJsonLdRating,
  parseSuggestion,
} from '../src/background/imdb/parse';

/**
 * IMDb 的接口和豆瓣一样没有契约保证，而且**开发环境无法访问 imdb.com**，
 * 这些用例用的是按接口已知形态构造的样本，不是抓回来的真实响应。
 * 它们保证的是「拿到这个形状时解析得对、拿到畸形数据时不崩」，
 * 真实形状要靠诊断页在用户浏览器里确认（src/shared/imdb-probe.ts）。
 */

const SUGGESTION = {
  d: [
    {
      i: { height: 1000, imageUrl: 'https://m.media-amazon.com/x.jpg', width: 675 },
      id: 'tt0903747',
      l: 'Breaking Bad',
      q: 'TV series',
      qid: 'tvSeries',
      rank: 63,
      s: 'Bryan Cranston, Aaron Paul',
      y: 2008,
      yr: '2008-2013',
    },
    {
      id: 'tt2378794',
      l: 'Breaking Bad: Original Minisodes',
      qid: 'tvSeries',
      rank: 40000,
      y: 2009,
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

  it('过滤掉人名条目', () => {
    // 搜索框的建议里混着演员（nm 开头），拿它去取分只会 404。
    const candidates = parseSuggestion({
      d: [
        { id: 'nm0186505', l: 'Bryan Cranston', qid: 'name' },
        { id: 'tt0903747', l: 'Breaking Bad', qid: 'tvSeries' },
      ],
    });
    expect(candidates.map((c) => c.id)).toEqual(['tt0903747']);
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

describe('parseJsonLdRating', () => {
  const PAGE = `<!DOCTYPE html><html><head>
    <script type="application/ld+json">{"@type":"TVSeries","name":"Breaking Bad",
    "aggregateRating":{"@type":"AggregateRating","ratingCount":2200000,"bestRating":"10",
    "worstRating":"1","ratingValue":9.5}}</script>
    </head><body></body></html>`;

  it('从条目页里取出评分', () => {
    expect(parseJsonLdRating(PAGE)).toEqual({ score: 9.5, votes: 2200000 });
  });

  it('票数带千分位逗号也能解析', () => {
    const page = `<script type="application/ld+json">
      {"aggregateRating":{"ratingValue":"8.4","ratingCount":"1,234,567"}}</script>`;
    expect(parseJsonLdRating(page)).toEqual({ score: 8.4, votes: 1234567 });
  });

  it('跳过坏掉的 JSON-LD 块，继续找下一个', () => {
    // IMDb 页面里不止一段 ld+json，第一段坏了不代表没救。
    const page = `<script type="application/ld+json">{ 这不是 JSON </script>
      ${PAGE}`;
    expect(parseJsonLdRating(page)).toEqual({ score: 9.5, votes: 2200000 });
  });

  it('页面里没有评分数据时返回 null', () => {
    expect(parseJsonLdRating('<html><body>404</body></html>')).toBeNull();
    expect(parseJsonLdRating('<script type="application/ld+json">{"name":"x"}</script>')).toBeNull();
  });
});
