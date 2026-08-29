import { describe, expect, it } from 'vitest';
import type { StorageArea } from '../src/background/cache';
import { InterestStore, interestKey } from '../src/background/interest';
import type { MediaQuery } from '../src/shared/types';

function memoryStorage(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      const result: Record<string, unknown> = {};
      for (const key of list) if (data.has(key)) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
}

/** 可控时钟，用来跨越冷却窗口而不必真的等半小时。 */
function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

const card: MediaQuery = { title: 'Breaking Bad', type: 'unknown' };
/** 同一部片从详情弹层看到的样子：多了年份和类型。 */
const modal: MediaQuery = { title: 'breaking bad', year: 2008, type: 'tv' };

describe('interestKey', () => {
  it('列表卡片和详情弹层落在同一个键上', () => {
    // 卡片上拿不到年份和类型，弹层上两者都有。键若把它们算进去，
    // 「点卡片」和「弹层查询」就会对不上，兴趣信号等于白记。
    expect(interestKey(card)).toBe(interestKey(modal));
  });

  it('不同季分开记', () => {
    expect(interestKey({ title: '毛骨悚然 第二季', type: 'tv' })).not.toBe(
      interestKey({ title: '毛骨悚然 第三季', type: 'tv' }),
    );
  });
});

describe('InterestStore', () => {
  it('首次记录返回 true 并落盘', async () => {
    const time = clock();
    const store = new InterestStore(memoryStorage(), time.now);

    expect(await store.mark(card)).toBe(true);
    expect(await store.interestedAt(card)).toBe(time.now());
    expect(await store.size()).toBe(1);
  });

  it('从卡片记录的兴趣，用弹层的查询条件也能读到', async () => {
    const store = new InterestStore(memoryStorage(), clock().now);
    await store.mark(card);
    expect(await store.interestedAt(modal)).not.toBeNull();
  });

  it('冷却期内重复点击不刷新时间戳', async () => {
    const time = clock();
    const store = new InterestStore(memoryStorage(), time.now);

    await store.mark(card);
    const first = await store.interestedAt(card);

    time.advance(5 * 60_000);
    // 返回 false 是关键：调用方据此决定不重查，否则连点几下就是几次请求。
    expect(await store.mark(card)).toBe(false);
    expect(await store.interestedAt(card)).toBe(first);
  });

  it('冷却期过后再点击会刷新时间戳', async () => {
    const time = clock();
    const store = new InterestStore(memoryStorage(), time.now);

    await store.mark(card);
    time.advance(31 * 60_000);

    expect(await store.mark(card)).toBe(true);
    expect(await store.interestedAt(card)).toBe(time.now());
  });

  it('没记录过的片子返回 null', async () => {
    const store = new InterestStore(memoryStorage(), clock().now);
    expect(await store.interestedAt(card)).toBeNull();
  });

  it('空标题不记录', async () => {
    const store = new InterestStore(memoryStorage(), clock().now);
    expect(await store.mark({ title: '   ', type: 'unknown' })).toBe(false);
    expect(await store.size()).toBe(0);
  });

  it('超出上限后丢掉最老的记录，保住最新的', async () => {
    const time = clock();
    const store = new InterestStore(memoryStorage(), time.now);

    for (let i = 0; i < 205; i += 1) {
      await store.mark({ title: `Film ${i}`, type: 'unknown' });
      time.advance(60 * 60_000);
    }

    expect(await store.size()).toBe(200);
    expect(await store.interestedAt({ title: 'Film 0', type: 'unknown' })).toBeNull();
    expect(await store.interestedAt({ title: 'Film 204', type: 'unknown' })).not.toBeNull();
  });

  it('存储里的脏数据不会让读取炸掉', async () => {
    const storage = memoryStorage();
    storage.data.set('interest', { good: 123, bad: 'nope', worse: null });
    const store = new InterestStore(storage, clock().now);

    expect(await store.size()).toBe(1);
  });

  it('clear 清空全部记录', async () => {
    const store = new InterestStore(memoryStorage(), clock().now);
    await store.mark(card);
    await store.clear();
    expect(await store.size()).toBe(0);
  });
});
