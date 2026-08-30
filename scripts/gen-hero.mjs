import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const css = readFileSync('dist/badge.css', 'utf8');

const part = (src, logo, value, tier = '', state = 'rated') =>
  `<span class="dbr-part dbr-src-${src} dbr-state-${state} ${tier}"><span class="dbr-logo">${logo}</span><span class="dbr-value">${value}</span></span>`;

// 每张卡片：封面 + 左上角的真实角标结构
const card = (title, sub, badge, hue) => `
  <figure class="card">
    <div class="art" style="--hue:${hue}">
      <div class="dbr-badge notranslate dbr-card dbr-pos-top-left" translate="no">${badge}</div>
      <div class="art-title">${title}</div>
      <div class="art-sub">${sub}</div>
    </div>
  </figure>`;

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 34px 30px 30px; background: #0b0b0b; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 4px; }
  .head h1 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: .2px; }
  .head .row-label { font-size: 12px; color: #7a7a7a; }
  .lede { font-size: 12px; color: #8a8a8a; margin: 0 0 22px; }
  .rail { display: flex; gap: 14px; }
  .card { margin: 0; width: 214px; }
  .art {
    position: relative; width: 214px; height: 120px; border-radius: 5px; overflow: hidden;
    background:
      radial-gradient(120% 100% at 15% 0%, hsl(var(--hue) 42% 32%) 0%, hsl(var(--hue) 30% 13%) 60%, #141414 100%);
    box-shadow: 0 2px 10px rgba(0,0,0,.5);
    display: flex; flex-direction: column; justify-content: flex-end; padding: 10px 11px;
  }
  .art::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(to top, rgba(0,0,0,.72) 0%, rgba(0,0,0,0) 55%);
  }
  .art-title { position: relative; z-index: 1; font-size: 13px; font-weight: 700; letter-spacing: .3px; }
  .art-sub { position: relative; z-index: 1; font-size: 10px; color: #b9b9b9; margin-top: 2px; }
  .note { margin: 22px 0 0; font-size: 12px; color: #757575; line-height: 1.85; }
  .note b { color: #c8c8c8; font-weight: 400; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; }
  ${css}
</style>

<div class="head">
  <h1>豆瓣 &amp; IMDb 评分 for Netflix</h1>
  <span class="row-label">— 封面角标实拍</span>
</div>
<p class="lede">两个评分并排显示在同一个角标里，各自可点，跳转对应条目。</p>

<div class="rail">
  ${card('BREAKING BAD', '剧集 · 2008', part('douban', '豆', '9.5', 'dbr-tier-high') + part('imdb', 'IMDb', '9.5'), 8)}
  ${card('鱿鱼游戏', '剧集 · 2021', part('douban', '豆', '7.6', 'dbr-tier-mid') + part('imdb', 'IMDb', '8.0'), 340)}
  ${card('STARSHIP TROOPERS', '电影 · 1997', part('douban', '豆', '8.0', 'dbr-tier-high') + part('imdb', 'IMDb', '7.3'), 210)}
  ${card('某冷门片', '电影 · 豆瓣未收录', part('imdb', 'IMDb', '6.4'), 30)}
</div>

<p class="note">
  <span class="sw" style="background:#2e963d"></span> <b>豆瓣</b> 按分数分档配色（8 分以上绿 / 6.5 以上黄 / 更低红）
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <span class="sw" style="background:#f5c518"></span> <b>IMDb</b> 统一用自己的金黄色
  <br>
  两个来源相互独立：一边被限流或未收录时，另一边照常显示（如最右一张）。
</p>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 980, height: 318 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.screenshot({ path: 'docs/badge-preview.png' });
await browser.close();
