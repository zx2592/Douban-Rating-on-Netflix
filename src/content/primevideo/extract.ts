import { queryFirst, readFirstText } from '../dom';
import { cleanTitle } from '../netflix/extract';
import { splitSeason } from '../../shared/text';
import type { MediaQuery, MediaType } from '../../shared/types';
import { DETAIL_ROUTE, PRIMEVIDEO_SELECTORS } from './selectors';

/**
 * 从 Prime Video 的 DOM 里读出查询条件。
 *
 * 标题清洗直接复用 Netflix 那份 `cleanTitle`：去零宽字符、折叠空白、
 * 摘掉括号里的年份、剥掉包裹整个标题的引号 —— 这些处理和站点无关，
 * 而且每一条都是从真实数据里长出来的，没有理由再写一份。
 */

/**
 * 把 Prime Video 的 `data-card-entity-type` 归到我们的三种类型。
 *
 * 实测值形如 `"Movie"`。剧集侧的确切取值还没见到，所以用「包含」判断而不是
 * 等值判断 —— 猜错一个字面量会让所有剧集掉回 unknown，而包含判断最差也只是
 * 回到原来的水平。
 */
export function mediaTypeFromEntity(value: string | null): MediaType {
  const text = (value ?? '').toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('movie') || text.includes('film')) return 'movie';
  if (text.includes('tv') || text.includes('show') || text.includes('series') || text.includes('season')) {
    return 'tv';
  }
  return 'unknown';
}

/** 当前是不是详情页。用 URL 判断，不靠 DOM 猜。 */
export function isDetailPage(url: string = location.pathname + location.search): boolean {
  return DETAIL_ROUTE.test(url);
}

/**
 * 从一张列表卡片上提取查询条件。
 *
 * 列表上通常拿不到年份和类型，和 Netflix 的情况一样 —— 匹配器会因此
 * 走收紧后的阈值（88 分），宁可少显示也不配错。
 */
export function extractFromCard(card: HTMLElement): MediaQuery | null {
  // 先确认这真是一张影片卡片。页面上还有大量导航、分类、账号相关的链接，
  // 它们同样是 <a>，拿去查评分纯属浪费配额。
  //
  // 卡片不一定是 <a> 本身：`[data-card-title]` 命中的是卡片容器，链接在它
  // 里面。所以三个方向都找一遍再取 href。
  const link = card.matches('a[href]')
    ? card
    : (card.querySelector<HTMLElement>('a[href]') ?? card.closest<HTMLElement>('a[href]'));
  if (!DETAIL_ROUTE.test(link?.getAttribute('href') ?? '')) return null;

  // 实测排除：aria-hidden 的重复链接、以及播放/操作按钮。它们指向同一个
  // /detail/ 地址，光看 href 和真卡片没有区别，但 aria-label 是「Watch now」
  // 这类动作文案 —— 扩展真的拿它去查过评分。
  if (card.closest('[aria-hidden="true"]')) return null;
  // 操作区里的东西一概不是影片卡片：播放、加入清单、More details。
  // 实测这两类按钮的 aria-label 分别是「Watch now」和「More details for
  // Sing 2」—— 都真的被当成片名查过。
  if (card.closest('[data-testid="action-box"], [data-testid="details-icon"]')) return null;
  if (card.matches('[data-testid="play"], [data-automation-id="play"]')) return null;

  const raw = readFirstText(card, PRIMEVIDEO_SELECTORS.cardTitle);
  if (!raw) return null;

  const cleaned = cleanTitle(raw);
  if (!cleaned.title) return null;

  const season = splitSeason(cleaned.title).season;
  // 列表卡片上通常拿不到年份，但 Prime Video 给了类型 —— 这是 Netflix 那边
  // 没有的信号，能让匹配器分开同名的电影和剧集。
  const type = mediaTypeFromEntity(readFirstText(card, PRIMEVIDEO_SELECTORS.cardType));
  return {
    title: cleaned.title,
    type,
    ...(cleaned.year !== undefined ? { year: cleaned.year } : {}),
    ...(season !== undefined ? { season } : {}),
  };
}

/**
 * 从详情页提取查询条件。
 *
 * Prime Video 的详情是整页跳转，不是 Netflix 那样的悬停弹层，所以这里的
 * "modal" 就是页面本身。**只在 URL 确实是详情页时才返回结果** —— 否则首页的
 * `h1`（多半是「Prime Video」或某个分类名）会被当成片名去查，白费配额，
 * 还可能真配出一个莫名其妙的分数挂在页面上。
 */
export function extractFromDetail(root: HTMLElement): MediaQuery | null {
  if (!isDetailPage()) return null;

  const raw = readFirstText(root, PRIMEVIDEO_SELECTORS.detailTitle);
  if (!raw) return null;

  const cleaned = cleanTitle(raw);
  if (!cleaned.title) return null;

  const metaText = queryFirst(root, PRIMEVIDEO_SELECTORS.detailMeta)?.textContent ?? '';
  const yearMatch = /\b((?:18|19|20)\d{2})\b/.exec(metaText);
  const year = yearMatch ? Number.parseInt(yearMatch[1]!, 10) : cleaned.year;

  const isSeries = queryFirst(root, PRIMEVIDEO_SELECTORS.seriesMarker) !== null;
  const season = splitSeason(cleaned.title).season;

  return {
    title: cleaned.title,
    type: isSeries ? 'tv' : 'unknown',
    ...(year !== undefined ? { year } : {}),
    ...(season !== undefined ? { season } : {}),
  };
}
