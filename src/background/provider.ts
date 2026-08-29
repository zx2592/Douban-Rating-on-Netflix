import type { Priority } from './queue';
import type { MediaQuery, Rating, RatingSource } from '../shared/types';

/**
 * 一个评分来源。
 *
 * 抽出这层是因为豆瓣和 IMDb 的取数细节差别很大（豆瓣要两级检索、繁简转换、
 * 软限流识别；IMDb 要在多条候选路径间降级），但它们外面那圈逻辑 —— 缓存、
 * 并发去重、点击优先级、「未收录」的重查与自限、错误分类 —— 一模一样，
 * 而那圈逻辑恰恰是这个项目里最容易出错、也已经被测试覆盖得最厚的部分。
 * 复制一份给 IMDb 等于把那些踩过的坑重新埋一遍。
 *
 * 约定：
 * - 返回 null 表示「站点有响应，但没有可信的匹配项」，这是一个可以缓存的事实；
 * - 限流、网络故障、结构变化一律抛异常，绝不能退化成 null —— 把「暂时拿不到」
 *   写进缓存当成「没有」，是这个项目栽过的最大的一个跟头。
 */
export interface RatingProvider {
  readonly source: RatingSource;
  find(query: MediaQuery, priority: Priority): Promise<Rating | null>;
}
