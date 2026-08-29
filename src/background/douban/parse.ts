import type { Candidate } from '../matcher';
import type { MediaType } from '../../shared/types';

/**
 * 豆瓣的这几个接口都是站内私有接口，没有契约保证，字段随时可能增删。
 * 所以这里所有解析都写成「宽进严出」：字段缺失或类型不对就跳过这一条，
 * 绝不抛异常把整批结果带崩。
 */

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 从 "2023" 或 "2023 / 中国大陆 / 剧情" 这类串里取出四位年份。 */
export function extractYear(value: unknown): number | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const match = /\b(18|19|20)\d{2}\b/.exec(text);
  if (!match) return undefined;
  const year = Number.parseInt(match[0], 10);
  // 早于电影诞生或远超当下的年份必然是解析错了（比如把集数当成了年份）。
  return year >= 1880 && year <= new Date().getFullYear() + 5 ? year : undefined;
}

/** 豆瓣的评分区间是 0–10，越界值一律当作「没有评分」。 */
export function normalizeScore(value: unknown): number | null {
  const score = asNumber(value);
  if (score === undefined) return null;
  // 豆瓣对评价人数太少的条目返回 0，表示"暂无评分"，不是真的 0 分。
  if (score <= 0 || score > 10) return null;
  return Math.round(score * 10) / 10;
}

function subjectUrl(id: string): string {
  return `https://movie.douban.com/subject/${id}/`;
}

/**
 * subject_suggest 返回的 type 只区分 movie/book/music，剧集也算 movie，
 * 但剧集会带上非空的 episode 字段，用它来区分。
 */
function suggestMediaType(entry: Record<string, unknown>): MediaType {
  const episode = asString(entry['episode']);
  if (episode) return 'tv';
  return 'movie';
}

/**
 * 解析 `https://movie.douban.com/j/subject_suggest?q=...`。
 *
 * 返回的是一个数组，可能混进图书、音乐，这里只保留影视条目。
 * 该接口不返回评分，评分要靠 parseSubjectAbstract 再取一次。
 */
export function parseSuggest(payload: unknown): Candidate[] {
  if (!Array.isArray(payload)) return [];
  const candidates: Candidate[] = [];
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    // type 为 book/music/app 的条目直接丢掉。
    const kind = asString(entry['type']);
    if (kind && kind !== 'movie' && kind !== 'tv') continue;

    const id = asString(entry['id']);
    const title = asString(entry['title']);
    if (!id || !title) continue;

    const subTitle = asString(entry['sub_title']);
    const candidate: Candidate = {
      id,
      title,
      type: suggestMediaType(entry),
      year: extractYear(entry['year']),
      // 豆瓣把外语原名放在 sub_title；和主标题相同时没有额外信息，丢掉。
      ...(subTitle && subTitle !== title ? { originalTitle: subTitle } : {}),
      score: null,
      votes: null,
      // 用 id 自行拼接，不用接口返回的 url：那个 url 上挂着 ?suggest=<原查询词>
      // 的跟踪参数，直接拿来做角标链接会把用户的检索词也带到地址栏里。
      url: subjectUrl(id),
    };
    candidates.push(candidate);
  }
  return candidates;
}

export interface RatingDetail {
  score: number | null;
  votes: number | null;
}

/**
 * 解析 `https://movie.douban.com/j/subject_abstract?subject_id=...`。
 *
 * 这个接口很轻（不到 1KB），是取评分的唯一来源：条目页 HTML 那条路实测会被
 * 豆瓣的风控直接拦掉，用不了。代价是它不返回评价人数。
 *
 * 返回 null 表示「这个响应读不懂」（结构变了），而不是「这部片没有评分」；
 * 后者是 { score: null }。两者在上层的处理完全不同。
 */
export function parseSubjectAbstract(payload: unknown): RatingDetail | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as Record<string, unknown>;

  // 顶层的 r 是结果码，0 表示正常；非 0 时 subject 里的内容不可信。
  const code = asNumber(envelope['r']);
  if (code !== undefined && code !== 0) return null;

  const subject = envelope['subject'];
  if (typeof subject !== 'object' || subject === null) return null;
  const record = subject as Record<string, unknown>;
  // 不同时期这个字段叫 rate 或 rating，两个都认。
  const score = normalizeScore(record['rate'] ?? record['rating']);
  return { score, votes: null };
}
