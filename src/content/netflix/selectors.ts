/**
 * Netflix 的 DOM 知识全部集中在这个文件里。
 *
 * Netflix 是没有公开契约的商业站点，class 名会随改版变化，而且不同地区、
 * A/B 实验分组看到的 DOM 也不完全一样。所以每个位置都给一组候选选择器，
 * 从最精确的往下逐个试；改版时只需要在这里加一行，不用碰任何逻辑代码。
 */

/** 从元素上取文本：attr 为 null 表示读 textContent，否则读该属性。 */
export interface TextSource {
  selector: string;
  attr: string | null;
}

export const NETFLIX_SELECTORS = {
  /** 列表页 / 搜索页的一张影片卡片。 */
  card: ['.title-card', '[data-uia="title-card"]', '.slider-item .title-card-container'],

  /** 卡片标题。aria-label 最可靠，封面图 alt 和降级文本作为兜底。 */
  cardTitle: [
    { selector: 'a.slider-refocus[aria-label]', attr: 'aria-label' },
    { selector: '[data-uia="title-card-title"]', attr: null },
    { selector: 'a[aria-label]', attr: 'aria-label' },
    { selector: '.fallback-text', attr: null },
    { selector: 'img.boxart-image[alt]', attr: 'alt' },
  ] satisfies TextSource[],

  /** 角标要挂进去的容器（封面图区域），需要是定位参考系。 */
  cardAnchor: [
    '.boxart-container',
    '.boxart-size-16x9',
    '.boxart-size-7x10',
    'a.slider-refocus',
    '.ptrack-content',
  ],

  /** 悬停 / 点击后弹出的详情层。 */
  modal: ['.previewModal--container', '[data-uia="previewModal--container"]', '.jawBoneContainer'],

  modalTitle: [
    { selector: '[data-uia="previewModal--player-titleTreatment-logo"]', attr: 'alt' },
    { selector: '.previewModal--player-titleTreatment-logo img', attr: 'alt' },
    { selector: '[data-uia="previewModal--section-header"] strong', attr: null },
    { selector: '.previewModal--boxart-title', attr: null },
    { selector: '.title-title', attr: null },
  ] satisfies TextSource[],

  /** 详情层里的年份。 */
  modalYear: ['[data-uia="video-metadata"] .year', '.videoMetadata--first-line .year', '.year'],

  /** 详情层里角标的落点，挂在元数据行旁边。 */
  modalAnchor: [
    '[data-uia="video-metadata"]',
    '.videoMetadata--first-line',
    '.previewModal--detailsMetadata-left',
    '.previewModal--section-header',
  ],

  /**
   * 详情层里出现分季下拉或剧集列表，说明这是剧集而不是电影。
   * 这是 Netflix 上唯一稳定可得的类型信号。
   */
  seriesMarker: [
    '[data-uia="episode-selector"]',
    '[data-uia="season-selector"]',
    '.episodeSelector',
    '.previewModal--episodeSelector',
  ],
} as const;

/** 依次尝试一组选择器，返回第一个命中的元素。 */
export function queryFirst(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return null;
}

/** 依次尝试一组文本来源，返回第一个非空的文本。 */
export function readFirstText(root: ParentNode, sources: readonly TextSource[]): string | null {
  for (const source of sources) {
    const element = root.querySelector<HTMLElement>(source.selector);
    if (!element) continue;
    const raw = source.attr === null ? element.textContent : element.getAttribute(source.attr);
    const text = raw?.trim();
    if (text) return text;
  }
  return null;
}

/** 把一组选择器拼成一条，用于一次性扫描整页。 */
export function joinSelectors(selectors: readonly string[]): string {
  return selectors.join(', ');
}
