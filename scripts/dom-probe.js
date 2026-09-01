/*
 * 流媒体站点的 DOM 结构探测器。
 *
 * 用法：在 Prime Video（或 Netflix）的**列表页**上打开 DevTools Console，
 * 把这个文件的全部内容粘进去回车。它会打印一份报告，整个复制回来即可。
 *
 * 为什么需要它：开发环境访问不了 primevideo.com，而且就算能访问，
 * 列表页也要登录、要分区域渲染 —— 抓不到真实 DOM。这个项目已经为
 * 「凭记忆写选择器」付过一次代价：v0.1 的 Netflix 选择器单测全绿，
 * 线上一张卡片都匹配不到，最后是靠用户从真实页面贴回 DOM 才改对的。
 *
 * 所以这个脚本刻意**不是**「检查我猜的选择器对不对」，而是**从零发现结构**：
 * 先按链接地址（路由契约，比 class 稳定得多）找出影片卡片，再把它周围的
 * 真实结构摊开。这样得出的选择器有实据，不是猜的。
 */
(() => {
  const MAX_SAMPLES = 3;
  const out = [];
  const say = (...parts) => out.push(parts.join(' '));

  const trunc = (text, n = 120) => {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n) + '…' : flat;
  };

  say('===== 页面 =====');
  say('URL      ', location.href);
  say('语言     ', document.documentElement.lang || '(未声明)');
  say('标题     ', trunc(document.title));
  say('扩展已注入', document.documentElement.dataset.dbrLoaded ?? '(否)');
  say('');

  // ---------------------------------------------------------------- 找卡片
  //
  // 按 href 里的路由模式找，而不是按 class 找：class 是样式，随时会变；
  // 详情页的 URL 形态是产品的路由契约，稳定得多。
  const ROUTES = [
    { label: 'Prime Video 详情', re: /\/detail\/[A-Z0-9]+/i },
    { label: 'Amazon 站内详情', re: /\/gp\/video\/detail\/[A-Z0-9]+/i },
    { label: 'Prime Video 播放', re: /\/(watch|video\/play)\//i },
    { label: 'Netflix 详情', re: /\/(watch|title)\/\d+/ },
    { label: 'Netflix jbv 参数', re: /[?&]jbv=\d+/ },
  ];

  const links = [...document.querySelectorAll('a[href]')];
  say('===== 链接分布 =====');
  say(`页面上共 ${links.length} 个 <a href>`);

  const buckets = new Map();
  for (const route of ROUTES) {
    const hit = links.filter((a) => route.re.test(a.getAttribute('href') || ''));
    if (hit.length > 0) buckets.set(route.label, hit);
    say(`  ${hit.length > 0 ? '✅' : '  '} ${route.label.padEnd(18)} ${hit.length} 个`);
  }
  say('');

  if (buckets.size === 0) {
    say('⚠️ 一个影片链接都没找到。可能不在列表页，或者路由形态和上面几种都不同。');
    say('   下面列出出现最多的前 10 种 href 前缀，供判断：');
    const prefixes = new Map();
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const key = href.split('/').slice(0, 3).join('/') || href;
      prefixes.set(key, (prefixes.get(key) ?? 0) + 1);
    }
    for (const [key, n] of [...prefixes].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      say(`     ${String(n).padStart(4)}  ${trunc(key, 80)}`);
    }
    console.log(out.join('\n'));
    return out.join('\n');
  }

  // -------------------------------------------------------- 摊开卡片的结构
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return '(无)';
    const attrs = [...el.attributes]
      // data-* 和 aria-* 是站点自己的测试钩子与无障碍属性，比 class 稳定得多。
      .filter((a) => a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'alt' || a.name === 'title')
      .map((a) => `${a.name}="${trunc(a.value, 60)}"`)
      .join(' ');
    const cls = el.className && typeof el.className === 'string' ? ` class="${trunc(el.className, 70)}"` : '';
    return `<${el.tagName.toLowerCase()}${cls}${attrs ? ' ' + attrs : ''}>`;
  };

  for (const [label, hits] of buckets) {
    say(`===== 卡片结构：${label}（共 ${hits.length}，取前 ${MAX_SAMPLES} 个）=====`);

    for (const link of hits.slice(0, MAX_SAMPLES)) {
      say('');
      say('  href     ', trunc(link.getAttribute('href'), 100));

      // 1. 这个链接自己带什么可以当标题用的东西
      say('  链接自身 ', describe(link));
      const selfText = trunc(link.textContent, 80);
      if (selfText) say('  链接文本 ', selfText);

      // 2. 往上四层：找哪一层是「一张卡片」，哪一层适合挂角标
      let node = link.parentElement;
      for (let depth = 1; depth <= 4 && node; depth += 1) {
        say(`  祖先 +${depth}  `, describe(node));
        node = node.parentElement;
      }

      // 3. 封面图：角标要挂在紧贴它的那一层
      const img = link.querySelector('img') || link.closest('*')?.querySelector('img');
      if (img) {
        say('  封面图   ', describe(img));
        say('  图的父层 ', describe(img.parentElement));
      } else {
        say('  封面图    (链接里没有 <img>)');
      }

      // 4. 后代里所有带 data-* 的元素 —— 站点的测试钩子往往在这里
      const hooks = [...link.querySelectorAll('*')]
        .filter((el) => [...el.attributes].some((a) => a.name.startsWith('data-')))
        .slice(0, 5);
      for (const hook of hooks) say('  后代钩子 ', describe(hook));
    }
    say('');
  }

  // ------------------------------------------------ 页面上出现过的 data-* 名
  //
  // 汇总一遍，便于判断这个站点用的是 data-testid 还是 data-automation-id
  // 之类 —— 选择器优先挂在这类属性上，而不是 CSS-in-JS 的哈希 class。
  const names = new Map();
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (!attr.name.startsWith('data-')) continue;
      names.set(attr.name, (names.get(attr.name) ?? 0) + 1);
    }
  }
  say('===== 页面上的 data-* 属性（按出现次数，前 20）=====');
  for (const [name, n] of [...names].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    say(`  ${String(n).padStart(5)}  ${name}`);
  }
  say('');

  // ------------------------------------------ 命中与未命中的卡片，差在哪里
  //
  // 这一节是为「部分卡片出分、部分不出」这个具体现象加的，也是这类问题最快
  // 的诊断路径：与其猜哪个选择器不对，不如直接把「成功的那张」和「失败的
  // 那张」摆在一起比。差异往往一眼可见 —— 不同的行用了不同的卡片组件、
  // 标题挂在不同的属性上、或者封面图的包裹层数不一样。
  // 优先用扩展自己挂在 <html> 上的那份选择器。
  //
  // 这一条是踩出来的：脚本原先自带一份路由选择器，扩展改成认卡片容器之后
  // 两边就脱节了 —— 报告说「被扫描器处理过 21 张」，真实数字是 179，
  // 因为脚本只数了 <a>，看不到 <article> 容器。失真的报告比没有报告更糟，
  // 它会把排查引向根本不存在的问题。
  const EXT_SELECTOR = document.documentElement.getAttribute('data-dbr-cards');
  const EXT_ANCHORS = document.documentElement.getAttribute('data-dbr-anchors');
  const CARD_SELECTOR = EXT_SELECTOR || 'a[href*="/detail/"], a[href*="/gp/video/detail/"]';
  say(`（卡片选择器来源：${EXT_SELECTOR ? '扩展实际在用的那份' : '脚本内置的兜底 —— 扩展未注入或版本过旧'}）`);
  const cards = [...document.querySelectorAll(CARD_SELECTOR)];
  const withBadge = cards.filter((el) => el.querySelector('.dbr-badge'));
  const withoutBadge = cards.filter((el) => !el.querySelector('.dbr-badge'));

  say('===== 出分情况 =====');
  say(`  选择器命中的卡片   ${cards.length}`);
  say(`  其中已挂上角标     ${withBadge.length}`);
  say(`  其中没有角标       ${withoutBadge.length}`);
  // 扩展给处理过的卡片打了身份标记；有标记却没角标，说明「查过但没结果」，
  // 和「压根没被扫到」是两回事，修法完全不同。
  const marked = cards.filter((el) => el.hasAttribute('data-dbr-identity') && !el.classList.contains('dbr-badge'));
  say(`  被扫描器处理过的   ${marked.length}（有 data-dbr-identity 标记）`);
  say(`  页面上的角标总数   ${document.querySelectorAll('.dbr-badge').length}`);
  say('');

  // 按状态拆开。这是回答「为什么很多卡片没有评分」的关键：
  // pending 多 = 它们还没进视口，属于设计如此（省配额），不是 bug；
  // missing 多 = 查过了但两边都没有，那是匹配或收录的问题；
  // error 多  = 被限流或队列满，属于配额问题。
  const STATES = [
    ['pending', '已发现，在等进入视口（设计如此，不是 bug）'],
    ['querying', '正在查询'],
    ['ok', '查到了评分'],
    ['missing', '查过了，两边都没有'],
    ['error', '暂时性失败（限流 / 队列满），会自动重试'],
    ['skipped', '读不到片名，跳过（多半是按钮之类的非影片元素）'],
    ['recycled', '结果回来时卡片已被站点复用，作废'],
  ];
  say('  按状态拆开：');
  for (const [state, label] of STATES) {
    const n = document.querySelectorAll(`[data-dbr-state="${state}"]`).length;
    say(`    ${state.padEnd(9)} ${String(n).padStart(4)}  ${label}`);
  }
  // 角标元素自己也带 data-dbr-identity（用于跨挂载点判重），必须排掉，
  // 否则每挂一个角标就多算一张「无状态的卡片」—— 实测报告里就这么冒出过
  // 48 张幽灵卡片，数字正好等于页面上的角标数。这是这个脚本第二次把自己的
  // 计数当成扩展的行为报出来，同一类错误。
  const noState = document.querySelectorAll(
    '[data-dbr-identity]:not([data-dbr-state]):not(.dbr-badge)',
  ).length;
  if (noState > 0) say(`    (无状态)  ${String(noState).padStart(4)}  扩展版本过旧，没有写状态标记`);
  // 顺带把 hero 单独报出来：它是轮播的，若整组都留在 DOM 里，可能一次冒出
  // 十来个身份标记。这个数字应当接近 1。
  const hero = document.querySelectorAll('[data-testid="top-hero-card"]');
  const heroMarked = [...hero].filter((el) => el.hasAttribute('data-dbr-identity'));
  if (hero.length > 0) {
    say(`  hero 卡片 ${hero.length} 个，其中被处理 ${heroMarked.length} 个` +
        `${heroMarked.length > 2 ? '  ⚠️ 轮播整组都被查了，要收紧' : ''}`);
    for (const el of heroMarked) say(`     ${el.getAttribute('data-dbr-identity')} → ${el.getAttribute('data-dbr-state')}`);
  }
  say('');

  const dumpCard = (el, label) => {
    say(`  ── ${label}`);
    say('     href    ', trunc(el.getAttribute('href'), 90));
    say('     卡片自身', describe(el));
    say('     身份标记', el.getAttribute('data-dbr-identity') ?? '(无 —— 没被扫描器处理过)');
    // 标题候选：和 selectors.ts 里那份清单一一对应，看哪一条能取到东西。
    const sources = [
      [':self aria-label', el.getAttribute('aria-label')],
      ['img[alt]', el.querySelector('img')?.getAttribute('alt')],
      ['[data-automation-id*=title]', el.querySelector('[data-automation-id*="title"]')?.textContent],
      ['[data-testid*=title]', el.querySelector('[data-testid*="title"]')?.textContent],
      ['文本内容', el.textContent],
    ];
    for (const [name, value] of sources) {
      say(`     ${name.padEnd(28)} ${value ? trunc(value, 60) : '(空)'}`);
    }
    const img = el.querySelector('img');
    say('     封面图  ', img ? describe(img) : '(链接里没有 img)');
    say('     图的父层', img ? describe(img.parentElement) : '(无)');
    // 用扩展实际在用的落点选择器，而不是脚本里写死的一条。
    const anchorHit = EXT_ANCHORS ? el.querySelector(EXT_ANCHORS) : el.querySelector('div:has(> img)');
    say('     角标落点', anchorHit ? `解析得到 ${describe(anchorHit)}` : '解析不到，会退回整张卡片');
    say('     状态    ', el.getAttribute('data-dbr-state') ?? '(无)');
    let node = el.parentElement;
    for (let d = 1; d <= 3 && node; d += 1) {
      say(`     祖先 +${d} `, describe(node));
      node = node.parentElement;
    }
  };

  if (withBadge.length > 0 && withoutBadge.length > 0) {
    say('===== 成功 vs 失败 的卡片对比（关键）=====');
    for (const el of withBadge.slice(0, 2)) dumpCard(el, '✅ 有角标');
    say('');
    for (const el of withoutBadge.slice(0, 3)) dumpCard(el, '❌ 没角标');
    say('');
  } else if (withoutBadge.length > 0) {
    say('===== 没有任何角标，抽查几张卡片 =====');
    for (const el of withoutBadge.slice(0, 3)) dumpCard(el, '❌ 没角标');
    say('');
  }

  // ---------------------------------------------------- 详情页/详情层的线索
  say('===== 详情区域 =====');
  const detailHints = [
    '[data-automation-id*="title"]',
    '[data-testid*="title"]',
    '[data-automation-id*="meta"]',
    '[data-testid*="metadata"]',
    'h1',
  ];
  for (const sel of detailHints) {
    const found = document.querySelectorAll(sel);
    if (found.length === 0) continue;
    say(`  ${sel} → ${found.length} 个`);
    for (const el of [...found].slice(0, 2)) {
      say('      ', describe(el), '│', trunc(el.textContent, 60));
    }
  }
  say('');
  say('===== 报告结束，请整个复制回去 =====');

  const report = out.join('\n');
  console.log(report);
  // 顺手放进剪贴板（需要页面已获得焦点；失败也不影响上面的输出）。
  navigator.clipboard?.writeText(report).then(
    () => console.log('%c已复制到剪贴板', 'color:#2e963d'),
    () => console.log('剪贴板不可用，请手动选中上面的输出复制'),
  );
  return report;
})();
