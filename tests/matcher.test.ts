import { describe, expect, it } from 'vitest';
import { pickBestMatch, scoreCandidate, type Candidate } from '../src/background/matcher';
import type { MediaQuery } from '../src/shared/types';

function candidate(partial: Partial<Candidate> & Pick<Candidate, 'id' | 'title'>): Candidate {
  return {
    type: 'unknown',
    score: null,
    votes: null,
    url: `https://movie.douban.com/subject/${partial.id}/`,
    ...partial,
  };
}

function query(partial: Partial<MediaQuery> & Pick<MediaQuery, 'title'>): MediaQuery {
  return { type: 'unknown', ...partial };
}

describe('pickBestMatch', () => {
  it('标题和年份都对得上时选中该条目', () => {
    const match = pickBestMatch(query({ title: '河边的错误', year: 2023 }), [
      candidate({ id: '35131346', title: '河边的错误', year: 2023 }),
    ]);
    expect(match?.candidate.id).toBe('35131346');
  });

  it('Netflix 显示英文原名、豆瓣主标题是中文时，靠原名匹配上', () => {
    const match = pickBestMatch(query({ title: 'Stranger Things', year: 2016 }), [
      candidate({ id: '26752852', title: '怪奇物语', originalTitle: 'Stranger Things', year: 2016 }),
    ]);
    expect(match?.candidate.id).toBe('26752852');
    expect(match?.confidence).toBeGreaterThanOrEqual(90);
  });

  it('Netflix 是繁体、豆瓣是简体时也能匹配', () => {
    const match = pickBestMatch(query({ title: '魷魚遊戲', year: 2021 }), [
      candidate({ id: '35088562', title: '鱿鱼游戏', year: 2021 }),
    ]);
    expect(match?.candidate.id).toBe('35088562');
  });

  it('年份差两年以上直接判为不同影片', () => {
    // 同名翻拍是最典型的误配来源，年份不符必须否决。
    const match = pickBestMatch(query({ title: '狮子王', year: 2019 }), [
      candidate({ id: '1301753', title: '狮子王', year: 1994 }),
    ]);
    expect(match).toBeNull();
  });

  it('年份只差一年时仍然接受（跨年上映很常见）', () => {
    const match = pickBestMatch(query({ title: '寄生虫', year: 2020 }), [
      candidate({ id: '27010768', title: '寄生虫', year: 2019 }),
    ]);
    expect(match?.candidate.id).toBe('27010768');
  });
});

describe('pickBestMatch 的"宁缺毋滥"', () => {
  it('没有年份时，仅仅是包含关系不足以判定为同一部片', () => {
    // 列表卡片上拿不到年份，此时若把"蝙蝠侠"配到"蝙蝠侠归来"，
    // 用户看到的就是一个错误的分数 —— 比不显示更糟。
    const match = pickBestMatch(query({ title: '蝙蝠侠' }), [
      candidate({ id: '1', title: '蝙蝠侠归来' }),
    ]);
    expect(match).toBeNull();
  });

  it('没有年份时，完全一致的标题仍然接受', () => {
    const match = pickBestMatch(query({ title: '教父' }), [candidate({ id: '1291841', title: '教父' })]);
    expect(match?.candidate.id).toBe('1291841');
  });

  it('毫不相干的候选一律拒绝', () => {
    const match = pickBestMatch(query({ title: '肖申克的救赎', year: 1994 }), [
      candidate({ id: '1', title: '速度与激情', year: 1994 }),
      candidate({ id: '2', title: '泰坦尼克号', year: 1997 }),
    ]);
    expect(match).toBeNull();
  });

  it('候选为空时返回 null', () => {
    expect(pickBestMatch(query({ title: '任意片名' }), [])).toBeNull();
  });
});

describe('分季匹配', () => {
  const seasons = [
    candidate({ id: 's1', title: '怪奇物语 第一季', year: 2016 }),
    candidate({ id: 's2', title: '怪奇物语 第二季', year: 2017 }),
    candidate({ id: 's4', title: '怪奇物语 第四季', year: 2022 }),
  ];

  it('查询指明第几季时选中对应那一季', () => {
    expect(pickBestMatch(query({ title: '怪奇物语', season: 2 }), seasons)?.candidate.id).toBe('s2');
    expect(pickBestMatch(query({ title: '怪奇物语', season: 4 }), seasons)?.candidate.id).toBe('s4');
  });

  it('标题里自带季数后缀时同样能解析出来', () => {
    expect(pickBestMatch(query({ title: '怪奇物语 第四季' }), seasons)?.candidate.id).toBe('s4');
  });

  it('查询没有季数时默认取第一季', () => {
    // 用户在列表里看到的是"这部剧"，给第一季的分最贴近预期。
    expect(pickBestMatch(query({ title: '怪奇物语' }), seasons)?.candidate.id).toBe('s1');
  });
});

describe('同分时的取舍', () => {
  it('标题年份都相同时选评价人数多的', () => {
    const match = pickBestMatch(query({ title: '危机', year: 2021 }), [
      candidate({ id: 'few', title: '危机', year: 2021, votes: 120 }),
      candidate({ id: 'many', title: '危机', year: 2021, votes: 98000 }),
    ]);
    expect(match?.candidate.id).toBe('many');
  });

  it('类型对得上的候选优先于类型不符的', () => {
    const match = pickBestMatch(query({ title: '同名作品', year: 2020, type: 'tv' }), [
      candidate({ id: 'movie', title: '同名作品', year: 2020, type: 'movie', votes: 99999 }),
      candidate({ id: 'tv', title: '同名作品', year: 2020, type: 'tv', votes: 10 }),
    ]);
    // 即便电影版评价人数多得多，类型信号也应该压过它。
    expect(match?.candidate.id).toBe('tv');
  });
});

describe('scoreCandidate', () => {
  it('confidence 截断在 0–100，raw 保留真实差距', () => {
    const scored = scoreCandidate(query({ title: '教父', year: 1972, type: 'movie' }), candidate({
      id: '1',
      title: '教父',
      year: 1972,
      type: 'movie',
    }));
    expect(scored.confidence).toBeLessThanOrEqual(100);
    expect(scored.raw).toBeGreaterThan(100);
  });

  it('reason 里能看出是凭什么打的分', () => {
    const scored = scoreCandidate(query({ title: 'Dark', year: 2017 }), candidate({
      id: '1',
      title: '暗黑',
      originalTitle: 'Dark',
      year: 2017,
    }));
    expect(scored.reason).toContain('原名');
  });
});
