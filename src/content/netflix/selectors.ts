/**
 * Netflix 的 DOM 知识全部集中在这个文件里。
 *
 * Netflix 是没有公开契约的商业站点，class 名会随改版变化，而且不同地区、
 * A/B 实验分组看到的 DOM 也不完全一样。所以每个位置都给一组候选选择器，
 * 从最精确的往下逐个试；改版时只需要在这里加一行，不用碰任何逻辑代码。
 */

/**
 * 从元素上取文本：attr 为 null 表示读 textContent，否则读该属性。
 *
 * selector 支持三种写法：
 * - `':self'`          —— 取根元素自身。新版 Netflix 把 aria-label 直接放在
 *                         卡片元素上，而 querySelector 只找后代，取不到自己。
 * - `':closest(SEL)'`  —— 沿祖先链往上找。用于 data-uia 挂在封面图而标题在
 *                         外层 <a> 上的情况。
 * - 其它               —— 普通的后代选择器。
 */
export interface TextSource {
  selector: string;
  attr: string | null;
}

export const NETFLIX_SELECTORS = {
  /**
   * 列表页 / 搜索页的一张影片卡片。
   *
   * 优先用 data-uia：Netflix 的 class 现在全是 CSS-in-JS 生成的哈希名
   * （default-ltr-iqcdef-cache-19c3xp8 这种），每次构建都会变，完全不能依赖。
   * data-uia 是他们自己的测试钩子，稳定得多。
   *
   * 刻意逐个列出卡片类型而不是用 [data-uia$="-card"]：同一批里还有
   * cloud-game-card（云游戏），拿游戏名去查豆瓣既查不到又白费请求配额。
   */
  card: [
    'a[data-uia="standard-card"]',
    '[data-uia="standard-card"]',
    '[data-uia="progress-card"]',
    // 老版 Netflix 的结构，保留作兜底：Netflix 常做 A/B 实验，
    // 不同账号、地区看到的版本可能不一样。
    '.title-card',
    '[data-uia="title-card"]',
    '.slider-item .title-card-container',
  ],

  /** 卡片标题。 */
  cardTitle: [
    // 新版把 aria-label 放在卡片元素自身上。
    { selector: ':self', attr: 'aria-label' },
    // data-uia 若挂在封面图上，标题就在外层的 <a> 里。
    { selector: ':closest(a[aria-label])', attr: 'aria-label' },
    { selector: 'a[aria-label]', attr: 'aria-label' },
    { selector: '[data-uia="title-card-title"]', attr: null },
    { selector: '.fallback-text', attr: null },
    { selector: 'img[alt]', attr: 'alt' },
  ] satisfies TextSource[],

  /** 角标要挂进去的容器（封面图区域），需要是定位参考系。 */
  cardAnchor: [
    // 老版的封面容器。
    '.boxart-container',
    '.boxart-size-16x9',
    '.boxart-size-7x10',
    // 新版没有语义化 class，改用结构定位：紧贴封面图的那一层。
    // :has() 需要 Chrome 105+，manifest 里已要求 110。
    'div:has(> img)',
    'a.slider-refocus',
    '.ptrack-content',
  ],

  /**
   * 悬停 / 点击后弹出的详情层。
   *
   * 新版的结构尚未确认（详情层要打开后才能取到 DOM），这里暂时只有老版的
   * 选择器。取不到就只是详情层没有角标，不影响列表页。
   */
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

function resolveSource(root: ParentNode, selector: string): HTMLElement | null {
  if (selector === ':self') return root instanceof HTMLElement ? root : null;
  const closest = /^:closest\((.+)\)$/.exec(selector);
  if (closest) {
    return root instanceof Element ? root.closest<HTMLElement>(closest[1]!) : null;
  }
  return root.querySelector<HTMLElement>(selector);
}

/** 依次尝试一组文本来源，返回第一个非空的文本。 */
export function readFirstText(root: ParentNode, sources: readonly TextSource[]): string | null {
  for (const source of sources) {
    const element = resolveSource(root, source.selector);
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
