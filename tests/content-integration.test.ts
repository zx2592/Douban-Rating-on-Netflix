// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRequest, ExtensionResponse } from '../src/shared/messages';
import type { LookupOutcome, MediaQuery, RatingsOutcome } from '../src/shared/types';

/**
 * 内容脚本的集成测试。
 *
 * 各个模块的单测都过了也不代表接得起来 —— 消息协议对不上、观察器没装上、
 * 角标挂错了节点，这些只有把整条链路真的跑一遍才会暴露。这里在 jsdom 里
 * 搭一个简化的 Netflix 页面，配上假的 chrome API 和 IntersectionObserver，
 * 然后加载真实的内容脚本，检查角标最终有没有出现在该出现的地方。
 */

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;

let intersectionCallback: IntersectionCallback | null = null;
let observedElements: Element[] = [];
let lookupRequests: MediaQuery[] = [];
let lookupResponder: (query: MediaQuery) => LookupOutcome;
/** IMDb 那一路的结果。默认关闭，只有明确测 IMDb 的用例才打开。 */
let imdbResponder: (query: MediaQuery) => LookupOutcome;
let interestRequests: MediaQuery[] = [];
/** background 是否把这次点击记成了新的兴趣（冷却期内会返回 false）。 */
let interestResponder: (query: MediaQuery) => boolean;

class FakeIntersectionObserver {
  constructor(callback: IntersectionCallback) {
    intersectionCallback = callback;
  }
  observe(element: Element): void {
    observedElements.push(element);
  }
  unobserve(element: Element): void {
    observedElements = observedElements.filter((item) => item !== element);
  }
  disconnect(): void {
    observedElements = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function notify(targets: Element[], isIntersecting: boolean): void {
  intersectionCallback?.(
    targets.map(
      (target, index) =>
        ({
          target,
          isIntersecting,
          boundingClientRect: { top: index * 100, left: 0 } as DOMRectReadOnly,
        }) as unknown as IntersectionObserverEntry,
    ),
  );
}

/** 让所有被观察的元素进入视口。 */
function scrollIntoView(): void {
  notify([...observedElements], true);
}

/** 让指定元素离开视口。 */
function scrollOutOfView(targets: Element[]): void {
  notify(targets, false);
}

/** 卡片要在视野里停留 600ms 才会真的去查豆瓣，等过这段时间。 */
async function pastDwell(): Promise<void> {
  await settle(800);
}

/** 等若干轮微任务 + 定时器，让内容脚本里的异步流程跑完。 */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 线上 netflix.com/browse 的真实卡片结构（图片 URL 已缩短）。 */
const CARD_HTML = `
<div data-virtual-slot="4" class="default-ltr-iqcdef-cache-1uo9crx">
  <div><div class="default-ltr-iqcdef-cache-1tbetht">
    <a href="/browse?jbv=81234567" tabindex="0" aria-label="河边的错误"
       data-uia="standard-card" class="default-ltr-iqcdef-cache-19c3xp8">
      <div class="default-ltr-iqcdef-cache-lbc">
        <img src="art.webp" alt="" class="standard-card tracked-card">
      </div>
    </a>
  </div></div>
</div>`;

/** 云游戏卡片：结构相同、data-uia 不同，绝不能当成影片去查豆瓣。 */
const CLOUD_GAME_HTML = `
<div data-virtual-slot="5" class="default-ltr-iqcdef-cache-1uo9crx">
  <div><div class="default-ltr-iqcdef-cache-1tbetht">
    <a href="/browse?jbv=82027565" tabindex="0" aria-label="Netflix Minigolf"
       data-uia="cloud-game-card" class="default-ltr-iqcdef-cache-19c3xp8">
      <div class="default-ltr-iqcdef-cache-lbc">
        <img src="game.webp" alt="" class="cloud-game-card tracked-card">
      </div>
    </a>
  </div></div>
</div>`;

function installChromeMock(): void {
  const chromeMock = {
    storage: {
      // 返回空对象，让 loadSettings 落到默认设置上。
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (request: ExtensionRequest): Promise<ExtensionResponse> => {
        if (request.kind === 'lookup') {
          lookupRequests.push(request.query);
          return {
            kind: 'lookup',
            outcome: {
              douban: lookupResponder(request.query),
              imdb: imdbResponder(request.query),
            } satisfies RatingsOutcome,
          };
        }
        if (request.kind === 'interest') {
          interestRequests.push(request.query);
          return { kind: 'interest', recorded: interestResponder(request.query) };
        }
        throw new Error(`本用例不处理 ${request.kind}`);
      }),
    },
  };
  vi.stubGlobal('chrome', chromeMock);
}

beforeEach(() => {
  // 每个用例换一个全新的 body。vi.resetModules() 只是让下次 import 拿到新模块，
  // 上一个用例加载的那份内容脚本仍然活着，它的 MutationObserver 还盯着旧的
  // body；换掉 body 之后那些旧实例观察的是一个已脱离文档的节点，自然失效。
  document.documentElement.replaceChild(document.createElement('body'), document.body);
  intersectionCallback = null;
  observedElements = [];
  lookupRequests = [];
  interestRequests = [];
  interestResponder = () => true;
  imdbResponder = () => ({ status: 'disabled' });
  lookupResponder = () => ({
    status: 'ok',
    rating: {
      source: 'douban' as const,
      id: '35131346',
      title: '河边的错误',
      score: 7.4,
      votes: 254321,
      year: 2023,
      type: 'movie',
      url: 'https://movie.douban.com/subject/35131346/',
      confidence: 100,
    },
  });
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  installChromeMock();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 加载内容脚本（它在导入时就会自启动）。 */
async function loadContentScript(): Promise<void> {
  await import('../src/content/netflix/index');
  await settle(50);
}

describe('省配额：驻留判定', () => {
  it('卡片一闪而过时不花配额', async () => {
    // 豆瓣对匿名请求的配额很紧。快速滚动会让大量卡片掠过视口，若一进入
    // 就排队，配额全花在用户根本没看的封面上。
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    const observed = [...observedElements];
    scrollIntoView();
    scrollOutOfView(observed);
    await pastDwell();

    expect(lookupRequests).toHaveLength(0);
  });

  it('停下来看的卡片照常查询', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    scrollIntoView();
    await pastDwell();

    expect(lookupRequests).toHaveLength(1);
  });

  it('刚进入视口、还没到驻留时间时不发请求', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    scrollIntoView();
    await settle(200);
    expect(lookupRequests).toHaveLength(0);

    await settle(700);
    expect(lookupRequests).toHaveLength(1);
  });

  it('掠过之后又滚回来，仍然能查到', async () => {
    // 掠过时不 unobserve，用户往回滚这张卡片还要能重新触发。
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    const observed = [...observedElements];
    scrollIntoView();
    scrollOutOfView(observed);
    await pastDwell();
    expect(lookupRequests).toHaveLength(0);

    notify(observed, true);
    await pastDwell();
    expect(lookupRequests).toHaveLength(1);
  });
});

describe('内容脚本整体链路', () => {
  it('卡片进入视口后，角标带着豆瓣评分出现', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    // 只有进入视口才会真的去查豆瓣。
    expect(lookupRequests).toHaveLength(0);
    expect(observedElements).toHaveLength(1);

    scrollIntoView();
    await pastDwell();

    const badge = document.querySelector('.dbr-badge');
    expect(badge).not.toBeNull();
    expect(badge?.querySelector('.dbr-value')?.textContent).toBe('7.4');
    expect(lookupRequests[0]).toMatchObject({ title: '河边的错误' });
  });

  it('角标挂在紧贴封面图的那一层', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    const badge = document.querySelector('.dbr-badge');
    // 落点必须是直接包着封面图的容器，否则绝对定位会跑偏。
    expect(badge?.parentElement?.querySelector(':scope > img')).not.toBeNull();
  });

  it('云游戏卡片不会触发任何豆瓣查询', async () => {
    document.body.innerHTML = CLOUD_GAME_HTML;
    await loadContentScript();
    await settle(400);
    scrollIntoView();
    await pastDwell();

    expect(lookupRequests).toHaveLength(0);
    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('后插入 DOM 的卡片也会被发现（Netflix 是动态渲染的）', async () => {
    await loadContentScript();
    expect(observedElements).toHaveLength(0);

    document.body.innerHTML = CARD_HTML;
    await settle(400);
    expect(observedElements).toHaveLength(1);
  });

  it('豆瓣未收录时不留下角标，列表页保持干净', async () => {
    lookupResponder = () => ({ status: 'not_found' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('查询失败时同样不留残迹', async () => {
    lookupResponder = () => ({ status: 'error', reason: '豆瓣暂时限流' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('同一张卡片不会被重复查询', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    // 制造一次 DOM 变动，触发重新扫描。
    document.body.appendChild(document.createElement('div'));
    await settle(400);

    expect(lookupRequests).toHaveLength(1);
  });

  it('卡片被 Netflix 复用成另一部片时，会按新片子重新查询', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();
    expect(lookupRequests).toHaveLength(1);

    // Netflix 的横向列表会回收 DOM 节点给下一部片子用。
    document.querySelector('[data-uia="standard-card"]')!.setAttribute('aria-label', '鱿鱼游戏');
    await settle(400);
    scrollIntoView();
    await pastDwell();

    expect(lookupRequests).toHaveLength(2);
    expect(lookupRequests[1]).toMatchObject({ title: '鱿鱼游戏' });
  });

  it('详情弹层不等进入视口，立即查询并显示', async () => {
    document.body.innerHTML = `
      <div class="previewModal--container">
        <img data-uia="previewModal--player-titleTreatment-logo" alt="河边的错误" src="l.png" />
        <div class="videoMetadata--first-line" data-uia="video-metadata"><span class="year">2023</span></div>
      </div>`;
    await loadContentScript();
    await settle();

    expect(lookupRequests[0]).toMatchObject({ title: '河边的错误', year: 2023 });
    const badge = document.querySelector('.dbr-modal');
    expect(badge?.querySelector('.dbr-value')?.textContent).toBe('7.4');
  });

  it('总开关关闭时什么都不注入', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: { enabled: false },
    });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    await settle(400);

    expect(observedElements).toHaveLength(0);
    expect(lookupRequests).toHaveLength(0);
    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('关闭"列表页显示"后，详情弹层依然工作', async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      settings: { showOnCards: false },
    });
    document.body.innerHTML = `
      ${CARD_HTML}
      <div class="previewModal--container">
        <img data-uia="previewModal--player-titleTreatment-logo" alt="河边的错误" src="l.png" />
        <div class="videoMetadata--first-line" data-uia="video-metadata"><span class="year">2023</span></div>
      </div>`;
    await loadContentScript();
    await settle();

    expect(observedElements).toHaveLength(0);
    expect(document.querySelector('.dbr-modal')).not.toBeNull();
  });
});

describe('点击卡片 = 表达兴趣', () => {
  /** 模拟真实点击：事件从封面图上冒起，而不是直接点在卡片元素上。 */
  function clickCover(): void {
    const cover = document.querySelector('img');
    cover?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('点击封面会把这部片记成感兴趣', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    clickCover();
    await settle(100);

    expect(interestRequests).toHaveLength(1);
    expect(interestRequests[0]).toMatchObject({ title: '河边的错误' });
  });

  it('记下兴趣后立刻重查一次，让点开的片先出分', async () => {
    // 之前这部片被记成「未收录」，页面上没有角标。用户点开它，
    // background 允许绕过那条缓存重查一次，这次拿到了分。
    lookupResponder = () => ({ status: 'not_found' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();
    expect(document.querySelector('.dbr-badge')).toBeNull();

    lookupResponder = () => ({
      status: 'ok',
      rating: {
        source: 'douban' as const,
      id: '35131346',
        title: '河边的错误',
        score: 7.4,
        votes: 254321,
        year: 2023,
        type: 'movie',
        url: 'https://movie.douban.com/subject/35131346/',
        confidence: 100,
      },
    });
    clickCover();
    await settle(200);

    expect(document.querySelector('.dbr-value')?.textContent).toBe('7.4');
  });

  it('冷却期内的重复点击不会再发查询', async () => {
    // background 返回 false 表示时间戳没刷新。连点几下若每次都重查，
    // 紧张的配额会被同一部片吃掉。
    interestResponder = () => false;
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    clickCover();
    clickCover();
    await settle(200);

    expect(interestRequests).toHaveLength(2);
    expect(lookupRequests).toHaveLength(0);
  });

  it('点击云游戏卡片什么也不记', async () => {
    document.body.innerHTML = CLOUD_GAME_HTML;
    await loadContentScript();

    clickCover();
    await settle(100);

    expect(interestRequests).toHaveLength(0);
  });

  it('点在卡片之外的地方不会误记', async () => {
    document.body.innerHTML = `<div id="nav">导航</div>${CARD_HTML}`;
    await loadContentScript();

    document.getElementById('nav')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(100);

    expect(interestRequests).toHaveLength(0);
  });
});

describe('豆瓣 + IMDb 并排出现在卡片上', () => {
  const IMDB_OK: LookupOutcome = {
    status: 'ok',
    rating: {
      source: 'imdb',
      id: 'tt0903747',
      title: 'Breaking Bad',
      score: 9.5,
      votes: 2_200_000,
      year: 2008,
      type: 'tv',
      url: 'https://www.imdb.com/title/tt0903747/',
      confidence: 100,
    },
  };

  it('一个角标里两段，IMDb 排在豆瓣后面', async () => {
    imdbResponder = () => IMDB_OK;
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    // 只有一个角标：两段共用一个绝对定位的容器，不会叠在封面同一个角。
    expect(document.querySelectorAll('.dbr-badge')).toHaveLength(1);
    const parts = [...document.querySelectorAll('.dbr-part')];
    expect(parts.map((part) => part.className.includes('dbr-src-imdb'))).toEqual([false, true]);
    expect(parts[0]?.querySelector('.dbr-value')?.textContent).toBe('7.4');
    expect(parts[1]?.querySelector('.dbr-value')?.textContent).toBe('9.5');
  });

  it('豆瓣被限流时 IMDb 照常显示', async () => {
    // 两边分开走队列、分开缓存的意义就在这里。聚合成"全有或全无"
    // 会让豆瓣的限流把 IMDb 一起拖下水。
    lookupResponder = () => ({ status: 'error', reason: '豆瓣暂时限流' });
    imdbResponder = () => IMDB_OK;
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    const parts = [...document.querySelectorAll('.dbr-part')];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.className).toContain('dbr-src-imdb');
    expect(parts[0]?.querySelector('.dbr-value')?.textContent).toBe('9.5');
  });

  it('IMDb 那一路出错时，豆瓣的分照常显示', async () => {
    imdbResponder = () => ({ status: 'error', reason: 'IMDb 请求超时' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    const parts = [...document.querySelectorAll('.dbr-part')];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.className).toContain('dbr-src-douban');
  });

  it('两边都没有结果时不留下空角标', async () => {
    lookupResponder = () => ({ status: 'not_found' });
    imdbResponder = () => ({ status: 'not_found' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('两段各自跳自己的条目页', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    imdbResponder = () => IMDB_OK;
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    document.querySelector<HTMLElement>('.dbr-src-imdb')!.click();
    expect(open).toHaveBeenLastCalledWith(
      'https://www.imdb.com/title/tt0903747/',
      '_blank',
      'noopener,noreferrer',
    );

    document.querySelector<HTMLElement>('.dbr-src-douban')!.click();
    expect(open).toHaveBeenLastCalledWith(
      'https://movie.douban.com/subject/35131346/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('点角标不会被记成"对这部片感兴趣"', async () => {
    // 点击卡片会记兴趣；点角标是"我要去看条目页"，不该顺带触发那个，
    // 否则每次点分数都会白白刷新一次兴趣时间戳。
    vi.spyOn(window, 'open').mockImplementation(() => null);
    imdbResponder = () => IMDB_OK;
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await pastDwell();

    interestRequests = [];
    document.querySelector<HTMLElement>('.dbr-src-imdb')!.click();
    await settle(100);

    expect(interestRequests).toHaveLength(0);
  });
});
