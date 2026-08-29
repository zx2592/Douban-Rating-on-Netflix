import { describe, expect, it, vi } from 'vitest';
import { DoubanClient } from '../src/background/douban/client';
import { RateLimitedError, RequestQueue } from '../src/background/queue';

function fastQueue(): RequestQueue {
  return controllableQueue().queue;
}

/** 需要拨动时钟的用例用这个，能拿到 advance。 */
function controllableQueue(options: { initialBackoffMs?: number } = {}) {
  let time = 0;
  const queue = new RequestQueue({
    minIntervalMs: 0,
    jitterMs: 0,
    initialBackoffMs: options.initialBackoffMs ?? 30_000,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  return {
    queue,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

function fakeResponse(
  body: string,
  init: { status?: number; url?: string; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: init.url ?? 'https://www.douban.com/j/subject_suggest',
    headers: new Headers(init.headers ?? {}),
    text: async () => body,
  } as unknown as Response;
}

const SUGGEST_BODY = JSON.stringify([
  {
    id: '35131346',
    title: '河边的错误',
    sub_title: 'Only the River Flows',
    type: 'movie',
    year: '2023',
    episode: '',
    url: 'https://movie.douban.com/subject/35131346/',
  },
]);

describe('DoubanClient.search', () => {
  it('解析检索结果', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(SUGGEST_BODY));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    const candidates = await client.search('河边的错误');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('35131346');
  });

  it('对查询词做 URL 编码', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse('[]'));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.search('河边的错误');
    expect(fetchImpl.mock.calls[0]![0]).toContain(encodeURIComponent('河边的错误'));
  });

  it('不携带 cookie，避免以用户身份访问豆瓣', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse('[]'));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.search('测试');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('返回的不是 JSON 时报错而不是崩溃', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('<html>登录页</html>'));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toThrow('非预期内容');
  });
});

describe('DoubanClient 风控识别', () => {
  it('403 会让队列进入退避', async () => {
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () => fakeResponse('', { status: 403 }));
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toBeInstanceOf(RateLimitedError);
    expect(queue.backoffUntil).not.toBeNull();
  });

  it('429 带 Retry-After 时按服务端给的时长退避', async () => {
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () =>
      fakeResponse('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toBeInstanceOf(RateLimitedError);
    expect(queue.backoffUntil).toBe(120_000);
  });

  it('状态码 200 但内容是验证页时同样识别为限流', async () => {
    // 豆瓣的反爬页返回的是 200，只看状态码会把它当成正常响应。
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () =>
      fakeResponse('<html><script>window.location.href="https://sec.douban.com/x"</script></html>'),
    );
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toBeInstanceOf(RateLimitedError);
    expect(queue.backoffUntil).not.toBeNull();
  });

  it('被重定向到 sec.douban.com 也算限流', async () => {
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () =>
      fakeResponse('{}', { url: 'https://sec.douban.com/verify' }),
    );
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('退避到期后成功一次，退避步长会被重置', async () => {
    const { queue, advance, now } = controllableQueue({ initialBackoffMs: 1000 });
    // 连续两次限流把步长翻倍到 2000。
    queue.noteRateLimited();
    queue.noteRateLimited();
    advance(2001);

    const fetchImpl = vi.fn(async () => fakeResponse('[]'));
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search('测试');
    expect(queue.backoffUntil).toBeNull();

    // 成功之后再被限流，应该从初始值重新算起，而不是继续翻倍。
    queue.noteRateLimited();
    expect(queue.backoffUntil).toBe(now() + 1000);
  });

  it('HTTP 500 报错但不触发退避（不是限流）', async () => {
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () => fakeResponse('', { status: 500 }));
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toThrow('HTTP 500');
    expect(queue.backoffUntil).toBeNull();
  });
});

describe('DoubanClient.fetchRating 的降级链', () => {
  it('subject_abstract 可用时只发一次请求', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(JSON.stringify({ subject: { rate: '7.4' } })));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('35131346')).toEqual({ score: 7.4, votes: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('subject_abstract 失效时回退到解析条目页 HTML', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(fakeResponse('', { status: 404 }))
      .mockResolvedValueOnce(
        fakeResponse('<strong property="v:average">8.7</strong><span property="v:votes">99</span>'),
      );
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('123')).toEqual({ score: 8.7, votes: 99 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toContain('/subject/123/');
  });

  it('abstract 返回的结构里没有评分时也会回退', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(fakeResponse(JSON.stringify({ subject: {} })))
      .mockResolvedValueOnce(fakeResponse('<strong property="v:average">6.1</strong>'));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect((await client.fetchRating('123'))?.score).toBe(6.1);
  });

  it('已经被限流时不再拿 HTML 去撞第二次', async () => {
    const queue = fastQueue();
    const fetchImpl = vi.fn(async () => fakeResponse('', { status: 403 }));
    const client = new DoubanClient(queue, { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.fetchRating('123')).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('条目页里也没有评分时返回 null', async () => {
    const fetchImpl = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(fakeResponse('', { status: 404 }))
      .mockResolvedValueOnce(fakeResponse('<html><body>页面不存在</body></html>'));
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('123')).toBeNull();
  });
});

describe('DoubanClient 超时', () => {
  it('中断的请求会转成可读的超时错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const client = new DoubanClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('测试')).rejects.toThrow('超时');
  });
});
