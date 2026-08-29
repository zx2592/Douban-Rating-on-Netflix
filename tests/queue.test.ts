import { describe, expect, it } from 'vitest';
import { RateLimitedError, RequestQueue } from '../src/background/queue';

/**
 * 用虚拟时钟测试：sleep 不真的等待，只把时钟往前拨，所以限速逻辑可以在
 * 毫秒内验证完，而不用真的等上几秒。
 */
function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('RequestQueue 限速', () => {
  it('按最小间隔串行执行，不并发', () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      minIntervalMs: 1000,
      jitterMs: 0,
      random: () => 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    const startedAt: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      startedAt.push(clock.now());
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return 'done';
    };

    const all = Promise.all([queue.enqueue(task), queue.enqueue(task), queue.enqueue(task)]);

    return all.then((results) => {
      expect(results).toEqual(['done', 'done', 'done']);
      expect(maxConcurrent).toBe(1);
      // 第一个立即执行，之后每个都要等满一个间隔。
      expect(startedAt).toEqual([0, 1000, 2000]);
    });
  });

  it('抖动会叠加在最小间隔之上', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      minIntervalMs: 1000,
      jitterMs: 400,
      random: () => 0.5,
      now: clock.now,
      sleep: clock.sleep,
    });

    const startedAt: number[] = [];
    const task = async () => {
      startedAt.push(clock.now());
    };
    await Promise.all([queue.enqueue(task), queue.enqueue(task)]);
    expect(startedAt).toEqual([0, 1200]);
  });

  it('任务抛出的异常原样传给调用方，且不卡住后续任务', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({ minIntervalMs: 0, jitterMs: 0, now: clock.now, sleep: clock.sleep });

    const failed = queue.enqueue(async () => {
      throw new Error('豆瓣返回 HTTP 500');
    });
    const succeeded = queue.enqueue(async () => 'ok');

    await expect(failed).rejects.toThrow('豆瓣返回 HTTP 500');
    await expect(succeeded).resolves.toBe('ok');
  });

  it('队列堆积超过上限时直接拒绝', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      minIntervalMs: 1000,
      jitterMs: 0,
      maxPending: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    // 第一个会立刻被取出执行，所以还能再排两个，第四个开始被拒。
    const never = new Promise<void>(() => {});
    void queue.enqueue(() => never);
    void queue.enqueue(() => never);
    void queue.enqueue(() => never);
    await expect(queue.enqueue(async () => 'x')).rejects.toThrow('请求队列已满');
  });
});

describe('RequestQueue 退避', () => {
  it('被限流后新的请求立即被拒，而不是排队干等', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({ initialBackoffMs: 30_000, now: clock.now, sleep: clock.sleep });

    queue.noteRateLimited();
    await expect(queue.enqueue(async () => 'x')).rejects.toBeInstanceOf(RateLimitedError);
    expect(queue.backoffUntil).toBe(30_000);
  });

  it('限流时把已经排队的任务一并拒掉，避免继续撞墙', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      minIntervalMs: 1000,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    const blocking = new Promise<void>(() => {});
    void queue.enqueue(() => blocking);
    const queued = queue.enqueue(async () => 'x');

    queue.noteRateLimited();
    await expect(queued).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('连续被限流时退避时长指数增长，并有上限', () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      initialBackoffMs: 1000,
      maxBackoffMs: 4000,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(1000);
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(2000);
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(4000);
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(4000);
  });

  it('服务端给了 Retry-After 就听服务端的', () => {
    const clock = virtualClock();
    const queue = new RequestQueue({ initialBackoffMs: 30_000, now: clock.now, sleep: clock.sleep });
    queue.noteRateLimited(5000);
    expect(queue.backoffUntil).toBe(5000);
  });

  it('退避期过去之后自动恢复', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      initialBackoffMs: 1000,
      minIntervalMs: 0,
      jitterMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.noteRateLimited();
    clock.advance(1001);
    expect(queue.backoffUntil).toBeNull();
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('一次成功就把退避步长重置，下次限流重新从初始值算起', () => {
    const clock = virtualClock();
    const queue = new RequestQueue({
      initialBackoffMs: 1000,
      maxBackoffMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.noteRateLimited();
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(2000);

    queue.noteSuccess();
    expect(queue.backoffUntil).toBeNull();

    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(clock.now() + 1000);
  });
});

describe('退避跨 service worker 重启存活', () => {
  it('进入退避时通过回调把恢复时刻交出去', () => {
    const clock = virtualClock();
    const saved: number[] = [];
    const queue = new RequestQueue({
      initialBackoffMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
      onBackoffChange: (until) => saved.push(until),
    });

    queue.noteRateLimited();
    expect(saved).toEqual([30_000]);
  });

  it('解除退避时通知一次，但成功请求不会每次都写', () => {
    const clock = virtualClock();
    const saved: number[] = [];
    const queue = new RequestQueue({
      now: clock.now,
      sleep: clock.sleep,
      onBackoffChange: (until) => saved.push(until),
    });

    // 没进过退避时的成功请求不该产生写入。
    queue.noteSuccess();
    expect(saved).toEqual([]);

    queue.noteRateLimited();
    queue.noteSuccess();
    queue.noteSuccess();
    // 一次进入 + 一次解除，第二次成功不再重复写。
    expect(saved).toHaveLength(2);
    expect(saved[1]).toBe(0);
  });

  it('重启后恢复退避，仍在期内的请求照样被拒', async () => {
    // 不恢复的话，worker 每次冷启动都会在豆瓣仍限流时立刻重新开打。
    const clock = virtualClock();
    const queue = new RequestQueue({ now: clock.now, sleep: clock.sleep });

    queue.restoreBackoff(30_000);
    expect(queue.backoffUntil).toBe(30_000);
    await expect(queue.enqueue(async () => 'x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('恢复已经过期的退避等于没有退避', async () => {
    const clock = virtualClock();
    const queue = new RequestQueue({ minIntervalMs: 0, jitterMs: 0, now: clock.now, sleep: clock.sleep });

    clock.advance(50_000);
    queue.restoreBackoff(30_000);
    expect(queue.backoffUntil).toBeNull();
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('恢复后继续被限流时，退避从当前深度接着翻倍', () => {
    // 退回初始值重新来过的话，反复重启会让退避永远长不起来。
    const clock = virtualClock();
    const queue = new RequestQueue({
      initialBackoffMs: 1000,
      maxBackoffMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.restoreBackoff(8000);
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(16_000);
  });
});

describe('RequestQueue 优先级', () => {
  /** 只排队不执行的队列：任务全部堆在队里，方便观察出队顺序。 */
  function pausedQueue() {
    const clock = virtualClock();
    const queue = new RequestQueue({
      minIntervalMs: 1000,
      jitterMs: 0,
      random: () => 0,
      now: clock.now,
      sleep: clock.sleep,
    });
    return queue;
  }

  it('高优先级插到普通任务前面', async () => {
    const queue = pausedQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
    };

    const all = [
      queue.enqueue(task('n1')),
      queue.enqueue(task('n2')),
      queue.enqueue(task('n3')),
      queue.enqueue(task('h1'), 'high'),
    ];
    await Promise.all(all);

    // n1 已经被 drain 取走开跑了，插队只能影响还在队里的 n2/n3。
    expect(order).toEqual(['n1', 'h1', 'n2', 'n3']);
  });

  it('同为高优先级时保持先来先服务', async () => {
    const queue = pausedQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
    };

    const all = [
      queue.enqueue(task('n1')),
      queue.enqueue(task('n2')),
      queue.enqueue(task('h1'), 'high'),
      queue.enqueue(task('h2'), 'high'),
      queue.enqueue(task('h3'), 'high'),
    ];
    await Promise.all(all);

    // 连点几部片时，若高优先级之间也互相插队，先点的那部反而最后出分。
    expect(order).toEqual(['n1', 'h1', 'h2', 'h3', 'n2']);
  });

  it('不传优先级时按普通处理，顺序不变', async () => {
    const queue = pausedQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
    };

    await Promise.all([queue.enqueue(task('a')), queue.enqueue(task('b')), queue.enqueue(task('c'))]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
