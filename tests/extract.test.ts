// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanTitle, extractFromCard, extractFromModal, queryIdentity } from '../src/content/netflix/extract';
import { NETFLIX_SELECTORS, queryFirst, readFirstText } from '../src/content/netflix/selectors';

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

const CARD_HTML = `
<div class="slider-item slider-item-0">
  <div class="title-card-container">
    <div class="title-card title-card-0">
      <div class="ptrack-content">
        <a href="/watch/80057281?tctx=0%2C0%2C" class="slider-refocus" aria-label="怪奇物语" role="link">
          <div class="boxart-size-16x9 boxart-container">
            <img class="boxart-image" src="https://occ-0.example/art.jpg" alt="" />
            <div class="fallback-text-container"><p class="fallback-text">怪奇物语</p></div>
          </div>
        </a>
      </div>
    </div>
  </div>
</div>`;

describe('extractFromCard', () => {
  it('从 aria-label 里读出标题', () => {
    const root = render(CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toEqual({ title: '怪奇物语', type: 'unknown' });
  });

  it('没有 aria-label 时退回到降级文本', () => {
    const root = render(CARD_HTML.replace('aria-label="怪奇物语"', ''));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)?.title).toBe('怪奇物语');
  });

  it('只剩封面 alt 时也能拿到标题', () => {
    const root = render(`
      <div class="title-card">
        <a class="slider-refocus" href="/watch/1">
          <div class="boxart-container">
            <img class="boxart-image" alt="鱿鱼游戏" src="x.jpg" />
          </div>
        </a>
      </div>`);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)?.title).toBe('鱿鱼游戏');
  });

  it('标题里带季数后缀时解析出季数', () => {
    const root = render(CARD_HTML.replace('aria-label="怪奇物语"', 'aria-label="怪奇物语 第四季"'));
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toMatchObject({ title: '怪奇物语 第四季', season: 4 });
  });

  it('完全读不到标题时返回 null，而不是抛异常', () => {
    const root = render('<div class="title-card"><div class="boxart-container"></div></div>');
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    expect(extractFromCard(card)).toBeNull();
  });

  it('能定位到用于挂角标的封面容器', () => {
    const root = render(CARD_HTML);
    const card = queryFirst(root, NETFLIX_SELECTORS.card)!;
    const anchor = queryFirst(card, NETFLIX_SELECTORS.cardAnchor);
    expect(anchor?.classList.contains('boxart-container')).toBe(true);
  });
});

const MODAL_HTML = `
<div class="previewModal--container detail-modal">
  <div class="previewModal--player-titleTreatment-wrapper">
    <img data-uia="previewModal--player-titleTreatment-logo" alt="河边的错误" src="logo.png" />
  </div>
  <div class="videoMetadata--container">
    <div class="videoMetadata--first-line" data-uia="video-metadata">
      <span class="year">2023</span>
      <span class="duration">1 小时 41 分钟</span>
    </div>
  </div>
</div>`;

describe('extractFromModal', () => {
  it('同时拿到标题和年份', () => {
    const root = render(MODAL_HTML);
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)).toMatchObject({ title: '河边的错误', year: 2023 });
  });

  it('出现分季选择器时判定为剧集', () => {
    const root = render(
      MODAL_HTML.replace('</div>\n</div>', '<div data-uia="episode-selector"></div></div></div>'),
    );
    const modal = queryFirst(root, NETFLIX_SELECTORS.modal)!;
    expect(extractFromModal(modal)?.type).toBe('tv');
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
    expect(queryFirst(modal, NETFLIX_SELECTORS.modalAnchor)).not.toBeNull();
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
