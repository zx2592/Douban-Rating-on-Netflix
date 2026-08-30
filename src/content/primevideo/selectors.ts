import type { TextSource } from '../dom';

/**
 * Prime Video 的 DOM 知识全部集中在这个文件里。
 *
 * ⚠️ **和 Netflix 那份不同，这里的选择器还没有经过线上验证。**
 * 开发环境访问不了 primevideo.com（网络策略拒绝），而且列表页要登录、
 * 按区域渲染，抓不到真实 DOM。这个项目为「凭记忆写选择器」付过一次代价：
 * v0.1 的 Netflix 选择器单测全绿、线上零命中。所以这一份刻意选了另一条路 ——
 *
 * **优先挂在路由契约上，而不是样式上。**
 * 影片卡片一律通过 `href` 里的 `/detail/<ASIN>` 来认。理由：
 * - class 是 CSS-in-JS 生成的（`_1x_1` 这种），每次构建都变，依赖它等于埋雷；
 * - `data-testid` / `data-automation-id` 比 class 稳，但仍是内部约定，会重命名；
 * - 而「点开一部片会跳到 /detail/<ASIN>」是这个产品对用户的路由契约，
 *   它变了等于站点大改版，稳定性高出一个量级。
 *
 * 标题和角标落点仍需要真实 DOM 才能定死，所以各给了一组候选逐个尝试。
 * 用 scripts/dom-probe.js 在真实页面上跑一遍，把报告贴回来即可收敛这份清单。
 */

/** Prime Video 的详情页路由。两个域名下形态不同，都要认。 */
export const DETAIL_ROUTE = /\/(?:gp\/video\/)?detail\/[A-Z0-9]+/i;

export const PRIMEVIDEO_SELECTORS = {
  /**
   * 列表页的一张影片卡片。
   *
   * 用属性包含匹配而不是精确匹配：真实的 href 后面还挂着 `/ref=...` 之类的
   * 跟踪参数，精确匹配一个都命中不了。
   */
  card: [
    'a[href*="/detail/"]',
    'a[href*="/gp/video/detail/"]',
  ],

  /**
   * 卡片标题。
   *
   * 顺序有讲究：aria-label 是无障碍属性，内容就是片名本身，最干净；
   * 封面图的 alt 次之；带 title 字样的测试钩子再次之。
   * 最后才退到链接自己的文本 —— 那里常常混着「立即观看」之类的按钮文案。
   */
  cardTitle: [
    { selector: ':self', attr: 'aria-label' },
    { selector: 'img[alt]', attr: 'alt' },
    { selector: '[data-automation-id*="title"]', attr: null },
    { selector: '[data-testid*="title"]', attr: null },
    { selector: ':closest([aria-label])', attr: 'aria-label' },
  ] satisfies TextSource[],

  /**
   * 角标要挂进去的容器（封面图区域），需要能作为定位参考系。
   * 和 Netflix 同一个思路：紧贴封面图的那一层。:has() 需要 Chrome 105+。
   */
  cardAnchor: [
    'div:has(> img)',
    'div:has(img)',
  ],

  /**
   * 详情页的标题。
   *
   * Prime Video 的详情是**整页跳转**，不是 Netflix 那样的悬停弹层，所以这里
   * 认的是页面本身。用 `h1` 而不是某个 data-* 钩子：语义化标签比内部命名稳，
   * 而详情页的主标题用 h1 是几乎不会变的做法。
   *
   * 只在 URL 确实是详情页时才启用（见 extract.ts），否则首页的 h1 会被
   * 当成片名去查 —— 那是纯粹的配额浪费，还可能配出个莫名其妙的分数。
   */
  detailTitle: [
    { selector: 'h1[data-automation-id*="title"]', attr: null },
    { selector: '[data-automation-id="title"]', attr: null },
    { selector: 'h1', attr: null },
  ] satisfies TextSource[],

  /** 详情页里的年份。通常混在分级、时长、季数那一行里。 */
  detailMeta: [
    '[data-automation-id*="meta-info"]',
    '[data-automation-id*="metadata"]',
    '[data-testid*="metadata"]',
    '[data-automation-id="release-year-badge"]',
  ],

  /** 详情页里角标的落点，挂在标题旁边。 */
  detailAnchor: [
    'h1[data-automation-id*="title"]',
    '[data-automation-id="title"]',
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
