import { describe, expect, it } from 'vitest';
import { buildSearchTerms } from '../src/background/search-terms';

describe('buildSearchTerms', () => {
  it('英文片名直接原样检索，不做多余尝试', () => {
    // Netflix 界面设成英文时走的就是这条路：一次请求，靠豆瓣的
    // sub_title（英文原名）匹配。
    expect(buildSearchTerms('Starship Troopers')).toEqual(['Starship Troopers']);
  });

  it('简体片名不会被重复列两遍', () => {
    expect(buildSearchTerms('河边的错误')).toEqual(['河边的错误']);
  });

  it('繁体片名先转简体再检索，简体在前', () => {
    // 豆瓣是简体站点，拿繁体字面去查一个简体索引命中率明显更低。
    expect(buildSearchTerms('魷魚遊戲')).toEqual(['鱿鱼游戏', '魷魚遊戲']);
  });

  it('原始繁体形式仍保留作后备', () => {
    // 万一某个条目豆瓣就是用繁体登记的，转换后反而搜不到。
    expect(buildSearchTerms('星艦戰將')).toContain('星艦戰將');
  });

  it('去掉季数后缀，用主标题检索', () => {
    expect(buildSearchTerms('Stranger Things: Season 4')).toEqual(['Stranger Things']);
    expect(buildSearchTerms('怪奇物語 第四季')).toEqual(['怪奇物语', '怪奇物語']);
  });

  it('空标题返回空数组，不会白发一次请求', () => {
    expect(buildSearchTerms('   ')).toEqual([]);
  });
});
