import { pickBestMatch, scoreCandidate, type Candidate, type ScoredCandidate } from '../matcher';
import { comparableScripts, splitSeason } from '../../shared/text';
import type { MediaQuery } from '../../shared/types';

/**
 * IMDb 的候选匹配。
 *
 * 为什么不能直接用通用匹配器，有两个实测出来的原因：
 *
 * 1. **IMDb 用中文片名能搜到，但返回的是英文标题。** 查「鱿鱼游戏」，
 *    命中的条目是 `{"l":"Squid Game","y":2021,"qid":"tvSeries"}`。拿
 *    「鱿鱼游戏」和「Squid Game」算词重合是 0 分，加上年份和类型的加分也
 *    远够不到阈值 —— 结果就是搜索成功了、评分却被自己扔掉。中文界面的
 *    用户会一个 IMDb 分都看不到。
 * 2. **IMDb 一部剧只有一个条目，不按季拆。** 豆瓣是按季拆的，所以通用
 *    匹配器会对「季数对不上」重罚 30 分。放到 IMDb 上，「怪奇物语 第四季」
 *    对上那部剧本身才是正确答案，不该扣分。
 */

/** 跨语种匹配时给出的基础置信度。低于同语种，但足以过展示门槛。 */
const CROSS_SCRIPT_BASE = 70;

/**
 * 把查询改写成适合 IMDb 的形态：去掉季数后缀。
 *
 * IMDb 上一部剧就是一个条目，季数不参与匹配。
 */
function forImdb(query: MediaQuery): MediaQuery {
  const base = splitSeason(query.title).base.trim() || query.title;
  const { season: _season, ...rest } = query;
  return { ...rest, title: base };
}

export function pickImdbMatch(query: MediaQuery, candidates: readonly Candidate[]): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  const adapted = forImdb(query);

  // 先走通用打分。英文界面、以及 IMDb 恰好返回了同语种标题时，走的都是这条。
  const standard = pickBestMatch(adapted, candidates);
  if (standard) return standard;

  return pickCrossScript(adapted, candidates);
}

/**
 * 跨语种回退：查询是中文、候选是英文，字面无从比起时怎么办。
 *
 * 依据换成「IMDb 自己的检索排序」——它认得中文别名，命中就排在第一。
 * 但这个信号比字面匹配弱，所以卡得很紧：
 *
 * - **只认第一名。** 排在后面的是相关作品（同系列、衍生剧），不是同一部片。
 *   「Breaking Bad」那次返回 8 条，第二条是系列条目、第三条是《续命之徒》。
 * - **类型必须相容。** 电影不能配到剧集上。
 * - **有年份就必须对得上。** 详情弹层里能拿到年份，那是最有力的旁证。
 *
 * 仍然守着「宁可不显示，也不显示错的分数」：任何一条不满足就返回 null。
 */
function pickCrossScript(query: MediaQuery, candidates: readonly Candidate[]): ScoredCandidate | null {
  const top = candidates[0];
  if (!top) return null;

  // 字面本来就可比时不适用这条回退 —— 那种情况是真的没匹配上。
  if (comparableScripts(query.title, top.title)) return null;

  if (query.type !== 'unknown' && top.type !== 'unknown' && query.type !== top.type) return null;

  if (query.year !== undefined) {
    // 年份是最有力的旁证，有就必须对得上（容 1 年，跨年上映很常见）。
    if (top.year === undefined) return null;
    if (Math.abs(query.year - top.year) > 1) return null;
  }

  const yearBonus = query.year !== undefined && query.year === top.year ? 15 : 0;
  const typeBonus = query.type !== 'unknown' && query.type === top.type ? 8 : 0;
  const confidence = Math.min(100, CROSS_SCRIPT_BASE + yearBonus + typeBonus);

  return {
    candidate: top,
    confidence,
    raw: confidence,
    reason: `跨语种：IMDb 检索首位（${top.title}）`,
  };
}

/** 诊断页用：把每个候选的判定过程摊开。 */
export function explainImdbCandidates(
  query: MediaQuery,
  candidates: readonly Candidate[],
): Array<{ candidate: Candidate; scored: ScoredCandidate }> {
  const adapted = forImdb(query);
  return candidates.map((candidate) => ({ candidate, scored: scoreCandidate(adapted, candidate) }));
}
