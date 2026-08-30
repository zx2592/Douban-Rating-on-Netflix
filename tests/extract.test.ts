// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanTitle, extractFromCard, extractFromModal, queryIdentity } from '../src/content/netflix/extract';
import { queryFirst, readFirstText } from '../src/content/dom';
import { NETFLIX_SELECTORS } from '../src/content/netflix/selectors';
import { normalizeTitle } from '../src/shared/text';

/**
 * 这里的 HTML 按 Netflix 实际渲染的结构简化而来。Netflix 会改版，所以这些
 * 用例的价值不在于"锁死当前 DOM"，而在于保证提取逻辑对各种结构变体
 * （拿不到 aria-label、只有封面 alt、标题里带年份等）都有确定的行为。
 */

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * 下面两段 HTML 是从线上 netflix.com/browse 实地抓下来的，只删掉了超长的图片
 * URL。之前这里放的是凭记忆写的结构，结果单测全绿而线上一张卡片都匹配不到 ——
 * 这类适配器的测试，fixture 的真实性比用例数量重要得多。
 *
 * 注意 class 全是 CSS-in-JS 生成的哈希名（default-ltr-iqcdef-cache-19c3xp8），
 * 每次构建都会变，选择器一个都不能依赖它们，只能走 data-uia。
 */
const CARD_HTML = `
<div data-virtual-slot="4" class="default-ltr-iqcdef-cache-1uo9crx">
  <div>
    <div class="default-ltr-iqcdef-cache-1tbetht">
      <a href="/browse?jbv=81234567" tabindex="0" aria-label="怪奇物语"
         data-uia="standard-card" class="default-ltr-iqcdef-cache-19c3xp8">
        <div class="default-ltr-iqcdef-cache-lbc">
          <img src="https://occ-0.nflxso.net/art.webp" alt=""
               class="standard-card tracked-card default-ltr-iqcdef-cache-1jwv0y5"
               width="229" height="129">
        </div>
      </a>
    </div>
  </div>
</div>`;

/** 云游戏卡片，结构和影片卡片一模一样，只有 data-uia 不同。 */
const CLOUD_GAME_HTML = `
<div data-virtual-slot="5" class="default-ltr-iqcdef-cache-1uo9crx">
  <div>
    <div class="default-ltr-iqcdef-cache-1tbetht">
      <a href="/browse?jbv=82027565" tabindex="0" aria-label="Netflix Minigolf"
         data-uia="cloud-game-card" class="default-ltr-iqcdef-cache-19c3xp8">
        <div class="default-ltr-iqcdef-cache-lbc">
          <img src="https://occ-0.nflxso.net/game.webp" alt=""
               class="cloud-game-card tracked-card default-ltr-iqcdef-cache-1jwv0y5">
        </div>
      </a>
    </div>
  </div>
</div>`;

/** 老版 Netflix 的卡片结构，保留兜底能力（Netflix 会做 A/B 实验）。 */
const LEGACY_CARD_HTML = `
<div class="title-card">
  <div class="ptrack-content">
    <a href="/watch/80057281" class="slider-refocus" aria-label="怪奇物语">
      <div class="boxart-size-16x9 boxart-container">
        <img class="boxart-image" src="art.jpg" alt="">
        <div class="fallback-text-container"><p class="fallback-text">怪奇物语</p></div>
      </div>
    </a>
  </div>
</div>`;

describe('extractFromCard（线上真实结构）', () => {
  it('用 data-uia 找到卡片，从 aria-label 读出标题', () => {
    const root = render(CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toEqual({ title: '怪奇物语', type: 'unknown' });
  });

  it('aria-label 在卡片元素自身上时也能读到', () => {
    // 新版的 aria-label 就挂在卡片 <a> 上，而 querySelector 只找后代，
    // 少了 ':self' 这条取值方式就会整体失效。
    const root = render(CARD_HTML);
    const card = root.querySelector<HTMLElement>('[data-uia="standard-card"]')!;
    expect(card.hasAttribute('aria-label')).toBe(true);
    expect(extractFromCard(card)?.title).toBe('怪奇物语');
  });

  it('角标落点是紧贴封面图的那一层，不是整张卡片', () => {
    const root = render(CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    const anchor = queryFirst(card, NETFLIX_SELECTORS.cardAnchor)!;
    expect(anchor.querySelector(':scope > img')).not.toBeNull();
  });

  it('云游戏卡片不会被当成影片', () => {
    // 结构和影片卡片完全一样，只有 data-uia 不同。把「Netflix Minigolf」
    // 拿去查豆瓣既查不到，又白白消耗掉限流配额。
    const root = render(CLOUD_GAME_HTML);
    expect(queryFirst(root, NETFLIX_SELECTORS.card)).toBeNull();
  });

  it('同一页里混着影片和云游戏时，只挑出影片', () => {
    const root = render(CARD_HTML + CLOUD_GAME_HTML);
    const cards = root.querySelectorAll(NETFLIX_SELECTORS.card.join(', '));
    const titles = [...cards].map((card) => extractFromCard(card as HTMLElement)?.title);
    expect(titles).toContain('怪奇物语');
    expect(titles).not.toContain('Netflix Minigolf');
  });

  it('CSS-in-JS 的哈希 class 变了也不受影响', () => {
    // 这些 class 每次构建都会变，选择器绝不能依赖它们。
    const root = render(CARD_HTML.replace(/default-ltr-iqcdef-cache-\w+/g, 'css-9f8e7d'));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)?.title).toBe('怪奇物语');
  });

  it('标题里带季数后缀时解析出季数', () => {
    const root = render(CARD_HTML.replace('aria-label="怪奇物语"', 'aria-label="怪奇物语 第四季"'));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toMatchObject({ title: '怪奇物语 第四季', season: 4 });
  });

  it('读不到标题时返回 null，而不是抛异常', () => {
    const root = render(CARD_HTML.replace('aria-label="怪奇物语"', ''));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toBeNull();
  });
});

describe('extractFromCard（老版结构兜底）', () => {
  it('老版卡片依然能识别', () => {
    const root = render(LEGACY_CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)?.title).toBe('怪奇物语');
  });

  it('老版没有 aria-label 时退回到降级文本', () => {
    const root = render(LEGACY_CARD_HTML.replace('aria-label="怪奇物语"', ''));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)?.title).toBe('怪奇物语');
  });

  it('老版的角标落点是封面容器', () => {
    const root = render(LEGACY_CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    const anchor = queryFirst(card, NETFLIX_SELECTORS.cardAnchor);
    expect(anchor?.classList.contains('boxart-container')).toBe(true);
  });
});

/**
 * 悬停时弹出的迷你详情层，抓自线上（图片 URL 已缩短、结构未改）。
 * 注意 previewModal--container 这个老类名在新版里活了下来，
 * 而片名藏在封面图的 alt 属性上。
 */
const MODAL_HTML = `
<div role="dialog" aria-modal="true" tabindex="-1"
     data-uia="modal-motion-container-MINI_MODAL"
     class="previewModal--container has-smaller-buttons mini-modal">
  <div class="previewModal--player_container mini-modal" data-uia="previewModal--player_container">
    <div><div id="81375013"><video data-videoid="81375013"></video></div></div>
    <div class="videoMerchPlayer--boxart-wrapper">
      <img alt="星艦戰將" src="art.webp" class="previewModal--boxart" aria-hidden="true">
      <img alt="" src="art.webp" aria-hidden="true">
      <img alt="星艦戰將" src="art.webp" class="previewModal--boxart">
    </div>
    <img alt="" src="logo.webp" aria-hidden="true">
  </div>
  <div class="previewModal--info-container" data-uia="previewModal--info-container">
    <div data-uia="previewModal--metadatAndControls">
      <div class="videoMetadata--container" data-uia="videoMetadata--container">
        <span data-uia="maturity-rating">15+</span>
        <span>1997</span>
        <span data-uia="player-feature-badge-hd">HD</span>
      </div>
    </div>
  </div>
</div>`;

describe('extractFromModal（线上迷你弹层）', () => {
  it('从封面图的 alt 读出片名', () => {
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)?.title).toBe('星艦戰將');
  });

  it('跳过 alt 为空的那张图，不会取到空标题', () => {
    // 弹层里有好几个 img，只有带 previewModal--boxart 类的才有片名。
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)).not.toBeNull();
  });

  it('年份混在分级和画质标记中间时也能捞出来', () => {
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)?.year).toBe(1997);
  });

  it('不会把分级 15+ 之类的数字误当成年份', () => {
    const root = render(MODAL_HTML.replace('<span>1997</span>', ''));
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)?.year).toBeUndefined();
  });

  it('出现分季选择器时判定为剧集', () => {
    const root = render(MODAL_HTML.replace('</div>\n</div>`', '</div><div data-uia="episode-selector"></div></div>'));
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)).not.toBeNull();
  });

  it('没有剧集信号时类型保持 unknown 而不是猜成电影', () => {
    // 猜错类型会让匹配器给出错误的加减分，不如老实说不知道。
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)?.type).toBe('unknown');
  });

  it('能定位到用于挂角标的元数据行', () => {
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    const anchor = queryFirst(modal, NETFLIX_SELECTORS.modalAnchor);
    expect(anchor?.getAttribute('data-uia')).toBe('videoMetadata--container');
  });

  it('繁体片名会被归一化，便于和豆瓣的简体条目匹配', () => {
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    const query = extractFromModal(modal)!;
    expect(normalizeTitle(query.title)).toBe(normalizeTitle('星舰战将'));
  });
});

describe('cleanTitle', () => {
  it('压缩多余空白', () => {
    expect(cleanTitle('  Stranger   Things  ').title).toBe('Stranger Things');
  });

  it('把括号里的年份单独摘出来', () => {
    expect(cleanTitle('Ghostbusters (2016)')).toEqual({ title: 'Ghostbusters', year: 2016 });
    expect(cleanTitle('捉鬼敢死队（1984）')).toEqual({ title: '捉鬼敢死队', year: 1984 });
  });

  it('不会把片名里本来就有的数字当成年份', () => {
    expect(cleanTitle('Blade Runner 2049').year).toBeUndefined();
    expect(cleanTitle('1917').year).toBeUndefined();
  });

  it('去掉包裹整个标题的引号', () => {
    expect(cleanTitle('《让子弹飞》').title).toBe('让子弹飞');
  });

  it('去掉零宽字符', () => {
    expect(cleanTitle('怪奇​物语').title).toBe('怪奇物语');
  });
});

describe('queryIdentity', () => {
  it('同一部片子得到同一个标识', () => {
    expect(queryIdentity({ title: '教父', year: 1972, type: 'movie' })).toBe(
      queryIdentity({ title: '教父', year: 1972, type: 'movie' }),
    );
  });

  it('卡片被复用成另一部片子时标识会变', () => {
    // 内容脚本靠这个判断"响应回来时这张卡片还是不是原来那部片"。
    expect(queryIdentity({ title: '教父', type: 'movie' })).not.toBe(
      queryIdentity({ title: '教父 2', type: 'movie' }),
    );
  });
});

describe('选择器工具', () => {
  it('按顺序返回第一个命中的文本来源', () => {
    const root = render('<div><span class="b">备选</span></div>');
    const text = readFirstText(root, [
      { selector: '.a', attr: null },
      { selector: '.b', attr: null },
    ]);
    expect(text).toBe('备选');
  });

  it('全部落空时返回 null', () => {
    const root = render('<div></div>');
    expect(readFirstText(root, [{ selector: '.nope', attr: null }])).toBeNull();
    expect(queryFirst(root, ['.nope'])).toBeNull();
  });

  it('内容为空白的元素不算命中', () => {
    const root = render('<div><span class="a">   </span><span class="b">真正的标题</span></div>');
    const text = readFirstText(root, [
      { selector: '.a', attr: null },
      { selector: '.b', attr: null },
    ]);
    expect(text).toBe('真正的标题');
  });
});
