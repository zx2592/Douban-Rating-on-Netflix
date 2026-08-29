import { BADGE_CLASS, removeBadge, upsertBadge, type BadgePart, type BadgeState } from '../badge';
import { BUILD_ID } from '../../shared/build-info';
import { sendRequest } from '../../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../../shared/settings';
import type { LookupOutcome, MediaQuery, RatingSource, RatingsOutcome } from '../../shared/types';
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
/**
 * 卡片要在视野里停留这么久才真的去查豆瓣。
 *
 * 豆瓣对匿名请求的配额很紧，每个请求都很珍贵。快速滚动时会有大量卡片一闪
 * 而过，若一进入视口就排队，配额全花在用户根本没看的封面上，真正停下来看的
 * 那几张反而排在后面拿不到。
 */
const DWELL_MS = 600;
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

/**
 * 脚本一加载就在 <html> 上打上构建版本戳。
 *
 * 两个用途：
 * 1. 区分「脚本压根没注入」和「注入了但没找到卡片」—— 没有标记的话，这两种
 *    情况从页面 Console 里看起来一模一样。
 * 2. 确认「跑的是哪一版」。git pull 不会自动重建，重建后还要去扩展页点刷新，
 *    少做一步和「代码有 bug」在表现上完全一致，排查时为此绕过弯路。把
 *    npm run build 打印的版本戳和这里的值一比即可。
 *
 * 放在模块顶层而不是 start() 里，这样即使后续初始化抛异常，标记依然在。
 */
document.documentElement.setAttribute('data-dbr-loaded', BUILD_ID);

let settings: Settings = DEFAULT_SETTINGS;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let sawAnyCard = false;

/**
 * 显示顺序。数组顺序就是角标上从左到右的顺序 —— 豆瓣在前，IMDb 跟在后面。
 */
const SOURCE_ORDER: RatingSource[] = ['douban', 'imdb'];

/** 把查询结果翻译成角标状态。返回 null 表示这一段不该出现。 */
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

/**
 * 把各来源的结果拼成角标要显示的若干段。
 *
 * 每个来源独立成段：豆瓣被限流时 IMDb 那段照常显示，反之亦然 —— 这正是
 * 两边分开走队列、分开缓存的意义所在，聚合成"全有或全无"会把它浪费掉。
 */
function toBadgeParts(outcome: RatingsOutcome, showUnrated: boolean): BadgePart[] {
  const parts: BadgePart[] = [];
  for (const source of SOURCE_ORDER) {
    const state = toBadgeState(outcome[source]);
    if (!state) continue;
    // 列表页默认不为"未收录"占位，免得一排封面上挂满没有数字的空角标。
    if (state.kind === 'missing' && !showUnrated) continue;
    parts.push({ source, state });
  }
  return parts;
}

/** 当前停留在视野里的卡片。滚走的会被移除，用于驻留判定。 */
const inViewport = new WeakSet<Element>();
/** 已排上驻留计时的卡片，避免同一张卡反复计时。 */
const dwelling = new WeakSet<Element>();

const viewportObserver = new IntersectionObserver(
  (entries) => {
    const arrived: IntersectionObserverEntry[] = [];
    for (const entry of entries) {
      if (entry.isIntersecting) {
        inViewport.add(entry.target);
        if (!dwelling.has(entry.target)) arrived.push(entry);
      } else {
        // 滚走了：从视野集合里移除。此处刻意不 unobserve —— 用户往回滚时
        // 这张卡片还要能重新触发。
        inViewport.delete(entry.target);
      }
    }
    if (arrived.length === 0) return;

    // 按视觉顺序（从上到下、从左到右）处理。后台请求是串行限速的，
    // 先到先得，让用户视线所及的卡片先出分。
    arrived.sort((a, b) => {
      const rowDiff = a.boundingClientRect.top - b.boundingClientRect.top;
      return Math.abs(rowDiff) > 24 ? rowDiff : a.boundingClientRect.left - b.boundingClientRect.left;
    });

    for (const entry of arrived) {
      const card = entry.target as HTMLElement;
      dwelling.add(card);
      setTimeout(() => {
        dwelling.delete(card);
        // 计时期间滚走了就放弃，把配额留给用户真正停下来看的卡片。
        if (!inViewport.has(card) || !card.isConnected) return;
        viewportObserver.unobserve(card);
        inViewport.delete(card);
        void processCard(card);
      }, DWELL_MS);
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

  // 列表卡片刻意不显示"查询中"的占位角标。
  //
  // 后台请求是串行限速的，视口里十几张卡片排队要花几十秒，期间每张封面上都
  // 挂一个只有"豆"字、没有数字的角标，看起来像是坏了 —— 实际用户反馈就是
  // 「出现了豆字，但不是评分」。改成结果回来才注入，没查到的卡片保持原样，
  // 已查到的直接显示分数，中间态不占位。详情弹层是用户主动打开等结果的，
  // 那里仍然显示查询中。
  const outcome = await sendRequest({ kind: 'lookup', query });

  // 请求往返期间 Netflix 可能已经把这个 DOM 节点复用给了另一部片子，
  // 此时必须丢弃这次结果，否则会把评分挂到错误的封面上。
  if (!card.isConnected) return;
  const current = extractFromCard(card);
  if (!current || queryIdentity(current) !== identity) {
    debug('卡片已被复用，丢弃结果', identity);
    return;
  }

  const parts = toBadgeParts(outcome, settings.showUnrated);
  if (parts.length === 0) {
    removeBadge(card);
    return;
  }
  // 传整张卡片作为去重范围：anchor 的解析结果会随 Netflix 重渲染漂移，
  // 不跨挂载点清理就会出现两个角标叠在封面同一个角上。
  upsertBadge(anchor, { variant: 'card', position: settings.badgePosition, identity, parts }, card);
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

  // 详情层是用户主动打开等结果的，这里显示"查询中"占位；开着的来源各占一段。
  const loading: BadgePart[] = SOURCE_ORDER.filter((source) => settings.sources[source]).map(
    (source) => ({ source, state: { kind: 'loading' } }),
  );
  upsertBadge(anchor, { variant: 'modal', position: settings.badgePosition, identity, parts: loading });

  const outcome = await sendRequest({ kind: 'lookup', query });
  if (!anchor.isConnected || anchor.getAttribute(IDENTITY_ATTR) !== identity) return;

  // 详情层里保留"未收录"占位：用户是主动点开来看信息的，
  // 明确告诉他"这家没有"比让那一段凭空消失更有用。
  const parts = toBadgeParts(outcome, true);
  if (parts.length === 0) {
    removeBadge(anchor);
    anchor.removeAttribute(IDENTITY_ATTR);
    return;
  }
  upsertBadge(anchor, { variant: 'modal', position: settings.badgePosition, identity, parts });
}

/**
 * 点击卡片 = 用户对这部片感兴趣。
 *
 * 之前扩展对「主动点开的片」和「随手划过的片」一视同仁：同一个队列、同样的
 * 「未收录」缓存 TTL。在匿名配额本就很紧的前提下这是明显的错配 —— 记下这个
 * 信号，background 就能把这部片的查询插到队首，并且允许它绕过一次早先写下的
 * 「未收录」（那多半只是当时被限流）。
 *
 * 用捕获阶段监听：Netflix 自己会在冒泡阶段 stopPropagation，挂在冒泡上收不到。
 * 挂在 document.body 而不是 document 上 —— 捕获阶段一样会先于页面自己的处理
 * 器触发，而作用域和下面的 MutationObserver 保持一致。
 */
function handleCardClick(event: Event): void {
  if (!settings.enabled) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  // 点角标是"我要去看条目页"，不是"我对这部片感兴趣"。
  //
  // 不能指望角标自己的 stopPropagation 拦住这里：本监听器挂在
  // document.body 的捕获阶段，而 body 是角标的祖先 —— 捕获是自外向内传的，
  // 我们比角标先拿到事件，它再怎么拦也来不及。所以只能在这里认目标。
  if (target.closest(`.${BADGE_CLASS}`)) return;

  const card = target.closest<HTMLElement>(joinSelectors(NETFLIX_SELECTORS.card));
  if (!card) return;

  const query = extractFromCard(card);
  if (!query) return;

  void recordInterest(query, card);
}

async function recordInterest(query: MediaQuery, card: HTMLElement): Promise<void> {
  const recorded = await sendRequest({ kind: 'interest', query });
  // 冷却期内重复点击不会更新时间戳，此时也不必重查 —— 否则连点几下
  // 就是连发几次请求。
  if (!recorded) return;
  debug('已记录兴趣', query.title);

  // 立刻按新的优先级重查一次，让用户点开的这部片先出分。
  // 若已经有分，lookup 会直接命中缓存，不产生任何请求。
  if (settings.showOnCards && card.isConnected) void processCard(card);
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

      removeBadge(card);
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
  try {
    settings = await loadSettings();
  } catch (error) {
    // 读设置失败不该让整个扩展失效，用默认设置继续。这里如果直接抛出去，
    // 观察器就装不上了，页面上会一片空白且 Console 里什么都看不到。
    console.warn('[豆瓣评分] 读取设置失败，改用默认设置', error);
    settings = DEFAULT_SETTINGS;
  }

  onSettingsChanged((next) => {
    const wasEnabled = settings.enabled;
    settings = next;
    removeAllBadges();
    if (next.enabled) scheduleScan();
    else if (wasEnabled) debug('已关闭，角标已清除');
  });

  document.body.addEventListener('click', handleCardClick, true);

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

void start().catch((error: unknown) => {
  // 兜住初始化阶段的任何意外，至少让问题在 Console 里留下痕迹，
  // 而不是安静地什么都不做。
  console.error('[豆瓣评分] 初始化失败', error);
});
