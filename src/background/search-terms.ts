import { splitSeason, toSimplified } from '../shared/text';

/**
 * 生成豆瓣检索词，按尝试顺序排列。
 *
 * 之所以要多个检索词：Netflix 的片名跟着界面语言走，可能是英文原名、简体
 * 中文，也可能是繁体中文；而豆瓣是简体站点，条目主标题用大陆译名，英文原名
 * 存在 sub_title 里。拿繁体字面去查一个简体索引，命中率明显更低。
 *
 * 注意繁简转换只能解决「同一个译名的不同字体」，解决不了「两岸译名不同」——
 * 台译《星艦戰將》转成简体是「星舰战将」，而豆瓣上叫《星河战队》，是两个
 * 完全不同的翻译。这种情况只能靠英文原名匹配，也就是把 Netflix 的界面语言
 * 设成英文。
 */
export function buildSearchTerms(title: string): string[] {
  const base = splitSeason(title).base.trim() || title.trim();
  if (!base) return [];

  const terms: string[] = [];
  const simplified = toSimplified(base);
  // 简体优先：豆瓣的索引是简体的。
  if (simplified !== base) terms.push(simplified);
  terms.push(base);

  return [...new Set(terms)];
}
