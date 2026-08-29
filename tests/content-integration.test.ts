// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionRequest, ExtensionResponse } from '../src/shared/messages';
import type { LookupOutcome, MediaQuery } from '../src/shared/types';

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

/** 让所有被观察的元素同时进入视口。 */
function scrollIntoView(): void {
  const entries = observedElements.map(
    (target, index) =>
      ({
        target,
        isIntersecting: true,
        boundingClientRect: { top: index * 100, left: 0 } as DOMRectReadOnly,
      }) as unknown as IntersectionObserverEntry,
  );
  intersectionCallback?.(entries);
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
        if (request.kind !== 'lookup') throw new Error('本用例只处理 lookup');
        lookupRequests.push(request.query);
        return { kind: 'lookup', outcome: lookupResponder(request.query) };
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
  lookupResponder = () => ({
    status: 'ok',
    rating: {
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

describe('内容脚本整体链路', () => {
  it('卡片进入视口后，角标带着豆瓣评分出现', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();

    // 只有进入视口才会真的去查豆瓣。
    expect(lookupRequests).toHaveLength(0);
    expect(observedElements).toHaveLength(1);

    scrollIntoView();
    await settle();

    const badge = document.querySelector('.dbr-badge');
    expect(badge).not.toBeNull();
    expect(badge?.querySelector('.dbr-value')?.textContent).toBe('7.4');
    expect(lookupRequests[0]).toMatchObject({ title: '河边的错误' });
  });

  it('角标挂在紧贴封面图的那一层', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await settle();

    const badge = document.querySelector('.dbr-badge');
    // 落点必须是直接包着封面图的容器，否则绝对定位会跑偏。
    expect(badge?.parentElement?.querySelector(':scope > img')).not.toBeNull();
  });

  it('云游戏卡片不会触发任何豆瓣查询', async () => {
    document.body.innerHTML = CLOUD_GAME_HTML;
    await loadContentScript();
    await settle(400);
    scrollIntoView();
    await settle();

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
    await settle();

    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('查询失败时同样不留残迹', async () => {
    lookupResponder = () => ({ status: 'error', reason: '豆瓣暂时限流' });
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await settle();

    expect(document.querySelector('.dbr-badge')).toBeNull();
  });

  it('同一张卡片不会被重复查询', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await settle();

    // 制造一次 DOM 变动，触发重新扫描。
    document.body.appendChild(document.createElement('div'));
    await settle(400);

    expect(lookupRequests).toHaveLength(1);
  });

  it('卡片被 Netflix 复用成另一部片时，会按新片子重新查询', async () => {
    document.body.innerHTML = CARD_HTML;
    await loadContentScript();
    scrollIntoView();
    await settle();
    expect(lookupRequests).toHaveLength(1);

    // Netflix 的横向列表会回收 DOM 节点给下一部片子用。
    document.querySelector('[data-uia="standard-card"]')!.setAttribute('aria-label', '鱿鱼游戏');
    await settle(400);
    scrollIntoView();
    await settle();

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
