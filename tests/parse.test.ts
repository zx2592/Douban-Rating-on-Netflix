import { describe, expect, it } from 'vitest';
import {
  extractYear,
  normalizeScore,
  parseSubjectAbstract,
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

  it('条目链接由 id 拼出，不带接口返回的 ?suggest= 跟踪参数', () => {
    const [candidate] = parseSuggest([
      {
        id: '35131346',
        title: '河边的错误',
        type: 'movie',
        year: '2023',
        url: 'https://movie.douban.com/subject/35131346/?suggest=%E6%B2%B3%E8%BE%B9',
      },
    ]);
    expect(candidate?.url).toBe('https://movie.douban.com/subject/35131346/');
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
  it('解析实际返回的结构', () => {
    // 按线上实测的响应构造：顶层有结果码 r，评分在 subject.rate 里。
    const payload = {
      r: 0,
      subject: {
        episodes_count: '',
        star: 4.0,
        rate: '8.4',
        short_comment: { content: '很好看' },
      },
    };
    expect(parseSubjectAbstract(payload)).toEqual({ score: 8.4, votes: null });
  });

  it('结果码非 0 时视为响应不可信', () => {
    expect(parseSubjectAbstract({ r: 1, subject: { rate: '8.4' } })).toBeNull();
  });

  it('兼容改名为 rating 的情况', () => {
    expect(parseSubjectAbstract({ subject: { rating: 8.8 } })?.score).toBe(8.8);
  });

  it('结构不符时返回 null 而不是抛异常', () => {
    expect(parseSubjectAbstract(null)).toBeNull();
    expect(parseSubjectAbstract({ nope: 1 })).toBeNull();
  });

  it('豆瓣用 0 表示"暂无评分"，要转成 null', () => {
    // 注意这和「返回 null」不是一回事：这里响应是好的，只是这部片还没出分。
    expect(parseSubjectAbstract({ r: 0, subject: { rate: '0' } })).toEqual({
      score: null,
      votes: null,
    });
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
