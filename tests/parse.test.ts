import { describe, expect, it } from 'vitest';
import {
  extractYear,
  normalizeScore,
  parseSubjectAbstract,
  parseSubjectHtml,
  parseSuggest,
} from '../src/background/douban/parse';

/**
 * 这些 fixture 按豆瓣站内接口实际返回的形状构造。这几个接口都没有公开契约，
 * 所以测试的重点不只是"能解析对"，更是"返回意外内容时不会崩"。
 */

const SUGGEST_FIXTURE = [
  {
    episode: '',
    img: 'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2561716440.jpg',
    title: '河边的错误',
    url: 'https://movie.douban.com/subject/35131346/',
    type: 'movie',
    year: '2023',
    sub_title: 'Only the River Flows',
    id: '35131346',
  },
  {
    episode: '4',
    img: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2880000000.jpg',
    title: '怪奇物语 第四季',
    url: 'https://movie.douban.com/subject/30458212/',
    type: 'movie',
    year: '2022',
    sub_title: 'Stranger Things Season 4',
    id: '30458212',
  },
  {
    title: '影视幕后的故事',
    url: 'https://book.douban.com/subject/1234567/',
    type: 'book',
    year: '2010',
    id: '1234567',
  },
];

describe('parseSuggest', () => {
  it('解析出影视条目并带上原名和年份', () => {
    const candidates = parseSuggest(SUGGEST_FIXTURE);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      id: '35131346',
      title: '河边的错误',
      originalTitle: 'Only the River Flows',
      year: 2023,
      type: 'movie',
    });
  });

  it('用非空的 episode 字段把剧集和电影区分开', () => {
    const candidates = parseSuggest(SUGGEST_FIXTURE);
    expect(candidates[1]?.type).toBe('tv');
  });

  it('过滤掉图书、音乐等非影视条目', () => {
    const candidates = parseSuggest(SUGGEST_FIXTURE);
    expect(candidates.map((item) => item.id)).not.toContain('1234567');
  });

  it('sub_title 和主标题相同时不重复记为原名', () => {
    const [candidate] = parseSuggest([
      { id: '1', title: '同名', sub_title: '同名', type: 'movie', year: '2020' },
    ]);
    expect(candidate?.originalTitle).toBeUndefined();
  });

  it('suggest 接口不返回评分，所以候选的 score 一定是 null', () => {
    for (const candidate of parseSuggest(SUGGEST_FIXTURE)) {
      expect(candidate.score).toBeNull();
    }
  });

  describe('面对异常输入时不抛异常', () => {
    it.each([
      ['null', null],
      ['对象而非数组', { items: [] }],
      ['字符串', 'not json'],
      ['数组里混着 null', [null, undefined, 42]],
      ['缺少 id 和 title', [{ type: 'movie', year: '2020' }]],
    ])('%s', (_label, input) => {
      expect(() => parseSuggest(input)).not.toThrow();
      expect(parseSuggest(input)).toEqual([]);
    });
  });
});

describe('parseSubjectAbstract', () => {
  it('解析 rate 字段', () => {
    expect(parseSubjectAbstract({ subject: { rate: '7.4', title: '河边的错误' } })).toEqual({
      score: 7.4,
      votes: null,
    });
  });

  it('兼容改名为 rating 的情况', () => {
    expect(parseSubjectAbstract({ subject: { rating: 8.8 } })?.score).toBe(8.8);
  });

  it('结构不符时返回 null 而不是抛异常', () => {
    expect(parseSubjectAbstract(null)).toBeNull();
    expect(parseSubjectAbstract({ nope: 1 })).toBeNull();
  });

  it('豆瓣用 0 表示"暂无评分"，要转成 null', () => {
    expect(parseSubjectAbstract({ subject: { rate: '0' } })?.score).toBeNull();
  });
});

describe('parseSubjectHtml', () => {
  it('优先从 ld+json 里读评分和评价人数', () => {
    const html = `<html><head>
      <script type="application/ld+json">
      {"@context":"http://schema.org","@type":"Movie","name":"河边的错误",
       "aggregateRating":{"@type":"AggregateRating","ratingCount":"254321",
       "bestRating":"10","worstRating":"2","ratingValue":"7.4"}}
      </script></head><body></body></html>`;
    expect(parseSubjectHtml(html)).toEqual({ score: 7.4, votes: 254321 });
  });

  it('ld+json 缺失时退回到微数据属性', () => {
    const html = `<strong class="ll rating_num" property="v:average"> 8.7 </strong>
      <span property="v:votes">1234567</span>`;
    expect(parseSubjectHtml(html)).toEqual({ score: 8.7, votes: 1234567 });
  });

  it('ld+json 是坏 JSON 时也能退回微数据，不会抛异常', () => {
    const html = `<script type="application/ld+json">{ 这不是 JSON </script>
      <strong property="v:average">6.2</strong>`;
    expect(parseSubjectHtml(html)).toEqual({ score: 6.2, votes: null });
  });

  it('页面里根本没有评分时返回 null', () => {
    expect(parseSubjectHtml('<html><body>404</body></html>')).toBeNull();
  });
});

describe('extractYear', () => {
  it.each([
    ['2023', 2023],
    ['2023 / 中国大陆 / 剧情 犯罪', 2023],
    ['上映于 1994 年', 1994],
  ])('从 %s 中取出 %i', (input, expected) => {
    expect(extractYear(input)).toBe(expected);
  });

  it('取不到合理年份时返回 undefined', () => {
    expect(extractYear('第 12 集')).toBeUndefined();
    expect(extractYear(undefined)).toBeUndefined();
    expect(extractYear('3021')).toBeUndefined();
  });
});

describe('normalizeScore', () => {
  it('保留一位小数', () => {
    expect(normalizeScore('7.45')).toBe(7.5);
    expect(normalizeScore(8)).toBe(8);
  });

  it('0 分和越界值都视为没有评分', () => {
    expect(normalizeScore(0)).toBeNull();
    expect(normalizeScore(11)).toBeNull();
    expect(normalizeScore(-1)).toBeNull();
    expect(normalizeScore('暂无')).toBeNull();
  });
});
