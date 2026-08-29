import type { StorageArea } from './cache';

/**
 * 退避状态的持久化。
 *
 * MV3 的 service worker 闲置约 30 秒就被回收，重启后所有内存状态归零。退避
 * 记录若不落盘，用户每次停顿后再滚动，扩展都会在豆瓣仍在限流时立刻重新开打，
 * 把限流越打越深 —— 在匿名请求配额本就很紧的前提下，这是最大的一处浪费。
 *
 * 存的是「恢复时刻的绝对时间戳」而不是剩余时长，这样重启后无需知道进程存活
 * 了多久也能算对。
 */

const KEY = 'backoff';

export interface BackoffState {
  /** 豆瓣请求队列的退避恢复时刻。 */
  queue: number;
  /** 豆瓣完整搜索接口自身静默期的恢复时刻。 */
  fullSearch: number;
  /** IMDb 请求队列的退避恢复时刻。两个来源的限流互相独立，各存各的。 */
  imdbQueue: number;
}

const EMPTY: BackoffState = { queue: 0, fullSearch: 0, imdbQueue: 0 };

function asTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export async function loadBackoff(storage: StorageArea): Promise<BackoffState> {
  const stored = (await storage.get([KEY]))[KEY];
  if (typeof stored !== 'object' || stored === null) return EMPTY;
  const record = stored as Record<string, unknown>;
  return {
    queue: asTimestamp(record['queue']),
    fullSearch: asTimestamp(record['fullSearch']),
    imdbQueue: asTimestamp(record['imdbQueue']),
  };
}

/**
 * 只更新其中一项，另一项保持原值。
 *
 * 三处退避是独立触发的，各写各的字段，不能互相覆盖。
 */
export async function saveBackoff(
  storage: StorageArea,
  patch: Partial<BackoffState>,
): Promise<void> {
  const current = await loadBackoff(storage);
  await storage.set({ [KEY]: { ...current, ...patch } });
}
