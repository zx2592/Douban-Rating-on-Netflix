import { extractFromCard, extractFromModal, queryIdentity } from './extract';
import { NETFLIX_SELECTORS } from './selectors';
import { startSite, type SiteAdapter } from '../site';

/**
 * Netflix 内容脚本入口。
 *
 * 主循环在 ../site.ts 里，两个站点共用。这里只声明「Netflix 的 DOM 长什么样」
 * 和「怎么从它的 DOM 里读出片名」。
 */
const netflix: SiteAdapter = {
  id: 'netflix',
  name: 'Netflix',
  card: NETFLIX_SELECTORS.card,
  cardAnchor: NETFLIX_SELECTORS.cardAnchor,
  modal: NETFLIX_SELECTORS.modal,
  modalAnchor: NETFLIX_SELECTORS.modalAnchor,
  extractFromCard,
  extractFromModal,
  identityOf: queryIdentity,
};

void startSite(netflix).catch((error: unknown) => {
  // 兜住初始化阶段的任何意外，至少让问题在 Console 里留下痕迹，
  // 而不是安静地什么都不做。
  console.error('[豆瓣评分] 初始化失败', error);
});
