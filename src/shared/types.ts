/** 影片类型。Netflix 卡片上通常无法区分，故允许 unknown。 */
export type MediaType = 'movie' | 'tv' | 'unknown';

/** 内容脚本从页面上提取出来的、用于检索豆瓣的查询条件。 */
export interface MediaQuery {
  /** 页面上显示的标题，可能是中文、英文或其它语言。 */
  title: string;
  /** 上映年份，Netflix 列表卡片上通常拿不到，详情弹层里才有。 */
  year?: number;
  type: MediaType;
  /** 从标题里解析出的季数（"第二季" / "Season 2"），用于在豆瓣的分季条目里挑对的那个。 */
  season?: number;
}

/** 支持的流媒体站点。 */
export type SiteId = 'netflix' | 'primevideo';

/** 评分来源。加新站点时在这里扩展。 */
export type RatingSource = 'douban' | 'imdb';

/** 一条命中的评分条目。 */
export interface Rating {
  source: RatingSource;
  /** 来源站内的条目 id：豆瓣是数字串，IMDb 是 "tt0903747" 这样的串。 */
  id: string;
  /** 来源站上的条目标题。 */
  title: string;
  /**
   * 评分，统一归一到 0–10。
   *
   * 豆瓣和 IMDb 恰好都用 10 分制，所以这里不需要换算；真要接入 5 分制的
   * 站点时，换算必须在各自的 provider 里做完，这一层只认 0–10。
   * 评价人数过少而站点不出分时为 null。
   */
  score: number | null;
  /** 评价人数，未知为 null。 */
  votes: number | null;
  year?: number;
  type: MediaType;
  /** 条目页地址，点击角标跳转。 */
  url: string;
  /** 匹配置信度 0–100，便于调试与后续调阈值。 */
  confidence: number;
}

/** 一次查询的结果。 */
export type LookupOutcome =
  | { status: 'ok'; rating: Rating }
  /** 来源站有响应，但没有可信的匹配项。 */
  | { status: 'not_found' }
  /** 用户关掉了开关，或这个来源被禁用。 */
  | { status: 'disabled' }
  /** 网络错误、被限流、解析失败等。retryAfterMs 表示建议多久之后再来。 */
  | { status: 'error'; reason: string; retryAfterMs?: number };

/**
 * 一次查询里各来源的结果。
 *
 * 各来源相互独立：豆瓣被限流不影响 IMDb 出分，反之亦然。任一来源关闭时
 * 是 disabled，内容脚本据此不渲染那一段。
 */
export type RatingsOutcome = Record<RatingSource, LookupOutcome>;
