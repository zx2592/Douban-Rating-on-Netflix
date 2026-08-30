// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { queryFirst, readFirstText } from '../src/content/dom';
import { extractFromCard, extractFromDetail, isDetailPage } from '../src/content/primevideo/extract';
import { PRIMEVIDEO_SELECTORS } from '../src/content/primevideo/selectors';

/**
 * Prime Video 适配器。
 *
 * ⚠️ 这里的 fixture **不是**从线上抓的真实 HTML —— 开发环境访问不了
 * primevideo.com。所以这些用例锁的是**逻辑**（路由过滤、标题候选的取舍顺序、
 * 详情页的 URL 门禁），不是「线上真的长这样」。
 *
 * 真实结构要靠 scripts/dom-probe.js 在用户的浏览器里跑出来再收敛。这个区别
 * 很重要：Netflix 那份 fixture 是实测抓的，这份不是，别把两者的可信度当成
 * 一回事 —— v0.1 正是栽在「单测全绿但线上零命中」上。
 */

function card(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>('a')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('extractFromCard：先按路由过滤', () => {
  it('认出 /detail/<ASIN> 的影片卡片', () => {
    const el = card(`
      <a href="/detail/0ABCDEF123/ref=dv_web_xyz" aria-label="怪奇物语">
        <div><img src="a.jpg" alt="怪奇物语"></div>
      </a>`);
    expect(extractFromCard(el)).toMatchObject({ title: '怪奇物语', type: 'unknown' });
  });

  it('认出 amazon 站内的 /gp/video/detail/ 形态', () => {
    const el = card('<a href="/gp/video/detail/B0XYZ12345/ref=atv" aria-label="Fallout"></a>');
    expect(extractFromCard(el)?.title).toBe('Fallout');
  });

  it('跟踪参数不影响识别', () => {
    // 真实 href 后面挂着一长串 /ref=... ，精确匹配一个都命中不了。
    const el = card('<a href="/detail/0ABC/ref=dv_web_2_1?ie=UTF8&qid=1" aria-label="沙丘"></a>');
    expect(extractFromCard(el)?.title).toBe('沙丘');
  });

  it('导航链接一律不当成影片', () => {
    // 页面上大量 <a> 是分类、账号、帮助。拿它们去查评分是纯粹的配额浪费 ——
    // 在豆瓣那种紧配额下，这一条比什么都重要。
    for (const href of ['/', '/help', '/settings/account', '/storefront?ref=nav', '/gp/help/customer']) {
      expect(extractFromCard(card(`<a href="${href}" aria-label="帮助">x</a>`))).toBeNull();
    }
  });

  it('读不到标题时返回 null，而不是抛异常', () => {
    expect(extractFromCard(card('<a href="/detail/0ABC/"></a>'))).toBeNull();
  });
});

describe('extractFromCard：标题来源的取舍顺序', () => {
  it('优先用 aria-label', () => {
    const el = card(`
      <a href="/detail/0ABC/" aria-label="正确的片名">
        <img alt="封面图的 alt">
        <span data-automation-id="title">另一个标题</span>
      </a>`);
    expect(extractFromCard(el)?.title).toBe('正确的片名');
  });

  it('没有 aria-label 时退到封面图的 alt', () => {
    const el = card('<a href="/detail/0ABC/"><img alt="封面图的 alt"></a>');
    expect(extractFromCard(el)?.title).toBe('封面图的 alt');
  });

  it('再退到带 title 字样的测试钩子', () => {
    const el = card('<a href="/detail/0ABC/"><span data-automation-id="tv-title">钩子里的标题</span></a>');
    expect(extractFromCard(el)?.title).toBe('钩子里的标题');
  });

  it('清洗复用 Netflix 那套：摘年份、去引号、折叠空白', () => {
    const el = card('<a href="/detail/0ABC/" aria-label="  《沙丘》   (2021) "></a>');
    expect(extractFromCard(el)).toMatchObject({ title: '沙丘', year: 2021 });
  });

  it('标题里带季数后缀时解析出季数', () => {
    const el = card('<a href="/detail/0ABC/" aria-label="黑袍纠察队 第三季"></a>');
    expect(extractFromCard(el)?.season).toBe(3);
  });
});

describe('详情页：URL 门禁', () => {
  it('识别两种详情页路由', () => {
    expect(isDetailPage('/detail/0ABCDEF123/ref=x')).toBe(true);
    expect(isDetailPage('/gp/video/detail/B0XYZ/')).toBe(true);
  });

  it('非详情页一律不认', () => {
    for (const url of ['/', '/storefront', '/help', '/search?phrase=dune']) {
      expect(isDetailPage(url)).toBe(false);
    }
  });

  it('不在详情页时 extractFromDetail 返回 null', () => {
    // 关键的一条：首页的 h1 多半是「Prime Video」或某个分类名。
    // 不做这个门禁的话，每次打开首页都会拿它去查一次评分 —— 白费配额，
    // 还可能真配出一个莫名其妙的分数挂在页面上。
    document.body.innerHTML = '<main><h1>Prime Video</h1></main>';
    expect(extractFromDetail(document.querySelector('main')!)).toBeNull();
  });
});

describe('详情页：提取', () => {
  /** jsdom 默认 URL 不是详情页，用 history 改掉。 */
  function onDetailPage(html: string): HTMLElement {
    window.history.replaceState({}, '', '/detail/0ABCDEF123/ref=dv');
    document.body.innerHTML = html;
    return document.querySelector<HTMLElement>('main')!;
  }

  it('从 h1 读出片名，从元信息里捞年份', () => {
    const root = onDetailPage(`
      <main>
        <h1 data-automation-id="title">沙丘</h1>
        <div data-automation-id="meta-info">2021 · 2 小时 35 分钟 · 13+ · 4K UHD</div>
      </main>`);
    expect(extractFromDetail(root)).toMatchObject({ title: '沙丘', year: 2021 });
  });

  it('出现分季选择器时判定为剧集', () => {
    const root = onDetailPage(`
      <main>
        <h1>黑袍纠察队</h1>
        <div data-automation-id="season-selector">第 1 季</div>
      </main>`);
    expect(extractFromDetail(root)?.type).toBe('tv');
  });

  it('没有剧集信号时类型保持 unknown 而不是猜成电影', () => {
    const root = onDetailPage('<main><h1>沙丘</h1></main>');
    expect(extractFromDetail(root)?.type).toBe('unknown');
  });

  it('不会把分级 13+ 之类的数字误当成年份', () => {
    const root = onDetailPage(`
      <main><h1>沙丘</h1><div data-automation-id="meta-info">13+ · 2 小时 35 分钟</div></main>`);
    expect(extractFromDetail(root)?.year).toBeUndefined();
  });
});

describe('选择器清单本身', () => {
  it('卡片选择器认的是路由，不是 class', () => {
    // 这条断言看着琐碎，但它守的是一个设计决定：Prime Video 的 class 是
    // CSS-in-JS 哈希（_1x_1 这种），每次构建都变；而「点开一部片会跳到
    // /detail/<ASIN>」是产品对用户的路由契约。哪天有人图省事换成 class
    // 选择器，这条会立刻拦下来。
    for (const selector of PRIMEVIDEO_SELECTORS.card) {
      expect(selector).toContain('detail/');
      expect(selector.startsWith('.')).toBe(false);
    }
  });

  it('通用 DOM 助手对 Prime Video 的候选清单同样适用', () => {
    document.body.innerHTML = '<a href="/detail/0ABC/"><div><img alt="片名"></div></a>';
    const el = document.querySelector<HTMLElement>('a')!;
    expect(readFirstText(el, PRIMEVIDEO_SELECTORS.cardTitle)).toBe('片名');
    // 紧贴封面图的那一层就是角标的落点。
    expect(queryFirst(el, PRIMEVIDEO_SELECTORS.cardAnchor)?.tagName).toBe('DIV');
  });

  it('封面图没有包裹层时解析不到落点 —— 由运行时退回整张卡片', () => {
    // 这不是缺陷，是刻意的：真实结构还没验证过，落点解析失败必须能优雅降级，
    // 而不是让整张卡片没有角标。site.ts 里那句 `?? card` 就是这条兜底。
    document.body.innerHTML = '<a href="/detail/0ABC/"><img alt="片名"></a>';
    const el = document.querySelector<HTMLElement>('a')!;
    expect(queryFirst(el, PRIMEVIDEO_SELECTORS.cardAnchor)).toBeNull();
  });
});
