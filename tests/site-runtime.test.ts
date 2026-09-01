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

describe('诊断标记', () => {
  /**
   * 这两组标记只为排查而写，不参与任何逻辑 —— 但它们值得有用例守着，
   * 因为它们失真的代价很具体：诊断脚本自带一份选择器时，扩展改了选择器
   * 之后报告说「被扫描器处理过 21 张」，真实数字是 179。失真的报告比没有
   * 报告更糟，它把排查引向了根本不存在的问题。
   */
  it('把实际在用的选择器挂到 <html> 上，供诊断脚本读取', async () => {
    await startFakeSite();
    expect(document.documentElement.getAttribute('data-dbr-cards')).toBe('article[data-film]');
    expect(document.documentElement.getAttribute('data-dbr-anchors')).toBe('div.poster');
  });

  it('卡片状态区分「在等视口」和「查过没结果」', async () => {
    // 光看 DOM 的话两者都是「有身份标记、没有角标」，但修法完全不同。
    document.body.innerHTML = CARD;
    await startFakeSite();

    const card = document.querySelector('article')!;
    expect(card.getAttribute('data-dbr-state')).toBe('pending');

    scrollIntoView();
    await settle(800);
    expect(card.getAttribute('data-dbr-state')).toBe('ok');
  });

  it('两边都没有结果时标成 missing，不是 error', async () => {
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        return { kind: 'lookup', outcome: { douban: { status: 'not_found' }, imdb: { status: 'not_found' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);

    expect(document.querySelector('article')!.getAttribute('data-dbr-state')).toBe('missing');
  });

  it('读不到片名时标成 skipped，不会停在 querying 骗人', async () => {
    // 实测报告里出现过「26 张卡片一直在 querying」，看着像后台卡死，
    // 其实是提前返回的路径没更新状态。诊断信号失真比没有信号更糟。
    document.body.innerHTML = '<article data-film="有名字"></article>';
    await startFakeSite({
      // 扫描时能取到片名（于是被观察），处理时取不到（模拟卡片被清空）。
      extractFromCard: (() => {
        let calls = 0;
        return (el: HTMLElement) => {
          calls += 1;
          return calls === 1 ? { title: el.getAttribute('data-film')!, type: 'unknown' as const } : null;
        };
      })(),
    });

    scrollIntoView();
    await settle(800);

    expect(document.querySelector('article')!.getAttribute('data-dbr-state')).toBe('skipped');
  });

  it('卡片被复用后，扫描器的新状态不会被旧结果覆盖', async () => {
    // 复用发生后扫描器会按新片子把卡片标成 pending 并重新排队 —— 那才是
    // 它当前的真实状态。旧请求回来时若无条件写 recycled，就把一个更新的、
    // 正确的状态改回了过期描述。两者存在竞争，必须显式判断。
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        lookups.push({ query: request.query, site: request.site });
        // 慢响应，制造出「请求在途」的窗口
        await new Promise((r) => setTimeout(r, 500));
        return { kind: 'lookup', outcome: { douban: { status: 'ok', rating: RATING }, imdb: { status: 'disabled' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite({
      // 这个虚构站点的片名在 data-film 上，复用时改的就是它 —— 必须声明，
      // 否则 MutationObserver 收不到通知（见下一条用例）。
      watchedAttributes: ['data-film'],
      extractFromCard: (el: HTMLElement) => {
        const title = el.getAttribute('data-film');
        return title ? { title, type: 'unknown' as const } : null;
      },
    });

    scrollIntoView();
    await settle(700);
    // 此刻请求在途，把卡片换成另一部片
    document.querySelector('article')!.setAttribute('data-film', '换成了别的片');
    await settle(900);

    const card = document.querySelector('article')!;
    // 关键：不能是 recycled —— 扫描器已经按新片子重新排队了。
    expect(card.getAttribute('data-dbr-state')).not.toBe('recycled');
    expect(card.getAttribute('data-dbr-identity')).toContain('换成了别的片');
    // 而且旧结果绝不能挂到新片子的封面上。
    expect(document.querySelectorAll('.dbr-badge')).toHaveLength(0);
  }, 10000);

  it('监听的属性由适配器决定，不是写死的 aria-label / alt', async () => {
    // 这条是真 bug 抓出来的：attributeFilter 原先硬编码 ['aria-label', 'alt']，
    // 那是照 Netflix 定的。Prime Video 的片名在 data-card-title 上，卡片被
    // 复用时改的是这个属性 —— 我们根本收不到通知，上一部片的评分会一直挂在
    // 新片子的封面上。分数配错封面比不显示分数糟糕得多。
    document.body.innerHTML = CARD;
    await startFakeSite({ watchedAttributes: ['data-film'] });
    expect(observed).toHaveLength(1);

    // 只改属性、不动节点结构。默认的 filter 下这一步不会触发任何回调。
    document.querySelector('article')!.setAttribute('data-film', '另一部片');
    await settle(400);

    expect(document.querySelector('article')!.getAttribute('data-dbr-identity')).toContain('另一部片');
  });

  it('暂时性失败标成 error', async () => {
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind !== 'lookup') return { kind: 'interest', recorded: true };
        return { kind: 'lookup', outcome: { douban: { status: 'error', reason: '队列已满' }, imdb: { status: 'disabled' } } };
      });

    document.body.innerHTML = CARD;
    await startFakeSite();
    scrollIntoView();
    await settle(800);

    expect(document.querySelector('article')!.getAttribute('data-dbr-state')).toBe('error');
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
