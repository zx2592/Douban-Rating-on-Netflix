import type { TextSource } from '../dom';

/**
 * Prime Video 的 DOM 知识全部集中在这个文件里。
 *
 * 这份清单**是按线上实测的结构写的**（用户在真实页面跑 scripts/dom-probe.js
 * 打回来的报告），不是照记忆猜的。第一版猜的那份把 181 个链接都当成了影片
 * 卡片，其中包含播放按钮和 aria-hidden 的重复链接 —— 扩展真的拿
 * 「Watch now」去查了评分。
 *
 * 分层的依据，从最可信到最兜底：
 * 1. **站点自己的卡片组件标记**（`data-testid="poster-link"`、`data-card-title`）。
 *    实测确认这两类就是真正的影片卡片，前者已验证能出分。
 * 2. **路由契约**（`/detail/<ASIN>`）。稳，但**不够**：页面上指向同一部片的
 *    链接有好几个（封面、标题美术字、播放按钮），光靠路由分不出哪个是卡片。
 *    所以这一条必须配上排除规则才能用。
 * 3. class 一律不碰 —— `VfXkrJ`、`_1jWggM` 这种每次构建都变。
 */

/** Prime Video 的详情页路由。两个域名下形态不同，都要认。 */
export const DETAIL_ROUTE = /\/(?:gp\/video\/)?detail\/[A-Z0-9]+/i;

/**
 * 实测确认不是影片卡片、必须排除的东西。
 *
 * 这些都指向 `/detail/<ASIN>`，光看 href 和真卡片没有区别：
 * - `aria-hidden="true"`：给读屏软件隐藏的重复链接，和可见卡片指向同一部片；
 * - 播放 / 操作按钮：`aria-label` 是「Watch now」这类动作文案，不是片名。
 */
const NOT_A_CARD = [
  '[aria-hidden="true"]',
  '[data-testid="play"]',
  '[data-automation-id="play"]',
  // hero 区域的整幅背景图链接。它和 hero 的其它链接指向同一部片，而且里面
  // 没有 <img>，角标会落到整块背景的左上角；hero 还会自动轮播，角标跟着抖。
  '[data-testid="image-link"]',
  // 注意用逗号连成「选择器列表」而不是直接拼接 —— 拼接出来是复合选择器
  // `:not(a[x][y])`，含义变成「不同时满足 x 和 y」，等于什么都没排除。
].join(', ');

export const PRIMEVIDEO_SELECTORS = {
  /**
   * 列表页的一张影片卡片。
   *
   * 前两条是站点自己的卡片标记，最精确；第三条是路由兜底，但必须把上面那些
   * 「长得像卡片的东西」排除掉，否则会把播放按钮也当成影片。
   */
  card: [
    'a[data-testid="poster-link"]',
    '[data-card-title]',
    `a[href*="/detail/"]:not(${NOT_A_CARD})`,
    `a[href*="/gp/video/detail/"]:not(${NOT_A_CARD})`,
  ],

  /**
   * 卡片标题。
   *
   * `data-card-title` 排在最前：它是站点放在卡片容器上的片名，比 aria-label
   * 更专一（aria-label 在按钮上会是动作文案）。实测页面上有 155 个，
   * 和真实卡片数量吻合。
   */
  cardTitle: [
    { selector: ':self', attr: 'data-card-title' },
    { selector: ':closest([data-card-title])', attr: 'data-card-title' },
    { selector: '[data-card-title]', attr: 'data-card-title' },
    { selector: ':self', attr: 'aria-label' },
    { selector: 'img[alt]', attr: 'alt' },
    { selector: '[data-automation-id*="title"]', attr: null },
    { selector: '[data-testid*="title"]', attr: null },
  ] satisfies TextSource[],

  /**
   * 角标要挂进去的容器（封面图区域），需要能作为定位参考系。
   *
   * 实测封面图的父层是 `<picture>` 而不是 `div` —— 第一版只写了
   * `div:has(> img)`，所有卡片的落点都解析失败、全部退回整张卡片，
   * 角标于是跑到了卡片左上角而不是封面左上角。
   */
  cardAnchor: [
    'div:has(> picture)',
    'picture',
    'div:has(> img)',
    'div:has(img)',
  ],

  /**
   * 详情页的标题。
   *
   * Prime Video 的详情是**整页跳转**，不是 Netflix 那样的悬停弹层，所以这里
   * 认的是页面本身。只在 URL 确实是详情页时才启用（见 extract.ts），
   * 否则首页的 h1 会被当成片名去查。
   */
  detailTitle: [
    { selector: 'h1[data-automation-id*="title"]', attr: null },
    { selector: '[data-automation-id="title"]', attr: null },
    { selector: '[data-testid="title-art"]', attr: 'aria-label' },
    { selector: 'h1', attr: null },
  ] satisfies TextSource[],

  /** 详情页里的年份。通常混在分级、时长、季数那一行里。 */
  detailMeta: [
    '[data-testid="title-metadata-bottom-end"]',
    '[data-automation-id*="meta-info"]',
    '[data-testid*="metadata"]',
    '[data-automation-id*="metadata"]',
  ],

  /** 详情页里角标的落点，挂在标题旁边。 */
  detailAnchor: [
    'h1[data-automation-id*="title"]',
    '[data-automation-id="title"]',
    '[data-testid="title-art"]',
    'h1',
  ],

  /**
   * 出现分季选择器或剧集列表，说明这是剧集而不是电影。
   * 和 Netflix 那边一样，这是页面上唯一稳定可得的类型信号。
   */
  seriesMarker: [
    '[data-automation-id*="season-selector"]',
    '[data-automation-id*="episode-list"]',
    '[data-testid*="season"]',
  ],
} as const;
