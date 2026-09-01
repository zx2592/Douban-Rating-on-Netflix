// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRequest, ExtensionResponse } from '../src/shared/messages';
import type { MediaQuery, RatingsOutcome, SiteId } from '../src/shared/types';

/**
 * 站点无关的主循环（src/content/site.ts）。
 *
 * 这组用例存在的理由很具体：接 Prime Video 时把 Netflix 内容脚本里那 300 多行
 * 观察器 / 驻留判定 / 角标渲染 / 复用检测抽成了共用层。**「抽出来之后对第二个
 * 站点依然成立」这件事必须被证明，而不是假设。** 所以这里用一个完全虚构的
 * 站点适配器把整条链路跑一遍 —— 如果哪天有人往 site.ts 里塞了 Netflix
 * 专属的假设，这个文件会第一个红。
 */

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;

let intersectionCallback: IntersectionCallback | null = null;
let observed: Element[] = [];
let lookups: Array<{ query: MediaQuery; site: SiteId }> = [];

class FakeIntersectionObserver {
  constructor(callback: IntersectionCallback) {
    intersectionCallback = callback;
  }
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(el: Element): void {
    observed = observed.filter((item) => item !== el);
  }
  disconnect(): void {
    observed = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scrollIntoView(): void {
  intersectionCallback?.(
    observed.map(
      (target, index) =>
        ({
          target,
          isIntersecting: true,
          boundingClientRect: { top: index * 100, left: 0 } as DOMRectReadOnly,
        }) as unknown as IntersectionObserverEntry,
    ),
  );
}

const RATING = {
  source: 'douban' as const,
  id: '1',
  title: '虚构片名',
  score: 8.1,
  votes: 100,
  year: 2020,
  type: 'movie' as const,
  url: 'https://movie.douban.com/subject/1/',
  confidence: 100,
};

beforeEach(() => {
  document.documentElement.replaceChild(document.createElement('body'), document.body);
  intersectionCallback = null;
  observed = [];
  lookups = [];

  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('chrome', {
    storage: {
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind === 'lookup') {
          lookups.push({ query: request.query, site: request.site });
          return {
            kind: 'lookup',
            outcome: {
              douban: { status: 'ok', rating: RATING },
              imdb: { status: 'disabled' },
            } satisfies RatingsOutcome,
          };
        }
        if (request.kind === 'interest') return { kind: 'interest', recorded: true };
        throw new Error(`本用例不处理 ${request.kind}`);
      }),
    },
  });
  vi.resetModules();
});

afterEach(async () => {
  // 必须显式停掉：不停的话这个实例会继续扫描下一个用例的 document，
  // 用错误的站点 id 发出查询 —— 这不是假设，是实际发生过的。
  const { stopSite } = await import('../src/content/site');
  stopSite();
  vi.unstubAllGlobals();
});

/** 一个和 Netflix、Prime Video 都无关的虚构站点。 */
async function startFakeSite(overrides: Record<string, unknown> = {}): Promise<void> {
  const { startSite } = await import('../src/content/site');
  await startSite({
    id: 'primevideo',
    name: '虚构站点',
    card: ['article[data-film]'],
    cardAnchor: ['div.poster'],
    modal: ['section.detail'],
    modalAnchor: ['section.detail h2'],
    extractFromCard: (el) => {
      const title = el.getAttribute('data-film');
      return title ? { title, type: 'unknown' } : null;
    },
    extractFromModal: (el) => {
      const title = el.querySelector('h2')?.textContent?.trim();
      return title ? { title, type: 'movie', year: 2020 } : null;
    },
    identityOf: (q: MediaQuery) => `${q.title}|${q.year ?? ''}`,
    ...overrides,
  });
  await settle(50);
}

const CARD = '<article data-film="虚构片名"><div class="poster"><img src="a.jpg"></div></article>';

describe('主循环对任意站点都成立', () => {
  it('用适配器的选择器发现卡片，进入视口后出分', async () => {
    document.body.innerHTML = CARD;
    await startFakeSite();

    expect(observed).toHaveLength(1);
    expect(lookups).toHaveLength(0);

    scrollIntoView();
    await settle(800);

    expect(lookups[0]?.query.title).toBe('虚构片名');
    expect(document.querySelector('.dbr-value')?.textContent).toBe('8.1');
  });

  it('角标挂在适配器指定的落点上', async () => {
    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);

    expect(document.querySelector('.poster > .dbr-badge')).not.toBeNull();
  });

  it('查询里带上站点标识，供 background 做分站点开关', async () => {
    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);

    expect(lookups[0]?.site).toBe('primevideo');
  });

  it('驻留判定同样生效：一闪而过的卡片不花配额', async () => {
    document.body.innerHTML = CARD;
    await startFakeSite();

    const targets = [...observed];
    scrollIntoView();
    // 立刻滚走
    intersectionCallback?.(
      targets.map(
        (target) =>
          ({ target, isIntersecting: false, boundingClientRect: { top: 0, left: 0 } }) as unknown as IntersectionObserverEntry,
      ),
    );
    await settle(800);

    expect(lookups).toHaveLength(0);
  });

  it('后插入 DOM 的卡片也会被发现', async () => {
    await startFakeSite();
    expect(observed).toHaveLength(0);

    document.body.innerHTML = CARD;
    await settle(400);
    expect(observed).toHaveLength(1);
  });

  it('点击卡片会记成兴趣', async () => {
    document.body.innerHTML = CARD;
    await startFakeSite();

    document.querySelector('img')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(200);

    expect(lookups.length).toBeGreaterThan(0);
  });
});

describe('暂时性失败要能重试', () => {
  /**
   * 卡片处理过就会 unobserve，所以查询失败之后它不会再被触发 —— 用户不滚走
   * 再滚回来，那张封面就永远空着。而失败原因常常只是暂时的：请求队列满了
   * （密集的列表页一屏就能塞满 40 个待查）、对方在限流、网络抖了一下。
   * 实际现象就是「一大片卡片一直不出分，刷新也没用」。
   */
  it('全部来源都只回暂时性错误时，卡片会被放回观察', async () => {
    let attempt = 0;
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        lookups.push({ query: request.query, site: request.site });
        attempt += 1;
        // 第一次失败，第二次成功 —— 模拟队列腾出空位。
        return attempt === 1
          ? { kind: 'lookup', outcome: { douban: { status: 'error', reason: '请求队列已满' }, imdb: { status: 'disabled' } } }
          : { kind: 'lookup', outcome: { douban: { status: 'ok', rating: RATING }, imdb: { status: 'disabled' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);

    expect(lookups).toHaveLength(1);
    expect(document.querySelector('.dbr-badge')).toBeNull();

    // 等过重试延迟，卡片重新进入观察后再次驻留。
    await settle(4500);
    scrollIntoView();
    await settle(800);

    expect(lookups).toHaveLength(2);
    expect(document.querySelector('.dbr-value')?.textContent).toBe('8.1');
  }, 15000);

  it('「未收录」不是暂时性失败，不重试', async () => {
    // 未收录是一个确定的结论，重试只会白花配额。
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        lookups.push({ query: request.query, site: request.site });
        return { kind: 'lookup', outcome: { douban: { status: 'not_found' }, imdb: { status: 'disabled' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);
    expect(lookups).toHaveLength(1);

    await settle(4500);
    scrollIntoView();
    await settle(800);
    expect(lookups).toHaveLength(1);
  }, 15000);

  it('重试次数有上限，不会变成自旋的请求风暴', async () => {
    // 配额被打穿时无限重试比不显示糟得多。
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        lookups.push({ query: request.query, site: request.site });
        return { kind: 'lookup', outcome: { douban: { status: 'error', reason: '一直失败' }, imdb: { status: 'disabled' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite();
    for (let round = 0; round < 5; round += 1) {
      scrollIntoView();
      await settle(800);
      await settle(4500);
    }

    // 首次 + 最多 2 次重试。
    expect(lookups.length).toBeLessThanOrEqual(3);
  }, 40000);
});

describe('没有详情弹层的站点', () => {
  it('modal 为空数组时不去找详情层', async () => {
    // Prime Video 的详情是整页跳转而不是弹层。给空数组时主循环必须跳过，
    // 而不是拿一个永远匹配不到的选择器去查询整页。
    document.body.innerHTML = '<section class="detail"><h2>不该被查到</h2></section>';
    await startFakeSite({ modal: [] });
    await settle(400);

    expect(lookups).toHaveLength(0);
  });

  it('给了 modal 选择器时照常处理详情层', async () => {
    document.body.innerHTML = '<section class="detail"><h2>详情页片名</h2></section>';
    await startFakeSite();
    await settle(400);

    expect(lookups[0]?.query).toMatchObject({ title: '详情页片名', year: 2020 });
  });
});
