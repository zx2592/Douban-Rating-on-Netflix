/**
 * 串行 + 限速的请求队列。
 *
 * 豆瓣对高频访问很敏感，一旦被判定为爬虫会返回 403 或跳验证码页，而且
 * 是按 IP 封的 —— 代价由用户承担。所以这里的默认策略偏保守：全局并发 1、
 * 每次请求之间至少间隔 1.2 秒，被限流后指数退避。
 */

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`豆瓣暂时限流，${Math.ceil(retryAfterMs / 1000)} 秒后重试`);
    this.name = 'RateLimitedError';
  }
}

export interface QueueOptions {
  /** 两次请求之间的最小间隔。 */
  minIntervalMs?: number;
  /** 在最小间隔上叠加的随机抖动，避免形成规律的固定节奏。 */
  jitterMs?: number;
  /** 首次被限流后的退避时长。 */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** 队列里最多堆积多少个待执行任务，超出直接拒绝，避免快速滚动时无限堆积。 */
  maxPending?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface QueueItem {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestQueue {
  private readonly minIntervalMs: number;
  private readonly jitterMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private readonly items: QueueItem[] = [];
  private draining = false;
  /**
   * 初值取负无穷，让冷启动后的第一个请求立刻发出。
   * MV3 的 service worker 被回收得很频繁，若从 0 起算，每次重启都要白等一个间隔。
   */
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private backoffUntilAt = 0;
  private currentBackoffMs = 0;

  constructor(options: QueueOptions = {}) {
    // 实测豆瓣对检索接口的匿名配额比预估紧得多：同一组查询词几分钟前还能
    // 全部命中，反复测试之后就整体落空（suggest 返回空数组、完整搜索返回
    // error_info「搜索访问太频繁」）。间隔宁可放宽 —— 慢一点出分，远好过
    // 把配额打穿之后整页都没有分。
    this.minIntervalMs = options.minIntervalMs ?? 2500;
    this.jitterMs = options.jitterMs ?? 800;
    this.initialBackoffMs = options.initialBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
    this.maxPending = options.maxPending ?? 40;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** 正处于退避期时返回恢复时间戳，否则返回 null。 */
  get backoffUntil(): number | null {
    return this.backoffUntilAt > this.now() ? this.backoffUntilAt : null;
  }

  get pending(): number {
    return this.items.length;
  }

  /**
   * 排入一个请求。若当前正被限流，立即以 RateLimitedError 拒绝而不是排队等待
   * —— 用户还在滚动页面，与其让他等半分钟，不如让这张卡片这轮先空着。
   */
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const backoffUntil = this.backoffUntil;
    if (backoffUntil !== null) {
      return Promise.reject(new RateLimitedError(backoffUntil - this.now()));
    }
    if (this.items.length >= this.maxPending) {
      return Promise.reject(new Error('请求队列已满'));
    }
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  /** 收到 403/429 时调用，进入或加深退避。 */
  noteRateLimited(retryAfterMs?: number): void {
    const next =
      retryAfterMs ??
      (this.currentBackoffMs === 0
        ? this.initialBackoffMs
        : Math.min(this.currentBackoffMs * 2, this.maxBackoffMs));
    this.currentBackoffMs = Math.min(next, this.maxBackoffMs);
    this.backoffUntilAt = this.now() + this.currentBackoffMs;

    // 已经排队的任务不必再去撞墙，一并拒掉。
    const queued = this.items.splice(0, this.items.length);
    for (const item of queued) item.reject(new RateLimitedError(this.currentBackoffMs));
  }

  /** 请求成功后调用，解除退避并重置退避步长。 */
  noteSuccess(): void {
    this.currentBackoffMs = 0;
    this.backoffUntilAt = 0;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift()!;
        const gap = this.minIntervalMs + Math.floor(this.random() * this.jitterMs);
        const waitFor = this.lastStartedAt + gap - this.now();
        if (waitFor > 0) await this.sleep(waitFor);

        this.lastStartedAt = this.now();
        try {
          item.resolve(await item.run());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
