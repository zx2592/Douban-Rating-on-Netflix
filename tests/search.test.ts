import { describe, expect, it } from 'vitest';
import {
  extractEmbeddedData,
  parseAliases,
  parseSearchResults,
  splitBilingualTitle,
} from '../src/background/douban/search';

/**
 * 这段 __DATA__ 抄自线上 search.douban.com 的真实响应（用户实测抓回），
 * abstract、labels、id 都是原样，title / rating / url 按同一对象补全。
 */
const REAL_ITEM = {
  abstract: '美国 / 动作 / 冒险 / 科幻 / 惊悚 / 星舰战将(台) / 太空战士 / 129分钟',
  abstract_2: '保罗·范霍文 / 卡斯帕·范·迪恩 / 迪娜·迈耶',
  cover_url: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg',
  extra_actions: [],
  id: 1293544,
  interest: null,
  label_actions: [],
  labels: [{ color: '#00ad3f', text: '电影' }],
  more_url: 'onclick="moreurl(this,{from:\'mv_subject_search\',subject_id:\'1293544\'})"',
  rating: { count: 172000, rating_info: '', star_count: 4, value: 7.9 },
  title: '星河战队 Starship Troopers',
  url: 'https://movie.douban.com/subject/1293544/',
};

const REAL_TV_ITEM = {
  abstract: '韩国 / 悬疑 / 惊悚 / 第六轮 / Squid Game / 60分钟',
  id: 34812928,
  labels: [{ color: '#00ad3f', text: '剧集' }],
  rating: { count: 900000, star_count: 3.5, value: 7.6 },
  title: '鱿鱼游戏 오징어 게임',
  url: 'https://movie.douban.com/subject/34812928/',
};

const PAGE = `<html><body><script>
  window.__DATA__ = ${JSON.stringify({ count: 15, error_info: '', items: [REAL_ITEM, REAL_TV_ITEM] })};
</script></body></html>`;

describe('extractEmbeddedData', () => {
  it('从搜索结果页里切出 __DATA__ 对象', () => {
    const data = extractEmbeddedData(PAGE) as { items: unknown[] };
    expect(data.items).toHaveLength(2);
  });

  it('JSON 里的花括号和转义引号不会把切割搞乱', () => {
    // more_url 字段里就带着 onclick="...{...}" 这种内容，用正则框会截断。
    const data = extractEmbeddedData(PAGE) as { items: Array<Record<string, unknown>> };
    expect(data.items[0]!['more_url']).toContain('subject_id');
  });

  it('后面还跟着其它脚本时也能正确结束', () => {
    const page = `${PAGE}<script>var other = {a: {b: 1}};</script>`;
    const data = extractEmbeddedData(page) as { items: unknown[] };
    expect(data.items).toHaveLength(2);
  });

  it('页面里没有 __DATA__ 时返回 null 而不是抛异常', () => {
    expect(extractEmbeddedData('<html>被风控了</html>')).toBeNull();
  });

  it('__DATA__ 不是合法 JSON 时返回 null', () => {
    expect(extractEmbeddedData('<script>window.__DATA__ = {坏掉的};</script>')).toBeNull();
  });
});

describe('splitBilingualTitle', () => {
  it('把「中文名 原名」拆开', () => {
    // 不拆的话，英文查询只能和整串算「包含关系」，分数过不了无年份时的阈值。
    expect(splitBilingualTitle('星河战队 Starship Troopers')).toEqual({
      primary: '星河战队',
      original: 'Starship Troopers',
    });
  });

  it('纯中文标题不拆', () => {
    expect(splitBilingualTitle('鱿鱼游戏')).toEqual({ primary: '鱿鱼游戏' });
  });

  it('纯英文标题不拆', () => {
    expect(splitBilingualTitle('Stranger Things')).toEqual({ primary: 'Stranger Things' });
  });

  it('原名不是拉丁字母时不拆（韩文、日文原名）', () => {
    expect(splitBilingualTitle('鱿鱼游戏 오징어 게임').primary).toBe('鱿鱼游戏 오징어 게임');
  });

  it('中文名里本身带数字也不会拆错', () => {
    expect(splitBilingualTitle('007：大战皇家赌场')).toEqual({ primary: '007：大战皇家赌场' });
  });
});

describe('parseAliases', () => {
  it('从 abstract 里抠出又名，滤掉国家、类型、时长', () => {
    expect(parseAliases(REAL_ITEM.abstract)).toEqual(['星舰战将', '太空战士']);
  });

  it('去掉港台译名后面的来源标注', () => {
    // 「星舰战将(台)」要还原成「星舰战将」才能和 Netflix 上的台译对上。
    expect(parseAliases('美国 / 科幻 / 星舰战将(台) / 129分钟')).toEqual(['星舰战将']);
  });

  it('外语原名也算又名', () => {
    expect(parseAliases(REAL_TV_ITEM.abstract)).toContain('Squid Game');
  });

  it('滤掉集数', () => {
    expect(parseAliases('韩国 / 剧情 / 又名甲 / 8集')).toEqual(['又名甲']);
  });

  it('abstract 缺失或类型不对时返回空数组', () => {
    expect(parseAliases(undefined)).toEqual([]);
    expect(parseAliases(123)).toEqual([]);
  });
});

describe('parseSearchResults', () => {
  it('解析出完整的候选条目，评分直接带在里面', () => {
    const [movie] = parseSearchResults(extractEmbeddedData(PAGE));
    expect(movie).toMatchObject({
      id: '1293544',
      title: '星河战队',
      originalTitle: 'Starship Troopers',
      type: 'movie',
      score: 7.9,
      votes: 172000,
      url: 'https://movie.douban.com/subject/1293544/',
    });
    expect(movie?.aliases).toContain('星舰战将');
  });

  it('用标签区分剧集和电影', () => {
    const [, tv] = parseSearchResults(extractEmbeddedData(PAGE));
    expect(tv?.type).toBe('tv');
  });

  it('搜索结果自带评分，省掉单独取分那一次请求', () => {
    for (const candidate of parseSearchResults(extractEmbeddedData(PAGE))) {
      expect(candidate.score).not.toBeNull();
    }
  });

  it('豆瓣尚未出分时 score 为 null 而不是 0', () => {
    const data = { items: [{ ...REAL_ITEM, rating: { count: 0, value: 0 } }] };
    expect(parseSearchResults(data)[0]?.score).toBeNull();
  });

  describe('面对异常输入不抛异常', () => {
    it.each([
      ['null', null],
      ['没有 items', { count: 0 }],
      ['items 不是数组', { items: 'nope' }],
      ['条目里混着 null', { items: [null, 42] }],
      ['缺 id 和 title', { items: [{ abstract: '美国 / 剧情' }] }],
    ])('%s', (_label, input) => {
      expect(() => parseSearchResults(input)).not.toThrow();
      expect(parseSearchResults(input)).toEqual([]);
    });
  });
});
