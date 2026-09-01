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
  // hero 的操作区。里面全是按钮：播放、加入清单、「More details」。
  //
  // 按结构排除整个区域，而不是逐个列举按钮名 —— 后者是治标的：实测先撞见
  // 播放按钮（aria-label="Watch now"），排掉之后又撞见 Info 按钮
  // （aria-label="More details for Sing 2"），两次都真的拿这些文案去查了
  // 评分。而且这些文案随界面语言变，列举永远追不上。操作区里没有任何
  // 东西是影片卡片，整片排掉才是对的。
  '[data-testid="action-box"] *',
  '[data-testid="details-icon"] *',
  '[data-testid="play"]',
  '[data-automation-id="play"]',
  // hero 区域的整幅背景图链接。它和 hero 的其它链接指向同一部片，而且里面
  // 没有 <img>，角标会落到整块背景的左上角；hero 还会自动轮播，角标跟着抖。
  '[data-testid="image-link"]',
  // 卡片容器内部的链接。实测一张卡片是
  //   <article data-card-title="…"><div data-testid="packshot"><a href="/detail/…">
  // 容器和内部链接都命中的话，同一部片会被当成两张卡片各处理一遍 ——
  // 实测页面上 170 张卡片留下了 327 个身份标记，正是这么来的。
  // 容器信息更全（有片名、有类型、有封面容器），所以留容器、去掉内部链接。
  '[data-card-title] *',
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
    // 卡片容器排第一：它同时带着片名和类型，信息最全。
    '[data-card-title]',
    `a[data-testid="poster-link"]:not(${NOT_A_CARD})`,
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
    // 实测的封面容器。卡片结构是
    //   <article data-card-title><section data-testid="card-section">
    //     <div data-testid="packshot"><a …>
    '[data-testid="packshot"]',
    'div:has(> picture)',
    'picture',
    'div:has(> img)',
    'div:has(img)',
  ],

  /**
   * 卡片上的类型标记。实测值形如 `data-card-entity-type="Movie"`。
   *
   * 这是意外的收获：在此之前列表卡片一律只能发 type: 'unknown'，匹配器
   * 因此拿不到消歧信号。有了它，同名的电影和剧集能分开，IMDb 那边的跨语种
   * 回退（要求类型相容）也才真正有依据。
   */
  cardType: [{ selector: ':self', attr: 'data-card-entity-type' }, { selector: ':closest([data-card-entity-type])', attr: 'data-card-entity-type' }] satisfies TextSource[],

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
   * 卡片被复用时站点会改的属性。
   *
   * 榜单是横向滚动的虚拟列表，节点会回收给下一部片子用 —— 此时改的是
   * `data-card-title`（片名）和 `data-card-entity-type`（类型），不是增删
   * 节点。主循环靠 MutationObserver 的 attributeFilter 收这个通知；漏了它，
   * 上一部片的评分会一直挂在新片子的封面上。
   *
   * aria-label / alt 也留着：卡片兜底选择器命中的是 <a>，片名从这两个属性上读。
   */
  watchedAttributes: ['data-card-title', 'data-card-entity-type', 'aria-label', 'alt'],

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
