import { BADGE_CLASS, removeBadge, upsertBadge, type BadgePart, type BadgeState } from './badge';
import { BUILD_ID } from '../shared/build-info';
import { joinSelectors, queryFirst } from './dom';
import { sendRequest } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../shared/settings';
import type { LookupOutcome, MediaQuery, RatingSource, RatingsOutcome, SiteId } from '../shared/types';

/**
 * 站点无关的内容脚本主循环。
 *
 * Netflix 和 Prime Video 只有 DOM 知识不同（选择器、怎么从卡片上取片名），
 * 观察器、驻留判定、角标渲染、点击记兴趣、复用检测这一整套是完全一样的，
 * 而且是这个项目里踩坑最多的部分 —— 卡片复用时把分数挂错封面、角标跨挂载点
 * 重复、点角标被误记成兴趣，每一条都是实际发生过的 bug。复制一份给新站点
 * 等于把这些坑重新埋一遍，所以抽成这一层，站点只提供一个 SiteAdapter。
 *
 * 两条主线：
 * 1. MutationObserver 发现新出现的卡片 —— 两个站点都是 SPA，榜单和弹层都是
 *    动态渲染的，光在 DOMContentLoaded 扫一次什么也扫不到。
 * 2. IntersectionObserver 决定何时真的去查 —— 首页一次能渲染几百张卡片，
 *    但用户只看得到十几张。只为进入视口的卡片发请求，是把请求量压到可接受
 *    范围的关键；否则光打开首页就会把豆瓣打到限流。
 */

/** 一个站点要提供的全部东西：DOM 知识 + 怎么从 DOM 里读出查询条件。 */
export interface SiteAdapter {
  /** 站点标识，随每次查询发给 background，用于分站点开关。 */
  readonly id: SiteId;
  /** 用于日志和自检提示，例如 "Netflix"。 */
  readonly name: string;
  /** 列表页的影片卡片。 */
  readonly card: readonly string[];
  /** 角标要挂进去的容器（封面图区域），需要能作为定位参考系。 */
  readonly cardAnchor: readonly string[];
  /** 悬停 / 点击后弹出的详情层。没有就给空数组。 */
  readonly modal: readonly string[];
  /** 详情层里角标的落点。 */
  readonly modalAnchor: readonly string[];
  /**
   * 卡片被复用时站点会改的属性名。留空则用默认的 aria-label / alt。
   *
   * 必须由站点提供：默认那两个是照 Netflix 定的，Prime Video 的片名挂在
   * `data-card-title` 上，复用时改的是它。用默认值的话我们收不到通知，
   * 上一部片的评分会一直挂在新片子的封面上 —— 分数配错封面比不显示糟得多。
   */
  readonly watchedAttributes?: readonly string[];
  extractFromCard(card: HTMLElement): MediaQuery | null;
  extractFromModal(modal: HTMLElement): MediaQuery | null;
  /** 用于判断卡片被复用后标题是否变了。 */
  identityOf(query: MediaQuery): string;
}

const IDENTITY_ATTR = 'data-dbr-identity';
/**
 * 每张卡片当前走到哪一步。只为诊断而写，不参与任何逻辑。
 *
 * 加它的原因很具体：排查「为什么很多卡片没有评分」时，光看 DOM 分不清
 * 「压根没进视口所以没查」和「查了但没结果」—— 两者都表现为「有身份标记、
 * 没有角标」，而修法完全不同。有了这个标记，一份诊断报告就能直接给出
 * 「多少张在等视口 / 多少张查到了 / 多少张未收录」。
 */
const STATE_ATTR = 'data-dbr-state';
type CardState =
  /** 已发现，在等进入视口。 */
  | 'pending'
  /** 请求已发出，在等结果。 */
  | 'querying'
  | 'ok'
  | 'missing'
  | 'error'
  /** 读不到片名，这张压根不该查。 */
  | 'skipped'
  /** 请求回来时这个 DOM 节点已被站点复用给别的片子，结果作废。 */
  | 'recycled';

function setState(card: HTMLElement, state: CardState): void {
  card.setAttribute(STATE_ATTR, state);
}
/** DOM 变动的合并窗口。滚动时变动非常密集，扫太勤会拖慢页面。 */
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
/** 打开页面这么久之后若一张卡片都没找到，多半是站点改版了。 */
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
/** 由 startSite() 注入。在它之前没有任何逻辑会跑。 */
let adapter: SiteAdapter;
/**
 * 已停止的标记。
 *
 * 停止之后，所有异步回调（请求往返、驻留计时）都必须自觉作废 —— 光把观察器
 * 断开是不够的，此刻可能还有几个 sendRequest 在路上，它们回来时会往页面上
 * 挂角标。
 */
let stopped = false;
/** 主观察器。stop() 要能断开它。 */
let mutationObserver: MutationObserver | null = null;

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
/**
 * 因暂时性失败重试过几次。
 *
 * 卡片一旦处理过就会 unobserve，所以查询失败之后它不会再被触发 —— 用户
 * 不滚走再滚回来，这张封面就永远空着。而失败原因常常只是暂时的：请求队列
 * 满了（密集的列表页一屏就能塞满 40 个待查）、对方在限流、网络抖了一下。
 * 把这类失败重新排回观察，是「有很多卡片一直没分」的直接解药。
 *
 * 用 WeakMap 计数并设上限：无限重试会在配额被打穿时变成一个自旋的请求风暴，
 * 那比不显示糟得多。
 */
const retries = new WeakMap<Element, number>();
const MAX_RETRIES = 2;
/** 暂时性失败后隔多久把卡片放回观察。对方给了建议时间就听它的。 */
const RETRY_BASE_MS = 4000;

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
        setState(card, 'querying');
        void processCard(card);
      }, DWELL_MS);
    }
  },
  { rootMargin: PREFETCH_MARGIN },
);

async function processCard(card: HTMLElement): Promise<void> {
  if (stopped || !card.isConnected || !settings.enabled || !settings.showOnCards) return;

  const query = adapter.extractFromCard(card);
  if (!query) {
    // 状态必须跟着走完每一条分支，否则它会停在 querying 上骗人 ——
    // 实测报告里就出现过「26 张卡片一直在 querying」，看着像后台卡死，
    // 其实是这些提前返回的路径没更新状态。诊断信号本身失真，
    // 比没有信号更糟。
    setState(card, 'skipped');
    return;
  }

  const anchor = queryFirst(card, adapter.cardAnchor) ?? card;
  const identity = adapter.identityOf(query);

  // 列表卡片刻意不显示"查询中"的占位角标。
  //
  // 后台请求是串行限速的，视口里十几张卡片排队要花几十秒，期间每张封面上都
  // 挂一个只有"豆"字、没有数字的角标，看起来像是坏了 —— 实际用户反馈就是
  // 「出现了豆字，但不是评分」。改成结果回来才注入，没查到的卡片保持原样，
  // 已查到的直接显示分数，中间态不占位。详情弹层是用户主动打开等结果的，
  // 那里仍然显示查询中。
  const outcome = await sendRequest({ kind: 'lookup', query, site: adapter.id });

  // 请求往返期间站点可能已经把这个 DOM 节点复用给了另一部片子，
  // 此时必须丢弃这次结果，否则会把评分挂到错误的封面上。
  if (stopped || !card.isConnected) return;
  const current = adapter.extractFromCard(card);
  if (!current || adapter.identityOf(current) !== identity) {
    debug('卡片已被复用，丢弃结果', identity);
    // 只在扫描器还没重新标记过这张卡片时才写 recycled。
    //
    // 复用发生后扫描器会按新片子把它标成 pending 并重新排队 —— 那才是这张
    // 卡片当前的真实状态。这里若无条件覆盖，就把一个更新的、正确的状态
    // 改回了一个过期的描述。两者存在竞争，谁后写谁赢，所以必须显式判断。
    if (card.getAttribute(IDENTITY_ATTR) === identity) setState(card, 'recycled');
    return;
  }

  // 开着的来源全都只回了暂时性错误 —— 这张卡片这轮什么都拿不到，但它
  // 不是「没有分」，只是「这次没查成」。放回观察，过一会儿再试。
  const transient = enabledSourcesFailed(outcome);
  if (transient !== null) {
    setState(card, 'error');
    scheduleRetry(card, transient);
    removeBadge(card);
    return;
  }

  const parts = toBadgeParts(outcome, settings.showUnrated);
  if (parts.length === 0) {
    // 两边都查过了，确实没有可信结果 —— 这是结论，不是失败。
    setState(card, 'missing');
    removeBadge(card);
    return;
  }
  setState(card, parts.some((part) => part.state.kind === 'rated') ? 'ok' : 'missing');
  // 拿到结果了，重试计数归零：下次再失败时它还有完整的重试额度。
  retries.delete(card);
  // 传整张卡片作为去重范围：anchor 的解析结果会随 Netflix 重渲染漂移，
  // 不跨挂载点清理就会出现两个角标叠在封面同一个角上。
  upsertBadge(anchor, { variant: 'card', position: settings.badgePosition, identity, parts }, card);
}

/**
 * 开着的来源是不是全都只回了暂时性错误。
 *
 * 返回建议的重试延迟；只要有任何一个来源给出了确定的结果（有分 / 未收录），
 * 就返回 null —— 那不是失败，页面上该显示的已经显示了。
 */
function enabledSourcesFailed(outcome: RatingsOutcome): number | null {
  let retryAfter = 0;
  let sawError = false;
  for (const source of SOURCE_ORDER) {
    const result = outcome[source];
    // disabled 的来源不参与判断：用户主动关掉的，不该拖着整张卡片重试。
    if (result.status === 'disabled') continue;
    if (result.status !== 'error') return null;
    sawError = true;
    retryAfter = Math.max(retryAfter, result.retryAfterMs ?? 0);
  }
  return sawError ? Math.max(retryAfter, RETRY_BASE_MS) : null;
}

/** 把卡片放回视口观察，等它再次触发驻留判定。 */
function scheduleRetry(card: HTMLElement, delayMs: number): void {
  const used = retries.get(card) ?? 0;
  if (used >= MAX_RETRIES) return;
  retries.set(card, used + 1);

  setTimeout(() => {
    if (stopped || !card.isConnected) return;
    // 重新观察即可：真正要不要发请求，仍然由驻留判定说了算 ——
    // 用户早就滚走的卡片不会因为这次重试而白花配额。
    viewportObserver.observe(card);
  }, delayMs);
}

async function processModal(modal: HTMLElement): Promise<void> {
  if (stopped || !settings.enabled || !settings.showOnDetail) return;

  const query = adapter.extractFromModal(modal);
  if (!query) return;

  const anchor = queryFirst(modal, adapter.modalAnchor);
  if (!anchor) return;

  const identity = adapter.identityOf(query);
  if (anchor.getAttribute(IDENTITY_ATTR) === identity) return;
  anchor.setAttribute(IDENTITY_ATTR, identity);

  // 详情层是用户主动打开等结果的，这里显示"查询中"占位；开着的来源各占一段。
  const loading: BadgePart[] = SOURCE_ORDER.filter((source) => settings.sources[source]).map(
    (source) => ({ source, state: { kind: 'loading' } }),
  );
  upsertBadge(anchor, { variant: 'modal', position: settings.badgePosition, identity, parts: loading });

  const outcome = await sendRequest({ kind: 'lookup', query, site: adapter.id });
  if (stopped || !anchor.isConnected || anchor.getAttribute(IDENTITY_ATTR) !== identity) return;

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
  if (stopped || !settings.enabled) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  // 点角标是"我要去看条目页"，不是"我对这部片感兴趣"。
  //
  // 不能指望角标自己的 stopPropagation 拦住这里：本监听器挂在
  // document.body 的捕获阶段，而 body 是角标的祖先 —— 捕获是自外向内传的，
  // 我们比角标先拿到事件，它再怎么拦也来不及。所以只能在这里认目标。
  if (target.closest(`.${BADGE_CLASS}`)) return;

  const card = target.closest<HTMLElement>(joinSelectors(adapter.card));
  if (!card) return;

  const query = adapter.extractFromCard(card);
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
  if (stopped || !settings.enabled) return;

  if (settings.showOnCards) {
    const cards = document.querySelectorAll<HTMLElement>(joinSelectors(adapter.card));
    if (cards.length > 0) sawAnyCard = true;

    for (const card of cards) {
      const query = adapter.extractFromCard(card);
      if (!query) continue;
      const identity = adapter.identityOf(query);
      // 身份没变说明这张卡片已经处理过（或正在处理），跳过。
      // 身份变了说明节点被 Netflix 回收复用了，要按新片子重新走一遍。
      if (card.getAttribute(IDENTITY_ATTR) === identity) continue;

      removeBadge(card);
      card.setAttribute(IDENTITY_ATTR, identity);
      // pending = 已发现、在等进入视口。和「查过但没结果」是两回事。
      setState(card, 'pending');
      viewportObserver.observe(card);
    }
  }

  // modal 为空数组表示这个站点没有详情弹层（Prime Video 的详情是整页）。
  if (settings.showOnDetail && adapter.modal.length > 0) {
    const modal = queryFirst(document, adapter.modal);
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

export async function startSite(next: SiteAdapter): Promise<void> {
  adapter = next;
  stopped = false;

  // 把实际在用的选择器挂到 <html> 上，供 scripts/dom-probe.js 读取。
  // 诊断脚本跑在页面里、拿不到扩展的模块，如果让它自己维护一份选择器，
  // 两边必然会脱节 —— 实测就发生过：扩展早就改了卡片选择器，脚本还在用
  // 旧的那条，于是报告里「被扫描器处理过 21 张」，而真实数字是 179。
  // 报告失真比没有报告更糟，它会把排查引向不存在的问题。
  document.documentElement.setAttribute('data-dbr-cards', joinSelectors(adapter.card));
  document.documentElement.setAttribute('data-dbr-anchors', joinSelectors(adapter.cardAnchor));
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

  mutationObserver = new MutationObserver(scheduleScan);
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    // 两个站点的横向列表都会回收 DOM 节点给下一部片子用，此时它改的是属性
    // 而不是增删节点。不监听属性的话，被复用的卡片会一直挂着上一部片的
    // 评分 —— 分数配错封面比不显示分数糟糕得多。
    //
    // 要监听哪些属性由适配器给：Netflix 改的是 aria-label / alt，
    // Prime Video 改的是 data-card-title。这里原先硬编码前者，Prime Video
    // 于是完全收不到复用通知 —— 用例「监听的属性由适配器决定」守着这一条。
    //
    // 必须用 attributeFilter 限定范围：站点在动画期间会疯狂改 style 和 class，
    // 不过滤的话回调会被淹没。
    attributes: true,
    attributeFilter: [...(adapter.watchedAttributes ?? ['aria-label', 'alt'])],
  });
  scan();

  // 选择器失效自检：站点改版后 class 名会变，届时这条日志是最快的线索。
  setTimeout(() => {
    if (!stopped && !sawAnyCard && location.pathname !== '/') {
      console.warn(
        `[豆瓣评分] 没有在页面上找到任何影片卡片，${adapter.name} 可能已改版。` +
          `请更新 ${adapter.name} 适配器里的选择器。`,
      );
    }
  }, SELECTOR_HEALTHCHECK_MS);
}

/**
 * 停止这个实例：断开观察器、清掉计时器、让在途的异步回调作废。
 *
 * 线上一个页面只会有一个内容脚本实例，所以这个函数平时用不到 —— 它是给
 * 测试用的，但**不是测试专用的摆设**。加它的直接原因是一次真实的测试污染：
 * 前一个用例的实例在后一个用例里继续扫描了当前 document（scan() 读的是全局
 * document，不是启动时捕获的根节点），结果查询带着 A 站点的 id、B 站点的
 * 片名发了出去。这类互相污染会掩盖真实回归，比它自己更危险。
 */
export function stopSite(): void {
  stopped = true;
  mutationObserver?.disconnect();
  mutationObserver = null;
  viewportObserver.disconnect();
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  document.body.removeEventListener('click', handleCardClick, true);
}
