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
  const GRAPHQL_OK = {
    data: { title: { ratingsSummary: { aggregateRating: 9.5, voteCount: 2200000 } } },
  };
  const HTML_OK = `<script type="application/ld+json">
    {"aggregateRating":{"ratingValue":8.4,"ratingCount":1234}}</script>`;

  it('优先走 GraphQL，且用 POST', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(GRAPHQL_OK));
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('tt0903747')).toEqual({ score: 9.5, votes: 2200000 });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('api.graphql.imdb.com');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('GraphQL 结构对不上时退回条目页 JSON-LD', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('graphql')
        ? jsonResponse({ errors: [{ message: 'PersistedQueryNotFound' }] })
        : new Response(HTML_OK, { status: 200 }),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.fetchRating('tt0903747')).toEqual({ score: 8.4, votes: 1234 });
  });

  it('GraphQL 被判失效后，后续直接走兜底路径', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes('graphql')
        ? jsonResponse({ errors: [] })
        : new Response(HTML_OK, { status: 200 }),
    );
    const client = new ImdbClient(fastQueue(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.fetchRating('tt0903747');
    fetchImpl.mockClear();
    await client.fetchRating('tt0944947');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('imdb.com/title/');
    expect(client.disabledPaths).toContain('graphql');
  });

  it('两条路都不行时抛异常，绝不谎报"暂无评分"', async () => {
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
