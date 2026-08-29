import { describe, expect, it } from 'vitest';
import {
  diceCoefficient,
  normalizeTitle,
  splitSeason,
  toHalfWidth,
  toSimplified,
  tokenize,
  traditionalPairs,
} from '../src/shared/text';

describe('繁简对照表', () => {
  // 这张表一旦写坏（比如某项少写一个字），会静默地让转换全线失准，
  // 所以用结构性断言把它钉死。
  it('每一项都恰好是「繁简」两个字符', () => {
    const malformed = traditionalPairs.filter((pair) => [...pair].length !== 2);
    expect(malformed).toEqual([]);
  });

  it('没有重复的繁体字条目', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const pair of traditionalPairs) {
      const traditional = [...pair][0]!;
      if (seen.has(traditional)) duplicates.push(pair);
      seen.add(traditional);
    }
    expect(duplicates).toEqual([]);
  });

  it('不会把已经是简体的字转坏', () => {
    // 表里若混入「简→别的字」的错误条目，这条会炸。
    expect(toSimplified('电影海报')).toBe('电影海报');
  });
});

describe('toSimplified', () => {
  it('逐字转换常见繁体', () => {
    expect(toSimplified('魷魚遊戲')).toBe('鱿鱼游戏');
    expect(toSimplified('愛的迫降')).toBe('爱的迫降');
  });

  it('表里没有的字原样保留', () => {
    expect(toSimplified('abc漢字')).toBe('abc汉字');
  });
});

describe('toHalfWidth', () => {
  it('全角字母数字和空格转半角', () => {
    expect(toHalfWidth('Ｓｔｒａｎｇｅｒ　Ｔｈｉｎｇｓ')).toBe('Stranger Things');
  });
});

describe('splitSeason', () => {
  it.each([
    ['怪奇物语 第四季', '怪奇物语', 4],
    ['怪奇物语第2季', '怪奇物语', 2],
    ['某剧 第十二季', '某剧', 12],
    ['纸钞屋 第一部', '纸钞屋', 1],
    ['Stranger Things: Season 4', 'Stranger Things', 4],
    ['Stranger Things Season 2', 'Stranger Things', 2],
    ['The Crown - Series 5', 'The Crown', 5],
    ['Money Heist: Part 3', 'Money Heist', 3],
    ['Dark S2', 'Dark', 2],
  ])('把 %s 拆成 %s / 第 %i 季', (input, base, season) => {
    expect(splitSeason(input)).toEqual({ base, season });
  });

  it('没有季数后缀时原样返回', () => {
    expect(splitSeason('肖申克的救赎')).toEqual({ base: '肖申克的救赎' });
    expect(splitSeason('Se7en')).toEqual({ base: 'Se7en' });
  });

  it('不会把标题里本来就有的数字误判成季数', () => {
    // "1917" 是片名的一部分，不是季数。
    expect(splitSeason('1917')).toEqual({ base: '1917' });
    expect(splitSeason('Ocean\'s 11')).toEqual({ base: "Ocean's 11" });
  });
});

describe('normalizeTitle', () => {
  it('抹平大小写、标点、空格', () => {
    expect(normalizeTitle('Stranger Things')).toBe(normalizeTitle('STRANGER  THINGS!'));
  });

  it('抹平繁简差异', () => {
    expect(normalizeTitle('魷魚遊戲')).toBe(normalizeTitle('鱿鱼游戏'));
  });

  it('抹平变音符号', () => {
    expect(normalizeTitle('Amélie')).toBe(normalizeTitle('Amelie'));
  });

  it('把 & 和 and 视为同一个词', () => {
    expect(normalizeTitle('Rick & Morty')).toBe(normalizeTitle('Rick and Morty'));
  });

  it('丢掉 emoji 和零宽字符', () => {
    expect(normalizeTitle('爱 ❤ 死亡')).toBe('爱死亡');
  });

  it('不同的片名不会被归一化成同一个串', () => {
    expect(normalizeTitle('蝙蝠侠')).not.toBe(normalizeTitle('蝙蝠侠归来'));
  });
});

describe('tokenize', () => {
  it('拉丁标题按词切分', () => {
    expect(tokenize('The Dark Knight')).toEqual(['the', 'dark', 'knight']);
  });

  it('中文标题拆成单字，让重合度可算', () => {
    expect(tokenize('霸王别姬')).toEqual(['霸', '王', '别', '姬']);
  });
});

describe('diceCoefficient', () => {
  it('完全相同为 1', () => {
    expect(diceCoefficient(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('完全不同为 0', () => {
    expect(diceCoefficient(['a'], ['b'])).toBe(0);
  });

  it('空集合为 0 而不是 NaN', () => {
    expect(diceCoefficient([], ['a'])).toBe(0);
  });

  it('部分重合落在中间', () => {
    const score = diceCoefficient(['the', 'dark', 'knight'], ['the', 'dark', 'knight', 'rises']);
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1);
  });
});
