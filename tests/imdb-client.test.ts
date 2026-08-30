import { describe, expect, it, vi } from 'vitest';
import { ImdbClient } from '../src/background/imdb/client';
import { RateLimitedError, RequestQueue } from '../src/background/queue';

/**
 * IMDb 客户端的降级行为。
 *
 * 这组用例的分量比平时重：IMDb 那几个接口是在**无法访问 imdb.com 的开发环境**
 * 里写的，哪条路径真正可用还没有实测过。既然无法保证"第一条路一定通"，
 * 就必须保证"第一条不通时能自动换下一条，且不会每部片都白撞一次"。
 */

/** 不限速的队列，让用例跑得快。 */
function fastQueue(): RequestQueue {
  return new RequestQueue({ minIntervalMs: 0, jitterMs: 0, random: () => 0 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUGGESTION = { d: [{ id: 'tt0903747', l: 'Breaking Bad', qid: 'tvSeries', y: 2008 }] };

describe('ImdbClient 检索入口降级', () => {
  it('首选入口可用时不碰备用入口', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(SUGGESTION));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    const candidates = await client.search('Breaking Bad');

    expect(candidates).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('v3.sg.media-imdb.com');
  });

  it('首选入口 404 时自动换备用入口', async () => {
    // 私有接口下线时最典型的表现就是 404。这条路必须能自己走通，
    // 否则要等用户报告"完全没有 IMDb 分数"才会发现。
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('v3.') ? new Response('Not Found', { status: 404 }) : jsonResponse(SUGGESTION),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.search('Breaking Bad')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('确认失效的入口不会每次都再撞一遍', async () => {
    // 每部片都白费一次请求，在配额紧的前提下是纯浪费。
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes('v3.') ? new Response('Not Found', { status: 404 }) : jsonResponse(SUGGESTION),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.search('Breaking Bad');
    fetchImpl.mockClear();
    await client.search('Better Call Saul');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('v2.sg.media-imdb.com');
    expect(client.disabledPaths).toContain('suggestion#0');
  });

  it('返回的不是 JSON 时也算这条路失效', async () => {
    // 接口被换成人机验证页之类：HTTP 200，但内容是 HTML。
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('v3.')
        ? new Response('<html>nope</html>', { status: 200 })
        : jsonResponse(SUGGESTION),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.search('Breaking Bad')).toHaveLength(1);
    expect(client.disabledPaths).toContain('suggestion#0');
  });

  it('能解析但没有结果时就此打住，不再试备用入口', async () => {
    // 入口是通的，只是这部片 IMDb 没有。再打一次备用入口纯属浪费。
    const fetchImpl = vi.fn(async () => jsonResponse({ d: [] }));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.search('查无此片')).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('限流直接抛出，不浪费备用入口', async () => {
    // 限流是全局状态，换个域名照样被拒。
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('Breaking Bad')).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('网络错误不会把入口标记成失效', async () => {
    // 断网是暂时的，把入口拉黑等于恢复网络后依然不工作。
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.search('Breaking Bad')).rejects.toThrow();
    expect(client.disabledPaths).toEqual([]);
  });
});

describe('ImdbClient 取分路径降级', () => {
  // 本机实测抓回来的真实响应（含 IMDb 附带的使用条款声明）。
  const GRAPHQL_OK = {
    data: { title: { ratingsSummary: { aggregateRating: 9.5, voteCount: 2668078 } } },
    extensions: {
      disclaimer:
        'Public, commercial, and/or non-private use of the IMDb data provided by this API is not allowed.',
    },
  };

  it('优先走 GraphQL，且用 POST', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(GRAPHQL_OK));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('tt0903747')).toEqual({ score: 9.5, votes: 2668078 });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('api.graphql.imdb.com');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('必须带上 imdb 的自定义头，否则 403', () => {
    // 实测：同一个地址、同一个查询，裸 POST → 403（nginx 的 403 页面），
    // 改用 GET → 403，带上这三个头 → 200 + 评分。这不是抄来的，是打出来的。
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(GRAPHQL_OK));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    return client.fetchRating('tt0903747').then(() => {
      const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-imdb-client-name']).toBe('imdb-web-next');
      expect(headers['x-imdb-user-country']).toBeDefined();
      expect(headers['x-imdb-user-language']).toBeDefined();
      // Origin / Referer 刻意不设：它们是 Fetch 规范的禁止修改头，扩展设了
      // 也会被浏览器忽略。实测证明不需要它们。
      expect(headers['Origin']).toBeUndefined();
      expect(headers['Referer']).toBeUndefined();
    });
  });

  it('不再走条目页兜底 —— 那条实测是反爬拦截页', () => {
    // www.imdb.com/title/… 在浏览器里也只返回 1997B 的拦截页（含
    // "enable javascript" 和 "challenge"）。留着它意味着每次失败都白下
    // 一次 2KB，还会报出误导性的「页面里没有评分数据」。
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ errors: [{ message: 'nope' }] }),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    return client.fetchRating('tt0903747').then(
      () => expect.unreachable('应当抛错'),
      () => {
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]![0])).toContain('api.graphql.imdb.com');
      },
    );
  });

  it('取分失败时抛异常，绝不谎报"暂无评分"', async () => {
    // 把网络故障显示成「IMDb 暂无评分」是在骗用户，而且会被上层
    // 当成有效结果写进缓存，错误会存活好几天。
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 200 }));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.fetchRating('tt0903747')).rejects.toThrow();
  });

  it('票数太少而 IMDb 未出分，是有效结果', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { title: { ratingsSummary: { voteCount: 2 } } } }),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('tt9999999')).toEqual({ score: null, votes: 2 });
  });

  it('不携带 cookie', async () => {
    // 和豆瓣同一条原则：不拿用户的登录态去访问第三方站点。
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(GRAPHQL_OK));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.fetchRating('tt0903747');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).credentials).toBe('omit');
  });
});
