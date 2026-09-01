/**
 * 站点适配器共用的 DOM 助手。
 *
 * 这些函数原本长在 netflix/selectors.ts 里。接入 Prime Video 时抽了出来 ——
 * 两个站点的 DOM 知识必须各自独立，但「按一组候选选择器逐个尝试」这个
 * 模式是共通的，而且它正是这个项目应对「商业站点随时改版」的核心手段。
 */

/**
 * 从元素上取文本：attr 为 null 表示读 textContent，否则读该属性。
 *
 * selector 支持三种写法：
 * - `':self'`          —— 取根元素自身。新版 Netflix 把 aria-label 直接放在
 *                         卡片元素上，而 querySelector 只找后代，取不到自己。
 * - `':closest(SEL)'`  —— 沿祖先链往上找。用于 data-uia 挂在封面图而标题在
 *                         外层 <a> 上的情况。
 * - 其它               —— 普通的后代选择器。
 */
export interface TextSource {
  selector: string;
  attr: string | null;
}

/** 依次尝试一组选择器，返回第一个命中的元素。 */
export function queryFirst(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    const found = root.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return null;
}

function resolveSource(root: ParentNode, selector: string): HTMLElement | null {
  if (selector === ':self') return root instanceof HTMLElement ? root : null;
  const closest = /^:closest\((.+)\)$/.exec(selector);
  if (closest) {
    return root instanceof Element ? root.closest<HTMLElement>(closest[1]!) : null;
  }
  return root.querySelector<HTMLElement>(selector);
}

/** 依次尝试一组文本来源，返回第一个非空的文本。 */
export function readFirstText(root: ParentNode, sources: readonly TextSource[]): string | null {
  for (const source of sources) {
    const element = resolveSource(root, source.selector);
    if (!element) continue;
    const raw = source.attr === null ? element.textContent : element.getAttribute(source.attr);
    const text = raw?.trim();
    if (text) return text;
  }
  return null;
}

/** 把一组选择器拼成一条，用于一次性扫描整页。 */
export function joinSelectors(selectors: readonly string[]): string {
  return selectors.join(', ');
}
