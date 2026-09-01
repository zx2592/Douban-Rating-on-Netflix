// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { queryFirst, readFirstText } from '../src/content/dom';
import { extractFromCard, extractFromDetail, isDetailPage, mediaTypeFromEntity } from '../src/content/primevideo/extract';
import { PRIMEVIDEO_SELECTORS } from '../src/content/primevideo/selectors';

/**
 * Prime Video 适配器。
 *
 * 下面「线上真实结构」那几组的 fixture 是**从实际页面抓回来的**（用户跑
 * scripts/dom-probe.js 打回的报告），class 名、data-* 属性、嵌套层级都照抄。
 * 这一点很重要：第一版是照推测写的，单测全绿，线上却把播放按钮当成了影片，
 * 真的拿「Watch now」去查了评分。
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
  it('卡片选择器一律不依赖 class', () => {
    // 守的是一个设计决定：Prime Video 的 class 全是 CSS-in-JS 哈希
    // （VfXkrJ、_1jWggM、shared-poster-link T57EsW 这种），每次构建都变，
    // 依赖它们等于埋雷。允许的依据只有两类：站点自己的 data-* 卡片标记，
    // 以及 /detail/<ASIN> 这个路由契约。
    for (const selector of PRIMEVIDEO_SELECTORS.card) {
      expect(selector.includes('.')).toBe(false);
      expect(/\[data-|detail\//.test(selector)).toBe(true);
    }
  });

  it('至少保留一条纯路由的兜底 —— data-testid 改名时还有救', () => {
    expect(PRIMEVIDEO_SELECTORS.card.some((s) => s.includes('href*="/detail/"'))).toBe(true);
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

describe('线上真实结构：影片卡片', () => {
  /** 实测抓回来的卡片：class 名和 data-* 属性照抄，只缩短了 href。 */
  const POSTER_CARD = `
    <li class="NQEYQF egDugf" data-index="1">
      <article class="N6UUyI gM80sQ ae7h_p" data-testid="super-carousel-card">
        <a class="shared-poster-link T57EsW uVZmyh" href="/detail/0K16R3PLUFGC2JUE457C26O4OD?jic=48"
           aria-label="Reacher" data-testid="poster-link">
          <picture><img class="bU9P_6 X6Hqju znZ24z" alt="Reacher" data-testid="base-image"></picture>
        </a>
      </article>
    </li>`;

  it('认出 poster-link 卡片并读出片名', () => {
    document.body.innerHTML = POSTER_CARD;
    const el = document.querySelector<HTMLElement>('a[data-testid="poster-link"]')!;
    expect(extractFromCard(el)).toMatchObject({ title: 'Reacher' });
  });

  it('封面图的父层是 <picture>，角标落点要认得它', () => {
    // 第一版只写了 div:has(> img)，实测所有卡片的落点都解析失败、
    // 全部退回整张卡片 —— 角标于是跑到卡片左上角而不是封面左上角。
    document.body.innerHTML = POSTER_CARD;
    const el = document.querySelector<HTMLElement>('a[data-testid="poster-link"]')!;
    expect(queryFirst(el, PRIMEVIDEO_SELECTORS.cardAnchor)).not.toBeNull();
  });

  it('poster-link 仍在清单里 —— 有些行用的是这种卡片', () => {
    // 容器（data-card-title）信息更全所以排第一，但轮播行里的
    // poster-link 卡片没有容器，这一条不能丢。
    expect(PRIMEVIDEO_SELECTORS.card.some((s) => s.includes('poster-link'))).toBe(true);
  });
});

describe('线上真实结构：必须排除的「假卡片」', () => {
  /**
   * 这三个都指向 /detail/<ASIN>，光看 href 和真卡片没有区别。
   * 实测页面上 181 个链接命中路由，其中大量是这类东西。
   */
  it('播放按钮不是影片 —— 扩展真的拿「Watch now」查过评分', () => {
    document.body.innerHTML = `
      <a class="_1jWggM fbl-play-btn" href="/detail/0K04DMLEJSTE354379LLPZ9ZAN?autoplay=1"
         aria-disabled="false" data-testid="play" data-automation-id="play" aria-label="Watch now">
        PlayWatch now
      </a>`;
    const el = document.querySelector<HTMLElement>('a')!;
    expect(extractFromCard(el)).toBeNull();
  });

  it('aria-hidden 的重复链接不是影片', () => {
    // 同一部片在 hero 区域有三个链接：封面、标题美术字、播放按钮。
    // 标题美术字那个整体 aria-hidden，是给读屏软件隐藏的重复项。
    document.body.innerHTML = `
      <h2 class="jCQTBM" data-testid="title-art" aria-label="Sing 2" aria-hidden="true">
        <a href="/detail/B09PMKBRJ7?jic=16"><picture><img alt="Sing 2" data-testid="base-image"></picture></a>
      </h2>`;
    const el = document.querySelector<HTMLElement>('a')!;
    expect(extractFromCard(el)).toBeNull();
  });

  it('CSS 选择器层面也把这些挡掉，不只靠提取函数', () => {
    // 两道防线：选择器不去观察它们（省掉 IntersectionObserver 的开销），
    // 提取函数再兜一次（应对选择器没覆盖到的变体）。
    document.body.innerHTML = `
      <a href="/detail/AAA" data-testid="play" aria-label="Watch now"></a>
      <a href="/detail/BBB" aria-hidden="true" aria-label="X"></a>
      <a href="/detail/CCC" data-testid="poster-link" aria-label="真影片"></a>`;
    const matched = document.querySelectorAll(PRIMEVIDEO_SELECTORS.card.join(', '));
    expect([...matched].map((el) => el.getAttribute('href'))).toEqual(['/detail/CCC']);
  });
});

describe('线上真实结构：data-card-title', () => {
  it('卡片容器上的 data-card-title 优先于 aria-label', () => {
    // 实测页面上 data-card-title 出现 155 次，和真实卡片数量吻合；
    // 它是站点放在卡片容器上的片名，比 aria-label 专一
    // （aria-label 在按钮上会是动作文案）。
    document.body.innerHTML = `
      <div data-card-title="正确的片名" data-card-position="3">
        <a href="/detail/0ABC" aria-label="别的文案"><picture><img alt="又一个"></picture></a>
      </div>`;
    const el = document.querySelector<HTMLElement>('[data-card-title]')!;
    expect(extractFromCard(el)?.title).toBe('正确的片名');
  });

  it('卡片容器不是 <a> 时，也能从后代链接上取到 href 做路由校验', () => {
    document.body.innerHTML = `
      <div data-card-title="某片"><a href="/help">帮助</a></div>`;
    const el = document.querySelector<HTMLElement>('[data-card-title]')!;
    // 后代链接不是详情页地址 → 不是影片卡片。
    expect(extractFromCard(el)).toBeNull();
  });
});

describe('线上真实结构：卡片容器', () => {
  /**
   * 实测抓回来的完整卡片：容器带片名和类型，链接在里面两层。
   * class 名、data-* 属性、嵌套层级全部照抄报告。
   */
  const REAL_CARD = `
    <article class="ulDoOY I3vXhO ae7h_p" data-card-title="Bring It On"
             data-card-entity-type="Movie" data-card-entitlement="Entitled"
             data-card-position="2" data-card-can-hover="true" data-testid="card"
             data-card-playback-behaviour="EXPANDED">
      <section class="qFCD8F Hbj8Gx" data-testid="card-section">
        <div class="BVySw9 jaSqrZ" data-testid="packshot">
          <a class="zyfcZQ" href="/detail/0QX0P4OK8HRX488C6WE3IXVRCO?jic=64"></a>
        </div>
      </section>
    </article>`;

  it('从容器上读出片名', () => {
    document.body.innerHTML = REAL_CARD;
    const el = document.querySelector<HTMLElement>('[data-card-title]')!;
    expect(extractFromCard(el)?.title).toBe('Bring It On');
  });

  it('从容器上读出类型 —— Netflix 那边没有的信号', () => {
    // 在此之前列表卡片一律只能发 type: 'unknown'，匹配器拿不到消歧信号。
    document.body.innerHTML = REAL_CARD;
    const el = document.querySelector<HTMLElement>('[data-card-title]')!;
    expect(extractFromCard(el)?.type).toBe('movie');
  });

  it('角标落点是 packshot，不再退回整张卡片', () => {
    document.body.innerHTML = REAL_CARD;
    const el = document.querySelector<HTMLElement>('[data-card-title]')!;
    expect(queryFirst(el, PRIMEVIDEO_SELECTORS.cardAnchor)?.getAttribute('data-testid')).toBe('packshot');
  });

  it('同一部片只算一张卡片，容器和内部链接不重复命中', () => {
    // 实测：170 张卡片留下了 327 个身份标记 —— 容器和内部的 <a> 都被
    // 当成卡片各处理了一遍。同一部片查两次、可能挂两个角标。
    document.body.innerHTML = REAL_CARD;
    const matched = document.querySelectorAll(PRIMEVIDEO_SELECTORS.card.join(', '));
    expect(matched).toHaveLength(1);
    expect(matched[0]!.getAttribute('data-card-title')).toBe('Bring It On');
  });

  it('容器排在选择器清单最前 —— 它的信息最全', () => {
    expect(PRIMEVIDEO_SELECTORS.card[0]).toBe('[data-card-title]');
  });
});

describe('mediaTypeFromEntity', () => {
  it('实测值 Movie 归为电影', () => {
    expect(mediaTypeFromEntity('Movie')).toBe('movie');
  });

  it('剧集侧的几种可能写法都归为剧集', () => {
    // 剧集的确切取值还没在实测里见到，所以用「包含」而不是等值判断：
    // 猜错一个字面量会让所有剧集掉回 unknown，包含判断最差也只是回到原状。
    for (const value of ['TV Show', 'tvSeries', 'Series', 'Season']) {
      expect(mediaTypeFromEntity(value)).toBe('tv');
    }
  });

  it('没见过的取值保持 unknown，不猜', () => {
    expect(mediaTypeFromEntity('LiveEvent')).toBe('unknown');
    expect(mediaTypeFromEntity(null)).toBe('unknown');
    expect(mediaTypeFromEntity('')).toBe('unknown');
  });
});

describe('线上真实结构：hero 操作区', () => {
  /**
   * 实测抓回来的操作区。这里面全是按钮，一个影片卡片都没有，但它们的
   * href 都指向 /detail/<ASIN>，光看路由和真卡片没有区别。
   *
   * 这个坑踩了两次：先撞见播放按钮（aria-label="Watch now"），排掉之后
   * 又撞见 Info 按钮（aria-label="More details for Sing 2"）—— 两次都真的
   * 拿这些文案去查了评分。所以改成按结构整片排除，不再逐个列举按钮名。
   */
  const ACTION_BOX = `
    <div class="oVqY8q" data-testid="title-metadata-main">
      <div class="imzVmU XZjb4R sQqF2N" data-testid="action-box">
        <div class="dJNwJc">
          <a class="_1jWggM fbl-play-btn" href="/detail/0K04DMLEJSTE354379LLPZ9ZAN?autoplay=1"
             data-testid="play" data-automation-id="play" aria-label="Watch now">PlayWatch now</a>
        </div>
        <label class="jDcAoh" data-testid="details-icon" data-automation-id="details-icon">
          <a class="_39zede fbl-icon-btn" href="/detail/B09PMKBRJ7?jic=16"
             aria-label="More details for Sing 2">Info</a>
        </label>
      </div>
    </div>`;

  it('操作区里的按钮一个都不当成影片卡片', () => {
    document.body.innerHTML = ACTION_BOX;
    for (const el of document.querySelectorAll<HTMLElement>('a')) {
      expect(extractFromCard(el)).toBeNull();
    }
  });

  it('CSS 选择器层面也整片排除操作区', () => {
    document.body.innerHTML = ACTION_BOX;
    expect(document.querySelectorAll(PRIMEVIDEO_SELECTORS.card.join(', '))).toHaveLength(0);
  });

  it('按结构排除，而不是逐个列举按钮的 aria-label', () => {
    // 文案随界面语言变，列举永远追不上。这条断言守的是「排的是区域，
    // 不是文案」这个决定。
    const joined = PRIMEVIDEO_SELECTORS.card.join(' ');
    expect(joined).toContain('action-box');
    expect(joined.toLowerCase()).not.toContain('watch now');
    expect(joined.toLowerCase()).not.toContain('more details');
  });
});
