import { splitSeason } from '../../shared/text';
import type { MediaQuery } from '../../shared/types';
import { queryFirst, readFirstText } from '../dom';
import { NETFLIX_SELECTORS } from './selectors';

/** 零宽字符和多余空白会让归一化后的标题对不上，先清干净。 */
function collapseWhitespace(text: string): string {
  return text.replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

export interface CleanedTitle {
  title: string;
  /** 标题里写在括号中的年份，例如 "Ghostbusters (2016)"。 */
  year?: number;
}

/**
 * 清洗页面上读到的原始标题。
 *
 * Netflix 的 aria-label 偶尔会把年份带在括号里，这是列表卡片上唯一可能
 * 出现的年份来源，能拿到就一定要拿 —— 有年份的匹配阈值可以放宽很多。
 */
export function cleanTitle(raw: string): CleanedTitle {
  let title = collapseWhitespace(raw);

  const yearMatch = /[（(]\s*((?:18|19|20)\d{2})\s*[)）]\s*$/.exec(title);
  let year: number | undefined;
  if (yearMatch) {
    year = Number.parseInt(yearMatch[1]!, 10);
    title = title.slice(0, yearMatch.index).trim();
  }

  // 去掉包裹整个标题的引号（部分地区的 aria-label 会加）。
  title = title.replace(/^["'「『《]/, '').replace(/["'」』》]$/, '').trim();

  return year !== undefined ? { title, year } : { title };
}

/** 从一张列表卡片上提取查询条件。列表卡片上通常拿不到年份和类型。 */
export function extractFromCard(card: HTMLElement): MediaQuery | null {
  const raw = readFirstText(card, NETFLIX_SELECTORS.cardTitle);
  if (!raw) return null;

  const cleaned = cleanTitle(raw);
  if (!cleaned.title) return null;

  const season = splitSeason(cleaned.title).season;
  return {
    title: cleaned.title,
    type: 'unknown',
    ...(cleaned.year !== undefined ? { year: cleaned.year } : {}),
    ...(season !== undefined ? { season } : {}),
  };
}

/**
 * 从详情弹层上提取查询条件。这里能同时拿到年份和类型，
 * 匹配可信度比列表卡片高一个档次。
 */
export function extractFromModal(modal: HTMLElement): MediaQuery | null {
  const raw = readFirstText(modal, NETFLIX_SELECTORS.modalTitle);
  if (!raw) return null;

  const cleaned = cleanTitle(raw);
  if (!cleaned.title) return null;

  const yearText = queryFirst(modal, NETFLIX_SELECTORS.modalYear)?.textContent ?? '';
  const yearMatch = /\b((?:18|19|20)\d{2})\b/.exec(yearText);
  const year = yearMatch ? Number.parseInt(yearMatch[1]!, 10) : cleaned.year;

  const isSeries = queryFirst(modal, NETFLIX_SELECTORS.seriesMarker) !== null;
  const season = splitSeason(cleaned.title).season;

  return {
    title: cleaned.title,
    type: isSeries ? 'tv' : 'unknown',
    ...(year !== undefined ? { year } : {}),
    ...(season !== undefined ? { season } : {}),
  };
}

/** 用于判断卡片被复用后标题是否变了。 */
export function queryIdentity(query: MediaQuery): string {
  return `${query.title}|${query.year ?? ''}|${query.season ?? ''}|${query.type}`;
}
