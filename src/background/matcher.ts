import { diceCoefficient, normalizeTitle, splitSeason, tokenize } from '../shared/text';
import type { MediaQuery, MediaType } from '../shared/types';

/** 从豆瓣检索接口拿到的一个候选条目，尚未判断是否真的对得上。 */
export interface Candidate {
  id: string;
  /** 豆瓣主标题，通常是中文名。 */
  title: string;
  /** 副标题 / 原名，豆瓣常把外语原名放这里。 */
  originalTitle?: string;
  /** 其它别名。 */
  aliases?: string[];
  year?: number;
  type: MediaType;
  score: number | null;
  votes: number | null;
  url: string;
}

export interface ScoredCandidate {
  candidate: Candidate;
  /** 对外展示用，截断到 0–100。 */
  confidence: number;
  /**
   * 未截断的原始分，用于排序和阈值判断。
   *
   * 排序必须用这个而不是 confidence：标题完全一致就已经 100 分，若在此处截断，
   * 「类型不符」之类的扣分会被一起吃掉，同名的电影和剧集就分不出高下了。
   */
  raw: number;
  /** 便于在调试日志里看清楚是凭什么选中的。 */
  reason: string;
}

/** 标题相似度，0–100。会拿主标题和所有别名逐一比，取最高分。 */
function titleSimilarity(queryTitle: string, candidate: Candidate): { score: number; reason: string } {
  const queryNormalized = normalizeTitle(queryTitle);
  const queryTokens = tokenize(queryTitle);
  if (!queryNormalized) return { score: 0, reason: '查询标题为空' };

  const names: Array<{ value: string; label: string }> = [{ value: candidate.title, label: '主标题' }];
  if (candidate.originalTitle) names.push({ value: candidate.originalTitle, label: '原名' });
  for (const alias of candidate.aliases ?? []) names.push({ value: alias, label: '别名' });

  let best = { score: 0, reason: '无相似项' };
  for (const name of names) {
    // 候选名里也可能带季数后缀（"怪奇物语 第四季"），比标题时先摘掉，
    // 季数在 seasonAdjustment 里单独算分。
    const bare = splitSeason(name.value).base;
    const normalized = normalizeTitle(bare);
    if (!normalized) continue;

    let score: number;
    let reason: string;
    if (normalized === queryNormalized) {
      score = 100;
      reason = `${name.label}完全一致`;
    } else if (normalized.includes(queryNormalized) || queryNormalized.includes(normalized)) {
      // 一方被另一方包含：长度越接近越可信。"蝙蝠侠" vs "蝙蝠侠归来" 应该扣得多。
      const shorter = Math.min(normalized.length, queryNormalized.length);
      const longer = Math.max(normalized.length, queryNormalized.length);
      score = 55 + Math.round(35 * (shorter / longer));
      reason = `${name.label}包含关系`;
    } else {
      score = Math.round(90 * diceCoefficient(queryTokens, tokenize(bare)));
      reason = `${name.label}词重合`;
    }
    if (score > best.score) best = { score, reason };
  }
  return best;
}

/** 年份差异带来的加减分。年份是最有力的消歧信号，所以权重给得重。 */
function yearAdjustment(queryYear: number | undefined, candidateYear: number | undefined): number {
  if (queryYear === undefined || candidateYear === undefined) return 0;
  const diff = Math.abs(queryYear - candidateYear);
  if (diff === 0) return 25;
  // 上映年和豆瓣登记年差一年很常见（跨年上映、地区档期不同），只轻罚。
  if (diff === 1) return 5;
  return -45;
}

function typeAdjustment(queryType: MediaType, candidateType: MediaType): number {
  if (queryType === 'unknown' || candidateType === 'unknown') return 0;
  return queryType === candidateType ? 8 : -25;
}

/**
 * 季数带来的加减分。
 *
 * 豆瓣把剧集按季拆成独立条目，Netflix 的卡片却往往只给剧名。约定：
 * 查询没有季数时视作第一季，因为用户在列表里看到的就是这部剧本身。
 */
function seasonAdjustment(querySeason: number | undefined, candidateSeason: number | undefined): number {
  const wanted = querySeason ?? 1;
  const got = candidateSeason ?? 1;
  if (wanted === got) return querySeason !== undefined && candidateSeason !== undefined ? 12 : 0;
  return -30;
}

/**
 * 没有年份时，标题必须匹配得非常干净才敢用；有年份时可以松一些。
 * 这个阈值直接决定「宁可不显示，也不显示错的分数」这条产品底线。
 */
export const CONFIDENCE_THRESHOLD_WITH_YEAR = 70;
export const CONFIDENCE_THRESHOLD_WITHOUT_YEAR = 88;

/** 给单个候选打分。 */
export function scoreCandidate(query: MediaQuery, candidate: Candidate): ScoredCandidate {
  const querySplit = splitSeason(query.title);
  const querySeason = query.season ?? querySplit.season;
  const candidateSeason = splitSeason(candidate.title).season;

  const title = titleSimilarity(querySplit.base, candidate);
  const adjustments =
    yearAdjustment(query.year, candidate.year) +
    typeAdjustment(query.type, candidate.type) +
    seasonAdjustment(querySeason, candidateSeason);

  const raw = title.score + adjustments;
  return {
    candidate,
    raw,
    confidence: Math.max(0, Math.min(100, raw)),
    reason: `${title.reason}(${title.score}) 调整${adjustments >= 0 ? '+' : ''}${adjustments}`,
  };
}

/**
 * 从候选里挑出最可信的一个；都不够可信就返回 null，宁缺毋滥。
 *
 * 同分时（豆瓣上同名同年的条目并不罕见）选评价人数多的那个，
 * 它几乎总是用户想看的那部。
 */
export function pickBestMatch(query: MediaQuery, candidates: readonly Candidate[]): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  const threshold =
    query.year !== undefined ? CONFIDENCE_THRESHOLD_WITH_YEAR : CONFIDENCE_THRESHOLD_WITHOUT_YEAR;

  let best: ScoredCandidate | null = null;
  for (const candidate of candidates) {
    const scored = scoreCandidate(query, candidate);
    if (scored.raw < threshold) continue;
    if (
      best === null ||
      scored.raw > best.raw ||
      (scored.raw === best.raw && (scored.candidate.votes ?? 0) > (best.candidate.votes ?? 0))
    ) {
      best = scored;
    }
  }
  return best;
}
