import type { BadgePosition } from '../shared/settings';
import type { RatingSource } from '../shared/types';

/**
 * 角标的注入与更新。
 *
 * 刻意不用 Shadow DOM：列表页上同时存在几十到上百张卡片，每张都挂一个
 * shadow root 的开销不划算。改为全部 class 加 dbr- 前缀，并对关键样式加
 * !important，避免被 Netflix 自己的样式覆盖。
 *
 * 一个角标里可以并排放多个来源（豆瓣、IMDb……），每个来源是一段
 * `.dbr-part`，各自带自己的 logo、分数、配色和跳转链接。做成"一个角标多段"
 * 而不是"多个角标"，是因为卡片角标是绝对定位的：两个独立角标要各自算位置，
 * 一旦挂载点解析漂移就会叠在一起 —— 这个项目已经为角标重叠排查过一轮了。
 */

export const BADGE_CLASS = 'dbr-badge';
export const PART_CLASS = 'dbr-part';
/** 记录角标当前渲染的是哪部片子，用于识别被 Netflix 复用的卡片。 */
const IDENTITY_ATTR = 'data-dbr-identity';

export type BadgeState =
  | { kind: 'loading' }
  /** 匹配到条目且有评分。 */
  | { kind: 'rated'; score: number; votes: number | null; url: string; title: string }
  /** 匹配到条目，但来源站因评价人数太少还没出分。 */
  | { kind: 'unrated'; url: string; title: string }
  /** 来源站上没有可信的匹配项。 */
  | { kind: 'missing' };

/** 角标里的一段：某一个来源的结果。 */
export interface BadgePart {
  source: RatingSource;
  state: BadgeState;
}

export interface BadgeOptions {
  /** card 用绝对定位压在封面上，modal 跟着元数据行排版。 */
  variant: 'card' | 'modal';
  position: BadgePosition;
  /** 当前卡片对应的影片标识，变了就说明卡片被复用了。 */
  identity: string;
  /** 各来源的结果，**数组顺序就是显示顺序**（豆瓣在前，IMDb 在后）。 */
  parts: BadgePart[];
}

/** 各来源在角标上的短标识与可读名。 */
const SOURCE_LABELS: Record<RatingSource, { logo: string; name: string }> = {
  douban: { logo: '豆', name: '豆瓣' },
  imdb: { logo: 'IMDb', name: 'IMDb' },
};

/** 按分数分档上色：8 分以上是"值得看"的普遍共识。 */
function scoreTier(score: number): string {
  if (score >= 8) return 'high';
  if (score >= 6.5) return 'mid';
  return 'low';
}

function formatVotes(source: RatingSource, votes: number | null): string {
  if (votes === null) return '';
  // IMDb 的票数动辄上百万，用「万」不如用原生的千分位读着顺。
  if (source === 'imdb') return `${votes.toLocaleString('en-US')} 人评分`;
  if (votes >= 10000) return `${(votes / 10000).toFixed(1)} 万人评价`;
  return `${votes} 人评价`;
}

function describe(source: RatingSource, state: BadgeState): string {
  const { name } = SOURCE_LABELS[source];
  switch (state.kind) {
    case 'loading':
      return `正在查询${name}评分`;
    case 'rated': {
      const votes = formatVotes(source, state.votes);
      return `${name} ${state.score.toFixed(1)}${votes ? `（${votes}）` : ''} · ${state.title} · 点击查看条目`;
    }
    case 'unrated':
      return `${name}暂无评分 · ${state.title} · 点击查看条目`;
    case 'missing':
      return `${name}未收录`;
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

/** 建一段：来源标识 + 分数。 */
function buildPart(part: BadgePart): HTMLElement {
  const { source, state } = part;
  const element = document.createElement('span');

  const logo = document.createElement('span');
  logo.className = 'dbr-logo';
  logo.textContent = SOURCE_LABELS[source].logo;

  const value = document.createElement('span');
  value.className = 'dbr-value';
  value.textContent =
    state.kind === 'rated' ? state.score.toFixed(1) : state.kind === 'unrated' ? '—' : '';

  // 整体重建而不是增量修补：结构一旦漂移（多出一个 logo 之类），
  // 下一次更新就能自愈，不必依赖"当初是怎么建出来的"。
  element.replaceChildren(logo, value);

  const tier = state.kind === 'rated' ? ` dbr-tier-${scoreTier(state.score)}` : '';
  element.className = `${PART_CLASS} dbr-src-${source} dbr-state-${state.kind}${tier}`;
  element.title = describe(source, state);

  const url = state.kind === 'rated' || state.kind === 'unrated' ? state.url : null;
  bindOpen(element, url);
  return element;
}

/**
 * 新建或就地更新角标。
 *
 * scope 用于跨挂载点去重：传入整张卡片时，会把卡片上其它位置的残留角标一并
 * 清掉，保证一张卡片上任何时候都只有一个角标。
 */
export function upsertBadge(anchor: HTMLElement, options: BadgeOptions, scope?: HTMLElement): void {
  const { variant, position, identity, parts } = options;

  const existing = findBadges(scope ?? anchor);
  let badge = existing.find((item) => item.parentElement === anchor);
  // 挂在别处的残留角标全部清掉。
  for (const stale of existing) if (stale !== badge) stale.remove();

  // 一段都不显示时不留空壳，否则封面上会剩一个没有内容的小黑块。
  if (parts.length === 0) {
    badge?.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('div');
    anchor.append(badge);
  }
  markUntranslatable(badge);
  badge.replaceChildren(...parts.map(buildPart));

  if (variant === 'card') {
    // 绝对定位需要一个定位参考系；Netflix 的封面容器不一定有。
    const computed = window.getComputedStyle(anchor);
    if (computed.position === 'static') anchor.style.position = 'relative';
  }

  badge.setAttribute(IDENTITY_ATTR, identity);
  // notranslate 要写进 className：这行会整体重置 class，漏掉它翻译扩展就会
  // 把「豆」译成「豆子」插进来。
  badge.className = `${BADGE_CLASS} notranslate dbr-${variant} dbr-pos-${position}`;
}

/**
 * 绑定点击跳转。卡片上的角标位于 Netflix 自己的 <a> 内部，必须阻止事件
 * 继续冒泡，否则点评分会连带触发 Netflix 的播放跳转 —— 现在还多了一层：
 * 点击卡片会被记成「感兴趣」，点角标不该顺带触发那个。
 */
function bindOpen(part: HTMLElement, url: string | null): void {
  if (!url) {
    part.removeAttribute('role');
    part.removeAttribute('tabindex');
    return;
  }

  const open = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // 用 span[role=link] 而不是 <a>：卡片外层已经是 <a>，嵌套 <a> 会被浏览器
  // 在解析阶段拆开，反而破坏 Netflix 自己的 DOM。
  part.setAttribute('role', 'link');
  part.setAttribute('tabindex', '0');
  // 每次更新都是新建的元素，不存在旧监听器需要摘掉。
  part.addEventListener('click', open, true);
  part.addEventListener('keydown', open, true);
}
