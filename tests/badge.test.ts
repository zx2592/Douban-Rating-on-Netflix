// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_CLASS, removeBadge, upsertBadge } from '../src/content/badge';

function anchorFixture(): HTMLElement {
  document.body.innerHTML = '<a class="boxart-container" href="/watch/1"></a>';
  return document.querySelector<HTMLElement>('.boxart-container')!;
}

function badgeIn(anchor: HTMLElement): HTMLElement | null {
  return anchor.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
}

const RATED = {
  kind: 'rated' as const,
  score: 8.7,
  votes: 254321,
  url: 'https://movie.douban.com/subject/35131346/',
  title: '河边的错误',
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('upsertBadge', () => {
  it('注入角标并显示分数', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    const badge = badgeIn(anchor)!;
    expect(badge.querySelector('.dbr-value')?.textContent).toBe('8.7');
    expect(badge.querySelector('.dbr-logo')?.textContent).toBe('豆');
  });

  it('重复调用只更新不重复插入', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: { kind: 'loading' } });
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    expect(anchor.querySelectorAll(`.${BADGE_CLASS}`)).toHaveLength(1);
    expect(badgeIn(anchor)?.querySelector('.dbr-value')?.textContent).toBe('8.7');
  });

  it('从 loading 切到 rated 时旧的状态 class 会被清掉', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: { kind: 'loading' } });
    expect(badgeIn(anchor)?.classList.contains('dbr-state-loading')).toBe(true);

    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    const badge = badgeIn(anchor)!;
    expect(badge.classList.contains('dbr-state-loading')).toBe(false);
    expect(badge.classList.contains('dbr-state-rated')).toBe(true);
  });

  it('按分数打上不同的档位 class', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    expect(badgeIn(anchor)?.classList.contains('dbr-tier-high')).toBe(true);

    upsertBadge(anchor, {
      variant: 'card',
      position: 'top-left',
      identity: 'a',
      state: { ...RATED, score: 5.2 },
    });
    const badge = badgeIn(anchor)!;
    expect(badge.classList.contains('dbr-tier-low')).toBe(true);
    expect(badge.classList.contains('dbr-tier-high')).toBe(false);
  });

  it('位置和形态反映在 class 上', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'modal', position: 'bottom-right', identity: 'a', state: RATED });
    const badge = badgeIn(anchor)!;
    expect(badge.classList.contains('dbr-modal')).toBe(true);
    expect(badge.classList.contains('dbr-pos-bottom-right')).toBe(true);
  });

  it('暂无评分时显示破折号而不是 0', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, {
      variant: 'card',
      position: 'top-left',
      identity: 'a',
      state: { kind: 'unrated', url: RATED.url, title: RATED.title },
    });
    expect(badgeIn(anchor)?.querySelector('.dbr-value')?.textContent).toBe('—');
  });

  it('给卡片容器补上定位参考系，否则绝对定位会跑到页面角落', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    expect(anchor.style.position).toBe('relative');
  });

  it('tooltip 里给出评分、片名和评价人数', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    const title = badgeIn(anchor)!.title;
    expect(title).toContain('8.7');
    expect(title).toContain('河边的错误');
    expect(title).toContain('25.4 万人评价');
  });
});

describe('角标的点击行为', () => {
  it('点击在新标签页打开豆瓣条目', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    badgeIn(anchor)!.click();
    expect(open).toHaveBeenCalledWith(RATED.url, '_blank', 'noopener,noreferrer');
  });

  it('点击不会连带触发 Netflix 自己的跳转', () => {
    // 角标位于 Netflix 的 <a> 内部，不拦住冒泡的话点评分会开始播片。
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = anchorFixture();
    const parentClick = vi.fn();
    anchor.addEventListener('click', parentClick);

    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    badgeIn(anchor)!.click();

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('未收录时不可点击', () => {
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: { kind: 'missing' } });
    expect(badgeIn(anchor)?.hasAttribute('role')).toBe(false);
  });

  it('状态更新后点击跳到新的条目，而不是旧的', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    upsertBadge(anchor, {
      variant: 'card',
      position: 'top-left',
      identity: 'b',
      state: { ...RATED, url: 'https://movie.douban.com/subject/999/' },
    });

    badgeIn(anchor)!.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://movie.douban.com/subject/999/', '_blank', 'noopener,noreferrer');
  });

  it('可以用键盘打开，且支持 Tab 聚焦', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    const badge = badgeIn(anchor)!;
    expect(badge.getAttribute('tabindex')).toBe('0');
    badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(open).toHaveBeenCalled();
  });

  it('按其它键不会误触发跳转', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const anchor = anchorFixture();
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    badgeIn(anchor)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });
});

describe('removeBadge', () => {
  it('移除角标且不动其它子节点', () => {
    const anchor = anchorFixture();
    anchor.innerHTML = '<img class="boxart-image" />';
    upsertBadge(anchor, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });

    removeBadge(anchor);
    expect(badgeIn(anchor)).toBeNull();
    expect(anchor.querySelector('.boxart-image')).not.toBeNull();
  });

  it('没有角标时调用也不报错', () => {
    expect(() => removeBadge(anchorFixture())).not.toThrow();
  });
});

describe('跨挂载点去重', () => {
  /** 一张卡片，内含两个可能被解析成 anchor 的容器。 */
  function cardFixture(): { card: HTMLElement; first: HTMLElement; second: HTMLElement } {
    document.body.innerHTML = `
      <a data-uia="standard-card" aria-label="绝命毒师">
        <div class="wrap-a"><img src="a.jpg"></div>
        <div class="wrap-b"><img src="b.jpg"></div>
      </a>`;
    return {
      card: document.querySelector<HTMLElement>('[data-uia="standard-card"]')!,
      first: document.querySelector<HTMLElement>('.wrap-a')!,
      second: document.querySelector<HTMLElement>('.wrap-b')!,
    };
  }

  it('挂载点变了之后，整张卡片上仍然只有一个角标', () => {
    // Netflix 重渲染后 cardAnchor 可能解析到另一个元素。不跨挂载点清理的话，
    // 旧角标留在原处、新角标挂到新元素上，两个都是 absolute 定位在同一个角，
    // 看起来就是两个「豆」并排 —— 用户反馈的「豆 豆子」正是这个。
    const { card, first, second } = cardFixture();
    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);
    upsertBadge(second, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);

    expect(card.querySelectorAll(`.${BADGE_CLASS}`)).toHaveLength(1);
    expect(second.querySelector(`.${BADGE_CLASS}`)).not.toBeNull();
  });

  it('角标内部始终是一个「豆」字加一个评分', () => {
    const { card, first } = cardFixture();
    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);
    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);

    const badge = card.querySelector<HTMLElement>(`.${BADGE_CLASS}`)!;
    expect(badge.querySelectorAll('.dbr-logo')).toHaveLength(1);
    expect(badge.querySelectorAll('.dbr-value')).toHaveLength(1);
    expect(badge.textContent).toBe('豆8.7');
  });

  it('结构被外力搞坏后，下一次更新能自愈', () => {
    const { card, first } = cardFixture();
    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);

    // 模拟多出一个 logo 的坏结构。
    const badge = card.querySelector<HTMLElement>(`.${BADGE_CLASS}`)!;
    const extra = document.createElement('span');
    extra.className = 'dbr-logo';
    extra.textContent = '豆';
    badge.append(extra);
    expect(badge.querySelectorAll('.dbr-logo')).toHaveLength(2);

    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED }, card);
    expect(badge.querySelectorAll('.dbr-logo')).toHaveLength(1);
  });

  it('removeBadge 清掉整张卡片上的所有角标', () => {
    const { card, first, second } = cardFixture();
    upsertBadge(first, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    upsertBadge(second, { variant: 'card', position: 'top-left', identity: 'a', state: RATED });
    expect(card.querySelectorAll(`.${BADGE_CLASS}`)).toHaveLength(2);

    removeBadge(card);
    expect(card.querySelectorAll(`.${BADGE_CLASS}`)).toHaveLength(0);
  });
});
