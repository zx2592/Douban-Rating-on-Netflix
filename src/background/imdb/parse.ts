import type { Candidate } from '../matcher';
import type { MediaType } from '../../shared/types';

/**
 * IMDb 侧的响应解析。
 *
 * 和豆瓣那边一样，用的都是 IMDb 站内自用的私有接口，没有契约保证。所以解析
 * 一律「宽进严出」：字段缺失或类型不对就跳过这一条，绝不抛异常把整批结果
 * 带崩。区别只在于 IMDb 的字段名极短（l/y/q/i），可读性差，含义都写在下面。
 */

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // IMDb 的票数在 JSON-LD 里可能带千分位逗号。
    const parsed = Number.parseFloat(value.replace(/,/g, '').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** IMDb 条目 id 的形态：tt 加若干位数字。 */
export function isTitleId(value: unknown): value is string {
  return typeof value === 'string' && /^tt\d{5,}$/.test(value.trim());
}

export function titleUrl(id: string): string {
  return `https://www.imdb.com/title/${id}/`;
}

/** IMDb 是 10 分制，和豆瓣一致，越界值一律当作「没有评分」。 */
export function normalizeScore(value: unknown): number | null {
  const score = asNumber(value);
  if (score === undefined) return null;
  if (score <= 0 || score > 10) return null;
  return Math.round(score * 10) / 10;
}

/**
 * 把 IMDb 的 qid 归到我们的三种类型。
 *
 * qid 的取值形如 movie / tvSeries / tvMiniSeries / tvMovie / short /
 * videoGame / musicVideo。凡是以 tv 开头又不是 tvMovie 的都按剧集算；
 * 电子游戏和音乐录影带明确排除掉 —— Netflix 上确实有云游戏卡片，
 * 拿游戏名去 IMDb 能搜到同名条目，配到影片上就是错的。
 */
export function mediaTypeFromQid(qid: unknown): MediaType | null {
  const value = asString(qid);
  if (!value) return 'unknown';
  if (value === 'videoGame' || value === 'musicVideo') return null;
  if (value === 'tvMovie') return 'movie';
  if (value.startsWith('tv')) return 'tv';
  if (value === 'movie' || value === 'short' || value === 'video') return 'movie';
  return 'unknown';
}

/**
 * 解析 IMDb 的下拉建议接口。
 *
 * 返回形如 `{"d":[{"id":"tt0903747","l":"Breaking Bad","q":"TV series",
 * "qid":"tvSeries","y":2008,"yr":"2008-2013","s":"Bryan Cranston, ..."}]}`：
 * l = label（标题），y = year，qid = 类型，s = 主演。
 *
 * 这个接口不带评分，命中之后要再取一次分。
 */
export function parseSuggestion(payload: unknown): Candidate[] {
  const entries = (payload as { d?: unknown })?.d;
  if (!Array.isArray(entries)) return [];

  const candidates: Candidate[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    const id = asString(entry['id']);
    // 建议接口里混着人名条目（nm 开头）和其它东西，只要影视条目。
    if (!id || !isTitleId(id)) continue;

    const title = asString(entry['l']);
    if (!title) continue;

    const type = mediaTypeFromQid(entry['qid']);
    // 游戏 / 音乐录影带：明确排除，不是「类型未知」。
    if (type === null) continue;

    const year = asNumber(entry['y']);
    candidates.push({
      id,
      title,
      ...(year !== undefined ? { year } : {}),
      type,
      // 建议接口不给评分，由上层补一次。
      score: null,
      votes: null,
      url: titleUrl(id),
    });
  }
  return candidates;
}

export interface RatingDetail {
  score: number | null;
  votes: number | null;
}

/**
 * 从 GraphQL 响应里取评分。
 *
 * 形如 `{"data":{"title":{"ratingsSummary":{"aggregateRating":9.5,
 * "voteCount":2200000}}}}`。结构对不上返回 null，由上层换下一条路径。
 */
export function parseGraphqlRating(payload: unknown): RatingDetail | null {
  const summary = (payload as { data?: { title?: { ratingsSummary?: unknown } } })?.data?.title
    ?.ratingsSummary;
  if (typeof summary !== 'object' || summary === null) return null;

  const record = summary as Record<string, unknown>;
  // aggregateRating 缺失是有效结果（票数太少时 IMDb 不出分），
  // 但整个 ratingsSummary 都没有就说明结构变了。
  if (!('aggregateRating' in record) && !('voteCount' in record)) return null;

  const votes = asNumber(record['voteCount']);
  return { score: normalizeScore(record['aggregateRating']), votes: votes ?? null };
}

/**
 * 从条目页 HTML 里的 JSON-LD 取评分。
 *
 * IMDb 的条目页带一段 `<script type="application/ld+json">`，里面有
 * `aggregateRating: { ratingValue, ratingCount }`。这条路径重（要下整页
 * HTML），是 GraphQL 不可用时的兜底。
 */
export function parseJsonLdRating(html: string): RatingDetail | null {
  for (const block of extractJsonLdBlocks(html)) {
    let payload: unknown;
    try {
      payload = JSON.parse(block);
    } catch {
      continue;
    }
    const aggregate = (payload as { aggregateRating?: unknown })?.aggregateRating;
    if (typeof aggregate !== 'object' || aggregate === null) continue;

    const record = aggregate as Record<string, unknown>;
    const votes = asNumber(record['ratingCount']);
    return { score: normalizeScore(record['ratingValue']), votes: votes ?? null };
  }
  return null;
}

/** 取出页面里所有 JSON-LD 块的原始文本。 */
function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}
