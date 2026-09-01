// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRequest, ExtensionResponse } from '../src/shared/messages';
import type { MediaQuery, RatingsOutcome, SiteId } from '../src/shared/types';

/**
 * Prime Video 内容脚本的整体链路。
 *
 * 为什么单独有这一份：site-runtime 那组用假适配器验证主循环，primevideo 那组
 * 单独验证提取函数 —— 但**真正的入口文件（src/content/primevideo/index.ts）
 * 一直没被执行过**。适配器字段拼错、选择器和提取函数对不上、导入成环，
 * 这些都不会被前两组发现，装上扩展的表现却是「什么都没有」。
 *
 * 所以这里加载真实入口，喂一个仿造的 Prime Video 页面，走完整条链路。
 *
 * ⚠️ 页面结构是仿造的，不是线上抓的 —— 开发环境访问不了 primevideo.com。
 * 这组用例证明的是「装配正确」，不是「线上真的长这样」。后者要靠
 * scripts/dom-probe.js 在真实页面上跑。
 */

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;

let intersectionCallback: IntersectionCallback | null = null;
let observed: Element[] = [];
let lookups: Array<{ query: MediaQuery; site: SiteId }> = [];
let interests: MediaQuery[] = [];

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

/**
 * 仿造的一行卡片。刻意混进两个非影片链接 —— 真实页面上导航、账号、帮助
 * 这类 <a> 比影片卡片还多，路由过滤挡不住它们就是纯粹的配额浪费。
 */
const ROW = `
<div class="row">
  <a href="/detail/0ABCDEF123/ref=dv_web_1" aria-label="沙丘">
    <div class="poster"><img src="a.jpg" alt="沙丘"></div>
  </a>
  <a href="/detail/0GHIJKL456/ref=dv_web_2" aria-label="黑袍纠察队 第三季">
    <div class="poster"><img src="b.jpg" alt="黑袍纠察队 第三季"></div>
  </a>
  <a href="/storefront?ref=nav_movies">电影</a>
  <a href="/settings/account">账户设置</a>
</div>`;

const DOUBAN_RATING = {
  source: 'douban' as const,
  id: '26387939',
  title: '沙丘',
  score: 7.8,
  votes: 480000,
  year: 2021,
  type: 'movie' as const,
  url: 'https://movie.douban.com/subject/26387939/',
  confidence: 95,
};

const IMDB_RATING = {
  source: 'imdb' as const,
  id: 'tt1160419',
  title: 'Dune',
  score: 8.0,
  votes: 850000,
  year: 2021,
  type: 'movie' as const,
  url: 'https://www.imdb.com/title/tt1160419/',
  confidence: 95,
};

beforeEach(() => {
  document.documentElement.replaceChild(document.createElement('body'), document.body);
  window.history.replaceState({}, '', '/storefront');
  intersectionCallback = null;
  observed = [];
  lookups = [];
  interests = [];

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
              douban: { status: 'ok', rating: DOUBAN_RATING },
              imdb: { status: 'ok', rating: IMDB_RATING },
            } satisfies RatingsOutcome,
          };
        }
        if (request.kind === 'interest') {
          interests.push(request.query);
          return { kind: 'interest', recorded: true };
        }
        throw new Error(`本用例不处理 ${request.kind}`);
      }),
    },
  });
  vi.resetModules();
});

afterEach(async () => {
  const { stopSite } = await import('../src/content/site');
  stopSite();
  vi.unstubAllGlobals();
});

/** 加载真实的 Prime Video 入口（它在导入时自启动）。 */
async function loadPrimeVideo(): Promise<void> {
  await import('../src/content/primevideo/index');
  await settle(60);
}

describe('Prime Video 列表页', () => {
  it('只把影片卡片纳入观察，导航链接一概不管', async () => {
    document.body.innerHTML = ROW;
    await loadPrimeVideo();

    // 页面上 4 个 <a>，只有 2 个是影片。
    expect(observed).toHaveLength(2);
  });

  it('进入视口并驻留后，两家的评分并排出现', async () => {
    document.body.innerHTML = ROW;
    await loadPrimeVideo();
    expect(lookups).toHaveLength(0);

    scrollIntoView();
    await settle(900);

    expect(lookups[0]?.site).toBe('primevideo');
    expect(lookups.map((l) => l.query.title)).toContain('沙丘');

    const badge = document.querySelector('.dbr-badge');
    expect(badge).not.toBeNull();
    const parts = [...badge!.querySelectorAll('.dbr-part')];
    expect(parts.map((p) => p.className.includes('dbr-src-imdb'))).toEqual([false, true]);
    expect(parts[0]?.querySelector('.dbr-value')?.textContent).toBe('7.8');
    expect(parts[1]?.querySelector('.dbr-value')?.textContent).toBe('8.0');
  });

  it('角标挂在紧贴封面图的那一层', async () => {
    document.body.innerHTML = ROW;
    await loadPrimeVideo();
    scrollIntoView();
    await settle(900);

    expect(document.querySelector('.poster > .dbr-badge')).not.toBeNull();
  });

  it('带季数的标题解析出季数，随查询一起发出', async () => {
    document.body.innerHTML = ROW;
    await loadPrimeVideo();
    scrollIntoView();
    await settle(900);

    const series = lookups.find((l) => l.query.title.includes('黑袍纠察队'));
    expect(series?.query.season).toBe(3);
  });

  it('点击卡片记成兴趣，点角标不记', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    document.body.innerHTML = ROW;
    await loadPrimeVideo();
    scrollIntoView();
    await settle(900);

    interests = [];
    document.querySelector<HTMLElement>('img')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(150);
    expect(interests).toHaveLength(1);

    interests = [];
    document.querySelector<HTMLElement>('.dbr-src-douban')!.click();
    await settle(150);
    expect(interests).toHaveLength(0);
  });

  it('后插入 DOM 的卡片也会被发现（Prime Video 同样是 SPA）', async () => {
    await loadPrimeVideo();
    expect(observed).toHaveLength(0);

    document.body.innerHTML = ROW;
    await settle(400);
    expect(observed).toHaveLength(2);
  });
});

describe('Prime Video 详情页', () => {
  it('不在详情页时，不会拿首页的 h1 去查', async () => {
    // 少了这道 URL 门禁，每次打开首页都会白花一次配额，还可能真配出一个
    // 莫名其妙的分数挂在页面上。
    window.history.replaceState({}, '', '/storefront');
    document.body.innerHTML = '<main><h1>Prime Video</h1></main>';
    await loadPrimeVideo();
    await settle(400);

    expect(lookups).toHaveLength(0);
  });

  it('在详情页时，从 h1 和元信息里读出片名与年份', async () => {
    window.history.replaceState({}, '', '/detail/0ABCDEF123/ref=dv');
    document.body.innerHTML = `
      <main>
        <h1 data-automation-id="title">沙丘</h1>
        <div data-automation-id="meta-info">2021 · 2 小时 35 分钟 · 13+</div>
      </main>`;
    await loadPrimeVideo();
    await settle(400);

    expect(lookups[0]?.query).toMatchObject({ title: '沙丘', year: 2021 });
    expect(lookups[0]?.site).toBe('primevideo');
  });
});
