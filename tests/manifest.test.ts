import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DETAIL_ROUTE } from '../src/content/primevideo/selectors';

/**
 * manifest 的匹配规则。
 *
 * 这组用例是补的 —— 补的是一个真实故障：Prime Video 那条只写了
 * `https://www.primevideo.com/*`，结果用户在 amazon 站点上打开，内容脚本
 * **根本没有注入**，`document.documentElement.dataset.dbrLoaded` 是 undefined。
 *
 * 这类错误特别难查，因为它和「选择器没匹配上」的表现只差一条 Console 警告：
 * 脚本没注入的话，连那条警告都不会有，页面上什么线索都没有。而所有单测都
 * 是绿的 —— 适配器、提取、主循环全都对，只是那段代码压根没机会跑。
 *
 * 所以把「脚本会不会在这些地址上跑起来」也变成断言。
 */

interface Manifest {
  content_scripts: Array<{ matches: string[]; js: string[] }>;
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as Manifest;

/**
 * Chrome 的 match pattern 判定（够用即可的实现）。
 *
 * 规则见 https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 * 关键的两点，也正是这次踩的坑：
 * - host 里的 `*.` 前缀同时匹配该域名本身和它的所有子域；
 * - 但**没有** `*.` 前缀时就是精确匹配 —— `www.primevideo.com` 匹配不到
 *   裸域名 `primevideo.com`。
 */
function matchesPattern(pattern: string, url: string): boolean {
  const parsed = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parsed) throw new Error(`无法解析的 match pattern: ${pattern}`);
  const [, scheme, hostPattern, pathPattern] = parsed;

  const target = new URL(url);
  if (scheme !== '*' && `${scheme}:` !== target.protocol) return false;

  if (hostPattern!.startsWith('*.')) {
    const base = hostPattern!.slice(2);
    if (target.hostname !== base && !target.hostname.endsWith(`.${base}`)) return false;
  } else if (hostPattern !== '*' && hostPattern !== target.hostname) {
    return false;
  }

  const pathRe = new RegExp(
    '^' + pathPattern!.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return pathRe.test(target.pathname + target.search);
}

function scriptFor(url: string): string | null {
  for (const entry of manifest.content_scripts) {
    if (entry.matches.some((pattern) => matchesPattern(pattern, url))) return entry.js[0]!;
  }
  return null;
}

describe('matchesPattern 自身', () => {
  it('*. 前缀同时匹配域名本身和子域', () => {
    expect(matchesPattern('https://*.primevideo.com/*', 'https://primevideo.com/')).toBe(true);
    expect(matchesPattern('https://*.primevideo.com/*', 'https://www.primevideo.com/x')).toBe(true);
  });

  it('没有 *. 前缀时是精确匹配 —— 这正是这次踩的坑', () => {
    expect(matchesPattern('https://www.primevideo.com/*', 'https://primevideo.com/')).toBe(false);
  });

  it('路径通配生效', () => {
    expect(matchesPattern('https://*.amazon.com/gp/video/*', 'https://www.amazon.com/gp/video/detail/B0X')).toBe(true);
    expect(matchesPattern('https://*.amazon.com/gp/video/*', 'https://www.amazon.com/dp/B0X')).toBe(false);
  });
});

describe('Prime Video 会在这些地址上注入', () => {
  const urls = [
    // 独立站点，含裸域名 —— 只写 www 的话这一条就漏了。
    'https://primevideo.com/',
    'https://www.primevideo.com/',
    'https://www.primevideo.com/storefront',
    'https://www.primevideo.com/detail/0ABCDEF123/ref=dv_web_1',
    'https://www.primevideo.com/region/eu/detail/0ABCDEF123',
    // 各区域 amazon 站点下的 Prime Video 路径。
    'https://www.amazon.com/gp/video/storefront',
    'https://www.amazon.com/gp/video/detail/B0XYZ12345',
    'https://www.amazon.co.jp/gp/video/storefront',
    'https://www.amazon.de/gp/video/detail/B0XYZ12345',
    'https://www.amazon.co.uk/gp/video/storefront',
    'https://www.amazon.in/gp/video/storefront',
  ];

  for (const url of urls) {
    it(url, () => {
      expect(scriptFor(url)).toBe('content-primevideo.js');
    });
  }
});

describe('不该注入的地方一律不注入', () => {
  const urls = [
    // 亚马逊购物页：和影片无关，注入进去纯属打扰，也过不了商店审核那一关。
    'https://www.amazon.com/dp/B0XYZ12345',
    'https://www.amazon.com/',
    'https://www.amazon.co.jp/gp/cart/view.html',
    // 其它站点
    'https://www.google.com/',
    'https://movie.douban.com/subject/1234/',
  ];

  for (const url of urls) {
    it(url, () => {
      expect(scriptFor(url)).toBeNull();
    });
  }
});

describe('Netflix 的匹配没被改坏', () => {
  it('列表页和详情页都注入', () => {
    expect(scriptFor('https://www.netflix.com/browse')).toBe('content-netflix.js');
    expect(scriptFor('https://www.netflix.com/title/80057281')).toBe('content-netflix.js');
  });
});

describe('适配器认的路由，manifest 一定要能注入', () => {
  it('DETAIL_ROUTE 能识别的详情页地址，都在匹配范围内', () => {
    // 这两者必须同步：适配器认得某个路由、但 manifest 不在那个域名上注入，
    // 等于代码写了却永远没机会跑 —— 而且所有单测照样是绿的。
    const detailUrls = [
      'https://www.primevideo.com/detail/0ABCDEF123/ref=dv',
      'https://www.amazon.com/gp/video/detail/B0XYZ12345/ref=atv',
    ];
    for (const url of detailUrls) {
      expect(DETAIL_ROUTE.test(new URL(url).pathname)).toBe(true);
      expect(scriptFor(url)).toBe('content-primevideo.js');
    }
  });
});
