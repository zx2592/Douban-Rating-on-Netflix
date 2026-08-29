import { describe, expect, it } from 'vitest';
import { loadBackoff, saveBackoff } from '../src/background/backoff-store';
import type { StorageArea } from '../src/background/cache';

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

describe('退避状态持久化', () => {
  it('没存过时返回全零', async () => {
    expect(await loadBackoff(memoryStorage())).toEqual({ queue: 0, fullSearch: 0, imdbQueue: 0 });
  });

  it('存了能读回来', async () => {
    const storage = memoryStorage();
    await saveBackoff(storage, { queue: 1_700_000_000_000 });
    expect((await loadBackoff(storage)).queue).toBe(1_700_000_000_000);
  });

  it('各项互不覆盖', async () => {
    // 三处退避是独立触发的，各写各的字段。豆瓣被限流不该把 IMDb 的
    // 退避记录抹掉 —— 两个来源的限流本来就是各算各的。
    const storage = memoryStorage();
    await saveBackoff(storage, { queue: 111 });
    await saveBackoff(storage, { fullSearch: 222 });
    await saveBackoff(storage, { imdbQueue: 333 });
    expect(await loadBackoff(storage)).toEqual({ queue: 111, fullSearch: 222, imdbQueue: 333 });
  });

  it('存储里的脏数据不会让读取崩掉', async () => {
    const storage = memoryStorage();
    storage.data.set('backoff', 'not an object');
    expect(await loadBackoff(storage)).toEqual({ queue: 0, fullSearch: 0, imdbQueue: 0 });

    storage.data.set('backoff', { queue: 'nope', fullSearch: -5 });
    expect(await loadBackoff(storage)).toEqual({ queue: 0, fullSearch: 0, imdbQueue: 0 });
  });
});
