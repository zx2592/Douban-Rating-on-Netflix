import type { BadgePosition } from '../shared/settings';

/**
 * 角标的注入与更新。
 *
 * 刻意不用 Shadow DOM：列表页上同时存在几十到上百张卡片，每张都挂一个
 * shadow root 的开销不划算。改为全部 class 加 dbr- 前缀，并对关键样式加
 * !important，避免被 Netflix 自己的样式覆盖。
 */

export const BADGE_CLASS = 'dbr-badge';
/** 记录角标当前渲染的是哪部片子，用于识别被 Netflix 复用的卡片。 */
const IDENTITY_ATTR = 'data-dbr-identity';

export type BadgeState =
  | { kind: 'loading' }
  /** 匹配到条目且有评分。 */
  | { kind: 'rated'; score: number; votes: number | null; url: string; title: string }
  /** 匹配到条目，但豆瓣因评价人数太少还没出分。 */
  | { kind: 'unrated'; url: string; title: string }
  /** 豆瓣上没有可信的匹配项。 */
  | { kind: 'missing' };

export interface BadgeOptions {
  /** card 用绝对定位压在封面上，modal 跟着元数据行排版。 */
  variant: 'card' | 'modal';
  position: BadgePosition;
  /** 当前卡片对应的影片标识，变了就说明卡片被复用了。 */
  identity: string;
  state: BadgeState;
}

/** 按分数分档上色：豆瓣 8 分以上是"值得看"的普遍共识。 */
function scoreTier(score: number): string {
  if (score >= 8) return 'high';
  if (score >= 6.5) return 'mid';
  return 'low';
}

function formatVotes(votes: number | null): string {
  if (votes === null) return '';
  if (votes >= 10000) return `${(votes / 10000).toFixed(1)} 万人评价`;
  return `${votes} 人评价`;
}

function describe(state: BadgeState): string {
  switch (state.kind) {
    case 'loading':
      return '正在查询豆瓣评分';
    case 'rated': {
      const votes = formatVotes(state.votes);
      return `豆瓣 ${state.score.toFixed(1)}${votes ? `（${votes}）` : ''} · ${state.title} · 点击查看条目`;
    }
    case 'unrated':
      return `豆瓣暂无评分 · ${state.title} · 点击查看条目`;
    case 'missing':
      return '豆瓣未收录';
  }
}

/**
 * 找出 root 子树里所有的角标。
 *
 * 刻意查整棵子树而不是只查直接子节点：角标挂载点（cardAnchor）是按一组候选
 * 选择器解析出来的，Netflix 重渲染后同一张卡片可能解析到不同的元素，此时
 * 旧角标还留在原处，新角标又挂到新元素上。两个角标都是 absolute + top/left
 * 定位，正好叠在封面同一个角，看起来就是两个「豆」并排。
 */
function findBadges(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`)];
}

/** 移除 root 子树里的全部角标。 */
export function removeBadge(root: HTMLElement): void {
  for (const badge of findBadges(root)) badge.remove();
}

/**
 * 把角标标记为「不要翻译」。
 *
 * 页面翻译类扩展（沉浸式翻译、Google 翻译等）会遍历文本节点做翻译，我们的
 * 「豆」字也在其列 —— 实测沉浸式翻译会把它译成「豆子」，并把译文包在 <font>
 * 里直接插进角标内部，渲染出来就是「豆 豆子 8.4」。
 *
 * translate="no" 是 HTML 标准属性且会被后代继承，notranslate 是 Google 翻译
 * 沿用至今的约定，两者一起用覆盖面最广。CSS 里还有一层兜底，见 badge.css。
 */
function markUntranslatable(badge: HTMLElement): void {
  badge.setAttribute('translate', 'no');
  badge.setAttribute('lang', 'zh-Hans');
}

/** 角标内部结构：一个「豆」字，后面跟评分。 */
function buildContent(badge: HTMLElement): void {
  const logo = document.createElement('span');
  logo.className = 'dbr-logo';
  logo.textContent = '豆';
  const value = document.createElement('span');
  value.className = 'dbr-value';
  // 整体重建而不是增量修补：结构一旦漂移（多出一个 logo 之类），
  // 下一次更新就能自愈，不必依赖"当初是怎么建出来的"。
  badge.replaceChildren(logo, value);
}

/**
 * 新建或就地更新角标。
 *
 * scope 用于跨挂载点去重：传入整张卡片时，会把卡片上其它位置的残留角标一并
 * 清掉，保证一张卡片上任何时候都只有一个角标。
 */
export function upsertBadge(anchor: HTMLElement, options: BadgeOptions, scope?: HTMLElement): void {
  const { variant, position, identity, state } = options;

  const existing = findBadges(scope ?? anchor);
  let badge = existing.find((item) => item.parentElement === anchor);
  // 挂在别处的残留角标全部清掉。
  for (const stale of existing) if (stale !== badge) stale.remove();

  if (!badge) {
    badge = document.createElement('div');
    anchor.append(badge);
  }
  markUntranslatable(badge);
  buildContent(badge);

  if (variant === 'card') {
    // 绝对定位需要一个定位参考系；Netflix 的封面容器不一定有。
    const computed = window.getComputedStyle(anchor);
    if (computed.position === 'static') anchor.style.position = 'relative';
  }

  badge.setAttribute(IDENTITY_ATTR, identity);
  // notranslate 要写进 className：这行会整体重置 class，漏掉它翻译扩展就会
  // 把「豆」译成「豆子」插进来。
  badge.className = `${BADGE_CLASS} notranslate dbr-${variant} dbr-pos-${position} dbr-state-${state.kind}`;
  badge.title = describe(state);

  const value = badge.querySelector<HTMLElement>('.dbr-value');
  if (value) {
    value.textContent =
      state.kind === 'rated' ? state.score.toFixed(1) : state.kind === 'unrated' ? '—' : '';
  }

  if (state.kind === 'rated') badge.classList.add(`dbr-tier-${scoreTier(state.score)}`);

  const url = state.kind === 'rated' || state.kind === 'unrated' ? state.url : null;
  bindOpen(badge, url);
}

/**
 * 绑定点击跳转。卡片上的角标位于 Netflix 自己的 <a> 内部，必须阻止事件
 * 继续冒泡，否则点评分会连带触发 Netflix 的播放跳转。
 */
function bindOpen(badge: HTMLElement, url: string | null): void {
  const existing = (badge as HTMLElement & { _dbrOpen?: (event: Event) => void })._dbrOpen;
  if (existing) {
    badge.removeEventListener('click', existing, true);
    badge.removeEventListener('keydown', existing as EventListener, true);
  }

  if (!url) {
    badge.removeAttribute('role');
    badge.removeAttribute('tabindex');
    return;
  }

  const open = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // 用 div[role=link] 而不是 <a>：卡片外层已经是 <a>，嵌套 <a> 会被浏览器
  // 在解析阶段拆开，反而破坏 Netflix 自己的 DOM。
  badge.setAttribute('role', 'link');
  badge.setAttribute('tabindex', '0');
  badge.addEventListener('click', open, true);
  badge.addEventListener('keydown', open, true);
  (badge as HTMLElement & { _dbrOpen?: (event: Event) => void })._dbrOpen = open;
}
