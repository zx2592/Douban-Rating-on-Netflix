import type { TextSource } from '../dom';

/**
 * Netflix 的 DOM 知识全部集中在这个文件里。
 *
 * Netflix 是没有公开契约的商业站点，class 名会随改版变化，而且不同地区、
 * A/B 实验分组看到的 DOM 也不完全一样。所以每个位置都给一组候选选择器，
 * 从最精确的往下逐个试；改版时只需要在这里加一行，不用碰任何逻辑代码。
 */

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
   * 和列表卡片不同，这里的 previewModal--container 类名在新版里活了下来
   * （新版还额外带上 data-uia="modal-motion-container-MINI_MODAL"）。
   * 悬停出的迷你弹层和点开后的完整详情层共用这个类名。
   */
  modal: [
    '.previewModal--container',
    '[data-uia^="modal-motion-container"]',
    '[data-uia="previewModal--container"]',
    '.jawBoneContainer',
  ],

  modalTitle: [
    // 新版迷你弹层：片名在封面图的 alt 上。注意同一个弹层里有多个 img，
    // 只有带 previewModal--boxart 类的那几个才有片名。
    { selector: 'img.previewModal--boxart[alt]', attr: 'alt' },
    { selector: '[data-uia="previewModal--player-titleTreatment-logo"]', attr: 'alt' },
    { selector: '.previewModal--player-titleTreatment-logo img', attr: 'alt' },
    { selector: '[data-uia="previewModal--section-header"] strong', attr: null },
    { selector: '.previewModal--boxart-title', attr: null },
    { selector: '.title-title', attr: null },
  ] satisfies TextSource[],

  /**
   * 详情层里的年份。
   *
   * 最后一条是兜底：拿整个元数据容器的文本去正则四位年份。迷你弹层里
   * 年份不一定有独立元素，混在分级、时长、画质标记中间。
   */
  modalYear: [
    '[data-uia="video-metadata"] .year',
    '.videoMetadata--first-line .year',
    '.year',
    '[data-uia="videoMetadata--container"]',
    '.videoMetadata--container',
  ],

  /** 详情层里角标的落点，挂在元数据行旁边。 */
  modalAnchor: [
    '[data-uia="videoMetadata--container"]',
    '.videoMetadata--container',
    '[data-uia="video-metadata"]',
    '.videoMetadata--first-line',
    '[data-uia="previewModal--metadatAndControls"]',
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
