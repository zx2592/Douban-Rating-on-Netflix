import { extractFromCard, extractFromDetail } from './extract';
import { PRIMEVIDEO_SELECTORS } from './selectors';
import { queryIdentity } from '../netflix/extract';
import { startSite, type SiteAdapter } from '../site';

/**
 * Prime Video 内容脚本入口。
 *
 * 主循环在 ../site.ts 里，和 Netflix 共用 —— 观察器、驻留判定、角标渲染、
 * 点击记兴趣、卡片复用检测全都一样，这里只声明这个站点的 DOM 长什么样。
 *
 * 一处结构性差异：Prime Video 的详情是**整页跳转**（/detail/<ASIN>），
 * 不是 Netflix 那样的悬停弹层。所以 modal 指向页面根节点，由
 * extractFromDetail 用 URL 判断当前是不是详情页 —— 不是就返回 null，
 * 避免把首页的 h1 当成片名去查。
 */
const primevideo: SiteAdapter = {
  id: 'primevideo',
  name: 'Prime Video',
  card: PRIMEVIDEO_SELECTORS.card,
  cardAnchor: PRIMEVIDEO_SELECTORS.cardAnchor,
  watchedAttributes: PRIMEVIDEO_SELECTORS.watchedAttributes,
  // 详情页没有独立容器，整个 <main>（退到 body）就是它。
  modal: ['main', 'body'],
  modalAnchor: PRIMEVIDEO_SELECTORS.detailAnchor,
  extractFromCard,
  extractFromModal: extractFromDetail,
  identityOf: queryIdentity,
};

void startSite(primevideo).catch((error: unknown) => {
  console.error('[豆瓣评分] 初始化失败', error);
});
