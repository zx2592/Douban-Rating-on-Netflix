import { removeBadge, upsertBadge, type BadgeState } from '../badge';
import { sendRequest } from '../../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../../shared/settings';
import type { LookupOutcome, MediaQuery } from '../../shared/types';
import { extractFromCard, extractFromModal, queryIdentity } from './extract';
import { joinSelectors, NETFLIX_SELECTORS, queryFirst } from './selectors';

/**
 * Netflix 内容脚本。
 *
 * 两条主线：
 * 1. MutationObserver 发现新出现的卡片 —— Netflix 是 SPA，榜单和弹层都是
 *    动态渲染的，光在 DOMContentLoaded 扫一次什么也扫不到。
 * 2. IntersectionObserver 决定何时真的去查豆瓣 —— 首页一次能渲染几百张卡片，
 *    但用户只看得到十几张。只为进入视口的卡片发请求，是把请求量压到可接受
 *    范围的关键；否则光打开首页就会把豆瓣打到限流。
 */

const IDENTITY_ATTR = 'data-dbr-identity';
/** DOM 变动的合并窗口。Netflix 滚动时变动非常密集，扫太勤会拖慢页面。 */
const SCAN_DEBOUNCE_MS = 250;
/** 提前于视口这么多像素开始查询，让用户滚到时评分已经就位。 */
const PREFETCH_MARGIN = '300px';
/** 打开页面这么久之后若一张卡片都没找到，多半是 Netflix 改版了。 */
const SELECTOR_HEALTHCHECK_MS = 8000;

const DEBUG = (() => {
  try {
    return localStorage.getItem('dbr:debug') === '1';
  } catch {
    return false;
  }
})();

function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[豆瓣评分]', ...args);
}

let settings: Settings = DEFAULT_SETTINGS;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let sawAnyCard = false;

/** 把查询结果翻译成角标状态。 */
function toBadgeState(outcome: LookupOutcome): BadgeState | null {
  switch (outcome.status) {
    case 'ok':
      return outcome.rating.score === null
        ? { kind: 'unrated', url: outcome.rating.url, title: outcome.rating.title }
        : {
            kind: 'rated',
            score: outcome.rating.score,
            votes: outcome.rating.votes,
            url: outcome.rating.url,
            title: outcome.rating.title,
          };
    case 'not_found':
      return { kind: 'missing' };
    case 'disabled':
      return null;
    case 'error':
      // 网络问题或被限流：不留残迹，等用户下次滚过来再试。
      debug('查询失败', outcome.reason);
      return null;
  }
}

const viewportObserver = new IntersectionObserver(
  (entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting);
    if (visible.length === 0) return;

    // 按视觉顺序（从上到下、从左到右）处理。后台请求是串行限速的，
    // 先到先得，让用户视线所及的卡片先出分。
    visible.sort((a, b) => {
      const rowDiff = a.boundingClientRect.top - b.boundingClientRect.top;
      return Math.abs(rowDiff) > 24 ? rowDiff : a.boundingClientRect.left - b.boundingClientRect.left;
    });

    for (const entry of visible) {
      viewportObserver.unobserve(entry.target);
      void processCard(entry.target as HTMLElement);
    }
  },
  { rootMargin: PREFETCH_MARGIN },
);

async function processCard(card: HTMLElement): Promise<void> {
  if (!card.isConnected || !settings.enabled || !settings.showOnCards) return;

  const query = extractFromCard(card);
  if (!query) return;

  const anchor = queryFirst(card, NETFLIX_SELECTORS.cardAnchor) ?? card;
  const identity = queryIdentity(query);
  upsertBadge(anchor, { variant: 'card', position: settings.badgePosition, identity, state: { kind: 'loading' } });

  const outcome = await sendRequest({ kind: 'lookup', query });

  // 请求往返期间 Netflix 可能已经把这个 DOM 节点复用给了另一部片子，
  // 此时必须丢弃这次结果，否则会把评分挂到错误的封面上。
  if (!card.isConnected) return;
  const current = extractFromCard(card);
  if (!current || queryIdentity(current) !== identity) {
    debug('卡片已被复用，丢弃结果', identity);
    return;
  }

  const state = toBadgeState(outcome);
  if (!state || (state.kind === 'missing' && !settings.showUnrated)) {
    removeBadge(anchor);
    return;
  }
  upsertBadge(anchor, { variant: 'card', position: settings.badgePosition, identity, state });
}

async function processModal(modal: HTMLElement): Promise<void> {
  if (!settings.enabled || !settings.showOnDetail) return;

  const query = extractFromModal(modal);
  if (!query) return;

  const anchor = queryFirst(modal, NETFLIX_SELECTORS.modalAnchor);
  if (!anchor) return;

  const identity = queryIdentity(query);
  if (anchor.getAttribute(IDENTITY_ATTR) === identity) return;
  anchor.setAttribute(IDENTITY_ATTR, identity);

  upsertBadge(anchor, { variant: 'modal', position: settings.badgePosition, identity, state: { kind: 'loading' } });

  const outcome = await sendRequest({ kind: 'lookup', query });
  if (!anchor.isConnected || anchor.getAttribute(IDENTITY_ATTR) !== identity) return;

  const state = toBadgeState(outcome);
  if (!state) {
    removeBadge(anchor);
    anchor.removeAttribute(IDENTITY_ATTR);
    return;
  }
  upsertBadge(anchor, { variant: 'modal', position: settings.badgePosition, identity, state });
}

function scan(): void {
  if (!settings.enabled) return;

  if (settings.showOnCards) {
    const cards = document.querySelectorAll<HTMLElement>(joinSelectors(NETFLIX_SELECTORS.card));
    if (cards.length > 0) sawAnyCard = true;

    for (const card of cards) {
      const query = extractFromCard(card);
      if (!query) continue;
      const identity = queryIdentity(query);
      // 身份没变说明这张卡片已经处理过（或正在处理），跳过。
      // 身份变了说明节点被 Netflix 回收复用了，要按新片子重新走一遍。
      if (card.getAttribute(IDENTITY_ATTR) === identity) continue;

      const anchor = queryFirst(card, NETFLIX_SELECTORS.cardAnchor) ?? card;
      removeBadge(anchor);
      card.setAttribute(IDENTITY_ATTR, identity);
      viewportObserver.observe(card);
    }
  }

  if (settings.showOnDetail) {
    const modal = queryFirst(document, NETFLIX_SELECTORS.modal);
    if (modal) void processModal(modal);
  }
}

function scheduleScan(): void {
  if (scanTimer !== null) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

/** 关闭开关时把已注入的角标全部撤掉，做到"关了就干净"。 */
function removeAllBadges(): void {
  for (const badge of document.querySelectorAll('.dbr-badge')) badge.remove();
  for (const marked of document.querySelectorAll(`[${IDENTITY_ATTR}]`)) {
    marked.removeAttribute(IDENTITY_ATTR);
  }
}

async function start(): Promise<void> {
  settings = await loadSettings();

  onSettingsChanged((next) => {
    const wasEnabled = settings.enabled;
    settings = next;
    removeAllBadges();
    if (next.enabled) scheduleScan();
    else if (wasEnabled) debug('已关闭，角标已清除');
  });

  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
    // Netflix 的横向列表会回收 DOM 节点给下一部片子用，此时它改的是
    // aria-label / alt 属性而不是增删节点。不监听属性的话，被复用的卡片会
    // 一直挂着上一部片的评分 —— 分数配错封面比不显示分数糟糕得多。
    // 用 attributeFilter 限定范围：Netflix 在动画期间会疯狂改 style 和 class，
    // 不过滤的话回调会被淹没。
    attributes: true,
    attributeFilter: ['aria-label', 'alt'],
  });
  scan();

  // 选择器失效自检：Netflix 改版后 class 名会变，届时这条日志是最快的线索。
  setTimeout(() => {
    if (!sawAnyCard && location.pathname !== '/') {
      console.warn(
        '[豆瓣评分] 没有在页面上找到任何影片卡片，Netflix 可能已改版。' +
          '请到 src/content/netflix/selectors.ts 更新选择器。',
      );
    }
  }, SELECTOR_HEALTHCHECK_MS);
}

void start();
