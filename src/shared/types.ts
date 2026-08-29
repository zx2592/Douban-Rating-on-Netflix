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

/** 一条命中的豆瓣条目。 */
export interface DoubanRating {
  /** 豆瓣条目 id，例如 "35131346"。 */
  id: string;
  /** 豆瓣上的条目标题。 */
  title: string;
  /** 评分，0–10；豆瓣在评价人数过少时不出分，此时为 null。 */
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
  | { status: 'ok'; rating: DoubanRating }
  /** 豆瓣有响应，但没有可信的匹配项。 */
  | { status: 'not_found' }
  /** 用户关掉了开关，或当前站点被禁用。 */
  | { status: 'disabled' }
  /** 网络错误、被限流、解析失败等。retryAfterMs 表示建议多久之后再来。 */
  | { status: 'error'; reason: string; retryAfterMs?: number };
