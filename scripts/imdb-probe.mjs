#!/usr/bin/env node
/**
 * IMDb 取数路径的本机探测合集。
 *
 * 为什么需要它：开发容器的网络策略拒绝了所有 IMDb 域名（CONNECT 403），
 * src/background/imdb/ 那套客户端是**没有见过真实响应**就写出来的。这个项目
 * 在 v0.1 已经为「凭记忆写接口」付过一次代价（Netflix 选择器线上一张卡片都
 * 匹配不到），不能再赌第二次。
 *
 * 这个脚本把所有能想到的候选路径一次性打完，由你的本机网络给出答案。
 *
 *   node scripts/imdb-probe.mjs
 *
 * 零依赖，不需要 npm install，不需要先 build。跑完会在终端打印结论，
 * 并把完整报告写进 probe-out/，把那份报告发回来即可。
 *
 * 常用参数：
 *   --title "Stranger Things"   额外跑一次端到端（检索 → 取分）
 *   --keep-body                 把每个响应的原文完整存盘（默认只存前 200KB）
 *   --timeout 15000             单个请求的超时（毫秒，默认 12000）
 *   --only reach|search|rating|headers|dataset|e2e   只跑其中一组
 *   --curl                      不发请求，只打印等价的 curl 命令
 *   --self-test                 不联网，只验证这个脚本自己的判读逻辑
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'probe-out');

// ---------------------------------------------------------------- 参数与环境

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const TIMEOUT_MS = Number.parseInt(option('timeout', '12000'), 10);
const KEEP_FULL_BODY = flag('keep-body');
const E2E_TITLE = option('title', null);
const ONLY = option('only', null);
const BODY_CAP = KEEP_FULL_BODY ? Infinity : 200_000;

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (typeof fetch !== 'function') {
  console.error('需要 Node 18 或更高版本（要用内置的 fetch）。当前：' + process.version);
  process.exit(1);
}

/**
 * 代理提示。
 *
 * Node 的内置 fetch **默认不读 HTTPS_PROXY 环境变量**（浏览器和 curl 会读），
 * 所以「浏览器能打开 imdb.com 但这个脚本全红」是完全可能的，那不代表接口挂了。
 * Node 22.13+ / 24 可以用 NODE_USE_ENV_PROXY=1 打开。
 */
const proxyEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
const usingEnvProxy = process.env.NODE_USE_ENV_PROXY === '1';
const IS_WINDOWS = process.platform === 'win32';

// ------------------------------------------------------------------ 探测样本

/** 覆盖英文原名、中文译名、剧集与电影 —— Netflix 的界面语言会影响拿到的片名。 */
const QUERIES = [
  { label: '英文·剧集', q: 'Breaking Bad' },
  { label: '英文·电影', q: 'Starship Troopers' },
  { label: '简体中文', q: '鱿鱼游戏' },
  { label: '繁体中文', q: '星艦戰將' },
];

/** 取分路径用一部一定存在、一定有分的片子来验证。 */
const SAMPLE = { id: 'tt0903747', name: 'Breaking Bad' };

/** 建议接口的字母分桶：历史上有些变体要求路径里带首字母。 */
const bucket = (q) => encodeURIComponent(q.trim().charAt(0).toLowerCase());
/** 老版 JSONP 接口的 slug 规则：小写、空格转下划线、去掉其它符号。 */
const slug = (q) =>
  q
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w一-鿿_]/g, '');

/**
 * 检索入口候选。
 *
 * 前两条是代码里正在用的，其余是各个时期见过的变体和兜底方案。
 * 全部打一遍，才能知道哪条是真的活着。
 */
const SEARCH_ENDPOINTS = [
  {
    id: 'sg-v3-x',
    label: 'v3.sg · /suggestion/x/（代码当前首选）',
    url: (q) => `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json?includeVideos=0`,
    kind: 'json',
  },
  {
    id: 'sg-v2-t',
    label: 'v2.sg · /suggestion/t/（代码当前备用）',
    url: (q) => `https://v2.sg.media-imdb.com/suggestion/t/${encodeURIComponent(q)}.json`,
    kind: 'json',
  },
  {
    id: 'sg-v3-bucket',
    label: 'v3.sg · /suggestion/{首字母}/',
    url: (q) => `https://v3.sg.media-imdb.com/suggestion/${bucket(q)}/${encodeURIComponent(q)}.json`,
    kind: 'json',
  },
  {
    id: 'sg-v2-bucket',
    label: 'v2.sg · /suggestion/{首字母}/',
    url: (q) => `https://v2.sg.media-imdb.com/suggestion/${bucket(q)}/${encodeURIComponent(q)}.json`,
    kind: 'json',
  },
  {
    id: 'sg-v2-suggests',
    label: 'v2.sg · /suggests/（老版 JSONP）',
    url: (q) => `https://v2.sg.media-imdb.com/suggests/${bucket(q)}/${slug(q)}.json`,
    kind: 'jsonp',
  },
  {
    id: 'imdb-find',
    label: 'www.imdb.com/find（搜索结果页 HTML）',
    url: (q) => `https://www.imdb.com/find/?q=${encodeURIComponent(q)}&s=tt`,
    kind: 'html',
  },
  {
    id: 'graphql-search',
    label: 'api.graphql.imdb.com · mainSearch',
    url: () => 'https://api.graphql.imdb.com/',
    kind: 'json',
    post: (q) => ({
      query: `query Search($q: String!) {
        mainSearch(first: 5, options: { searchTerm: $q, type: TITLE }) {
          edges { node { entity { ... on Title {
            id titleText { text } releaseYear { year } titleType { id }
            ratingsSummary { aggregateRating voteCount }
          } } } }
        }
      }`,
      variables: { q },
    }),
    // --curl 专用：不带 $ 变量的等价写法。PowerShell 会把双引号里的 $q
    // 当成变量展开成空串，把查询改坏 —— 而报错信息完全看不出是这个原因。
    curlPost: (q) => ({
      query: `{ mainSearch(first: 5, options: { searchTerm: ${JSON.stringify(q)}, type: TITLE }) {
        edges { node { entity { ... on Title {
          id titleText { text } releaseYear { year } titleType { id }
          ratingsSummary { aggregateRating voteCount }
        } } } } } }`,
    }),
  },
];

/** 取分路径候选。 */
const RATING_ENDPOINTS = [
  {
    id: 'graphql-rating',
    label: 'api.graphql.imdb.com · ratingsSummary（代码当前首选）',
    url: () => 'https://api.graphql.imdb.com/',
    kind: 'json',
    post: (id) => ({
      query: 'query T($id: ID!) { title(id: $id) { ratingsSummary { aggregateRating voteCount } } }',
      variables: { id },
    }),
    curlPost: (id) => ({
      query: `{ title(id: ${JSON.stringify(id)}) { ratingsSummary { aggregateRating voteCount } } }`,
    }),
  },
  {
    id: 'title-page',
    label: 'www.imdb.com/title/{id}/（页内 JSON-LD 与 __NEXT_DATA__）',
    url: (id) => `https://www.imdb.com/title/${id}/`,
    kind: 'html',
  },
  {
    id: 'ratings-page',
    label: 'www.imdb.com/title/{id}/ratings/',
    url: (id) => `https://www.imdb.com/title/${id}/ratings/`,
    kind: 'html',
  },
  {
    id: 'mobile-title',
    label: 'm.imdb.com/title/{id}/（移动版，通常更轻）',
    url: (id) => `https://m.imdb.com/title/${id}/`,
    kind: 'html',
  },
];

/**
 * 请求头敏感性。
 *
 * 这组是最容易被忽略、却最能解释「curl 能通但扩展里不行」的地方：扩展从
 * service worker 发出的请求会自动带上 Chrome 的 UA，并且带一个
 * `Origin: chrome-extension://<id>`。如果某个接口对 Origin 挑剔，
 * 在这里就能看出来 —— 而不是等装上扩展之后一脸茫然。
 */
const HEADER_VARIANTS = [
  { id: 'bare', label: '不加任何头（Node 默认 UA）', headers: {} },
  { id: 'chrome-ua', label: '只加 Chrome UA', headers: { 'User-Agent': CHROME_UA } },
  {
    id: 'imdb-origin',
    label: 'Chrome UA + Origin/Referer = imdb.com',
    headers: { 'User-Agent': CHROME_UA, Origin: 'https://www.imdb.com', Referer: 'https://www.imdb.com/' },
  },
  {
    id: 'extension-origin',
    label: 'Chrome UA + Origin = chrome-extension://…（扩展真实形态）',
    headers: {
      'User-Agent': CHROME_UA,
      Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    },
  },
];

// -------------------------------------------------------------------- 工具层

const results = [];
const artifacts = [];

function mark(ok) {
  return ok ? '✅' : '❌';
}

function line(text = '') {
  console.log(text);
}

/** 统一的请求封装：永不抛出，把一切都变成可读的结构。 */
async function probe({ url, headers = {}, body = null, method = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const init = {
      method: method ?? (body ? 'POST' : 'GET'),
      redirect: 'follow',
      signal: controller.signal,
      headers: { ...headers },
    };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, init);
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      httpOk: response.ok,
      finalUrl: response.url,
      ms: Date.now() - startedAt,
      bytes: text.length,
      contentType: response.headers.get('content-type') ?? '',
      cors: response.headers.get('access-control-allow-origin') ?? null,
      body: text,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: aborted ? `超时（>${TIMEOUT_MS}ms）` : String(error?.message ?? error),
      cause: error?.cause ? String(error.cause.message ?? error.cause) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把响应原文存盘，便于把真实字节发回来分析。 */
function keep(name, content) {
  artifacts.push({ name, content: content.slice(0, BODY_CAP) });
}

function tryJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/** JSONP：`imdb$breaking_bad({...})` 这种，剥掉外面的函数调用。 */
function tryJsonp(text) {
  const match = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(text.trim());
  return match ? tryJson(match[1]) : { ok: false, value: null };
}

/** 对归一后的候选做概括：重点是 parse.ts 依赖的那几个字段在不在。 */
function summarizeEntries(entries) {
  const first = entries[0];
  return {
    usable: true,
    count: entries.length,
    fields: Object.keys(first),
    // 这三个字段名是 src/background/imdb/parse.ts 直接依赖的，必须逐个确认。
    hasTitle: typeof first.l === 'string',
    hasYear: typeof first.y === 'number',
    hasType: typeof first.qid === 'string',
    // 检索响应若自带评分，就能省掉第二次请求 —— 对配额是实打实的节省。
    hasRating: first.rating !== undefined,
    sample: entries.slice(0, 3),
  };
}

/** 从条目页 HTML 里找评分：JSON-LD 和 __NEXT_DATA__ 两条路各试一次。 */
function summarizeTitlePage(html) {
  const out = {};

  const ldMatch = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (ldMatch) {
    const parsed = tryJson(ldMatch[1].trim());
    const aggregate = parsed.value?.aggregateRating;
    out.jsonld = aggregate
      ? { found: true, ratingValue: aggregate.ratingValue, ratingCount: aggregate.ratingCount }
      : { found: false, note: 'ld+json 存在但没有 aggregateRating' };
  } else {
    out.jsonld = { found: false, note: '页面里没有 ld+json 块' };
  }

  const nextMatch = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextMatch) {
    const parsed = tryJson(nextMatch[1].trim());
    // IMDb 是 Next.js 站点，__NEXT_DATA__ 里通常也埋着 ratingsSummary。
    const found = findKeyDeep(parsed.value, 'ratingsSummary');
    out.nextData = found
      ? { found: true, value: found }
      : { found: false, note: '__NEXT_DATA__ 存在但没找到 ratingsSummary' };
  } else {
    out.nextData = { found: false, note: '页面里没有 __NEXT_DATA__' };
  }

  // 兜底：只要页面里有这个词，说明数据在页面上，只是我们没找对位置。
  out.mentionsAggregate = html.includes('aggregateRating');
  out.mentionsRatingsSummary = html.includes('ratingsSummary');
  return out;
}

/**
 * 从任意一种检索入口的响应里，统一提取出候选条目。
 *
 * 检索测试和端到端测试共用这一个函数：两边若各写一份，很容易出现
 * 「第 1 组说这条入口可用，第 5 组却说没有候选」这种自相矛盾的报告。
 */
function extractCandidates(endpoint, rawBody) {
  if (endpoint.kind === 'html') {
    // HTML 页面只能捞出 tt 号，拿不到标题和年份，仅够证明入口是通的。
    const ids = [...new Set([...rawBody.matchAll(/\/title\/(tt\d+)/g)].map((m) => m[1]))];
    return { entries: ids.map((id) => ({ id })), note: ids.length ? null : '页面里没有 /title/tt… 链接' };
  }

  const parsed = endpoint.kind === 'jsonp' ? tryJsonp(rawBody) : tryJson(rawBody);
  if (!parsed.ok) return { entries: [], note: endpoint.kind === 'jsonp' ? '不是 JSONP' : '不是 JSON' };

  if (endpoint.id === 'graphql-search') {
    const edges = findKeyDeep(parsed.value, 'edges');
    if (!Array.isArray(edges)) {
      const errors = parsed.value?.errors;
      return { entries: [], note: errors ? JSON.stringify(errors).slice(0, 200) : '没有 edges' };
    }
    // GraphQL 的字段名和建议接口完全不同，在这里就归一成同一种形状。
    const entries = edges
      .map((edge) => edge?.node?.entity)
      .filter((entity) => /^tt\d+$/.test(entity?.id ?? ''))
      .map((entity) => ({
        id: entity.id,
        l: entity.titleText?.text,
        y: entity.releaseYear?.year,
        qid: entity.titleType?.id,
        rating: entity.ratingsSummary?.aggregateRating ?? undefined,
      }));
    return { entries, note: entries.length ? null : '没有影视条目' };
  }

  const list = Array.isArray(parsed.value?.d) ? parsed.value.d : null;
  if (!list) return { entries: [], note: '没有 d 数组' };
  const entries = list.filter((e) => /^tt\d+$/.test(e?.id ?? ''));
  return { entries, note: entries.length ? null : `${list.length} 条，但没有 tt 开头的条目` };
}

/** 在任意深度的对象里找第一个指定键。用于在陌生结构里定位数据。 */
function findKeyDeep(node, key, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return null;
  if (!Array.isArray(node) && Object.hasOwn(node, key)) return node[key];
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findKeyDeep(value, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------- 各组测试

/** 第 0 组：先看这几个域名到底通不通，避免后面一片红看不出原因。 */
async function testReachability() {
  line('\n【0】域名连通性');
  const hosts = [
    'https://v3.sg.media-imdb.com/',
    'https://v2.sg.media-imdb.com/',
    'https://api.graphql.imdb.com/',
    'https://www.imdb.com/',
    'https://m.imdb.com/',
    'https://datasets.imdbws.com/',
  ];

  const reached = [];
  for (const host of hosts) {
    const res = await probe({ url: host, headers: { 'User-Agent': CHROME_UA } });
    // 三态而不是两态：连不上、连上了但被拒、正常。中间那档最容易被误读成
    // 「接口挂了」，其实多半是代理或防火墙在拒，域名本身是通的。
    const sign = !res.ok ? '❌' : res.status >= 400 ? '⚠️ ' : '✅';
    const note = !res.ok
      ? res.error
      : res.status >= 400
        ? `HTTP ${res.status} · ${res.ms}ms · 连得上但被拒`
        : `HTTP ${res.status} · ${res.ms}ms`;
    line(`  ${sign} ${host.padEnd(34)} ${note}`);
    reached.push({ host, ok: res.ok, status: res.status ?? null, ms: res.ms, error: res.error ?? null });
  }
  results.push({ group: 'reachability', reached });
  return reached.some((r) => r.ok);
}

/** 第 1 组：检索入口。哪条能用它的响应长什么样。 */
async function testSearch() {
  line('\n【1】检索入口（拿 tt 号）');
  const table = [];

  for (const endpoint of SEARCH_ENDPOINTS) {
    line(`\n  ── ${endpoint.label}`);
    const perQuery = [];

    for (const item of QUERIES) {
      await sleep(300);
      const res = await probe({
        url: endpoint.url(item.q),
        headers: { 'User-Agent': CHROME_UA, Accept: endpoint.kind === 'html' ? 'text/html' : 'application/json' },
        body: endpoint.post ? endpoint.post(item.q) : null,
      });


      if (!res.ok) {
        line(`     ❌ ${item.label.padEnd(10)} ${res.error}`);
        perQuery.push({ query: item.q, ok: false, error: res.error });
        continue;
      }

      const { entries, note } = extractCandidates(endpoint, res.body);
      const verdict = entries.length > 0 ? summarizeEntries(entries) : { usable: false, note };

      const detail = verdict.usable
        ? `${verdict.count} 条` +
          (verdict.fields ? ` · 字段 ${verdict.fields.join(',')}` : '') +
          (verdict.hasRating ? ' · 自带评分！' : '')
        : verdict.note;
      line(
        `     ${mark(verdict.usable)} ${item.label.padEnd(10)} HTTP ${res.status} · ${String(res.bytes).padStart(7)}B · ${String(res.ms).padStart(5)}ms · ${detail}`,
      );

      keep(`search_${endpoint.id}_${slug(item.q) || 'q'}.txt`, res.body);
      perQuery.push({
        query: item.q,
        ok: true,
        status: res.status,
        bytes: res.bytes,
        ms: res.ms,
        contentType: res.contentType,
        cors: res.cors,
        verdict,
      });
    }
    table.push({ endpoint: endpoint.id, label: endpoint.label, perQuery });
  }

  results.push({ group: 'search', table });
  return table;
}

/** 第 2 组：取分。 */
async function testRating() {
  line(`\n【2】取分路径（样本 ${SAMPLE.name} ${SAMPLE.id}）`);
  const table = [];

  for (const endpoint of RATING_ENDPOINTS) {
    await sleep(300);
    const res = await probe({
      url: endpoint.url(SAMPLE.id),
      headers: { 'User-Agent': CHROME_UA, Accept: endpoint.kind === 'html' ? 'text/html' : 'application/json' },
      body: endpoint.post ? endpoint.post(SAMPLE.id) : null,
    });

    if (!res.ok) {
      line(`  ❌ ${endpoint.label}\n       ${res.error}`);
      table.push({ endpoint: endpoint.id, ok: false, error: res.error });
      continue;
    }

    let verdict;
    if (endpoint.kind === 'json') {
      const parsed = tryJson(res.body);
      const summary = parsed.ok ? findKeyDeep(parsed.value, 'ratingsSummary') : null;
      verdict = summary
        ? { usable: true, rating: summary }
        : { usable: false, note: parsed.ok ? res.body.slice(0, 220) : '不是 JSON' };
    } else {
      const page = summarizeTitlePage(res.body);
      const usable = page.jsonld.found || page.nextData.found;
      verdict = { usable, ...page };
    }

    line(
      `  ${mark(verdict.usable)} ${endpoint.label}\n` +
        `       HTTP ${res.status} · ${(res.bytes / 1024).toFixed(0)}KB · ${res.ms}ms` +
        (verdict.rating ? ` · ${JSON.stringify(verdict.rating)}` : '') +
        (verdict.jsonld ? `\n       JSON-LD: ${verdict.jsonld.found ? JSON.stringify(verdict.jsonld) : verdict.jsonld.note}` : '') +
        (verdict.nextData ? `\n       __NEXT_DATA__: ${verdict.nextData.found ? JSON.stringify(verdict.nextData.value).slice(0, 160) : verdict.nextData.note}` : '') +
        (!verdict.usable && verdict.note ? `\n       ${verdict.note}` : ''),
    );

    keep(`rating_${endpoint.id}.txt`, res.body);
    table.push({
      endpoint: endpoint.id,
      ok: true,
      status: res.status,
      bytes: res.bytes,
      ms: res.ms,
      cors: res.cors,
      verdict,
    });
  }

  results.push({ group: 'rating', table });
  return table;
}

/**
 * 第 3 组：请求头敏感性。
 * 用第 1 组里能用的那条检索入口，换四种请求头各打一次。
 */
async function testHeaders(workingSearch) {
  line('\n【3】请求头敏感性（同一个接口，换头再打）');
  if (!workingSearch) {
    line('  ⏭  没有可用的检索入口，跳过');
    return [];
  }

  const endpoint = SEARCH_ENDPOINTS.find((e) => e.id === workingSearch);
  line(`  用的是：${endpoint.label}`);
  const table = [];

  for (const variant of HEADER_VARIANTS) {
    await sleep(300);
    const res = await probe({
      url: endpoint.url('Breaking Bad'),
      headers: variant.headers,
      body: endpoint.post ? endpoint.post('Breaking Bad') : null,
    });
    const usable = res.ok && res.httpOk && res.bytes > 20;
    line(
      `  ${mark(usable)} ${variant.label.padEnd(44)} ${res.ok ? `HTTP ${res.status} · ${res.bytes}B` : res.error}` +
        (res.cors ? ` · CORS: ${res.cors}` : ''),
    );
    table.push({ variant: variant.id, label: variant.label, usable, status: res.status ?? null, cors: res.cors ?? null });
  }

  results.push({ group: 'headers', endpoint: workingSearch, table });
  return table;
}

/**
 * 第 4 组：官方公开数据集。
 *
 * IMDb 自己发布的 TSV 全量数据（datasets.imdbws.com），有正式的使用条款，
 * 不是私有接口 —— 唯一一条「不会哪天突然改掉」的路。缺点是要整包下载，
 * 只测大小，不真的下。
 */
async function testDataset() {
  line('\n【4】官方公开数据集（唯一有正式条款的路径）');
  const url = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
  const res = await probe({ url, method: 'HEAD', headers: { 'User-Agent': CHROME_UA } });

  if (!res.ok) {
    line(`  ❌ ${res.error}`);
    results.push({ group: 'dataset', ok: false, error: res.error });
    return;
  }
  line(`  ${mark(res.httpOk)} ${url}\n       HTTP ${res.status} · ${res.ms}ms`);
  line('       （只发了 HEAD，没有真的下载）');
  results.push({ group: 'dataset', ok: res.httpOk, status: res.status });
}

/** 第 5 组：端到端 —— 给一个片名，看能不能一路走到分数。 */
async function testEndToEnd(title, workingSearch, workingRating) {
  line(`\n【5】端到端："${title}"`);
  if (!workingSearch || !workingRating) {
    line('  ⏭  检索或取分没有可用路径，跳过');
    return;
  }

  const search = SEARCH_ENDPOINTS.find((e) => e.id === workingSearch);
  const searchRes = await probe({
    url: search.url(title),
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    body: search.post ? search.post(title) : null,
  });
  if (!searchRes.ok) return line(`  ❌ 检索失败：${searchRes.error}`);

  const { entries, note } = extractCandidates(search, searchRes.body);
  if (entries.length === 0) return line(`  ❌ 检索没有返回影视条目：${note}`);

  line('  检索候选：');
  for (const entry of entries.slice(0, 5)) {
    line(`     · ${entry.id}  ${entry.l ?? '(HTML 入口拿不到标题)'}  (${entry.y ?? '?'})  ${entry.qid ?? '?'}`);
  }

  // 刻意不在这里复刻匹配逻辑：真正的打分在 src/background/matcher.ts，
  // 复制一份只会随着时间漂移。这里只验证「这条链路能不能走通」。
  const target = entries[0];
  const rating = RATING_ENDPOINTS.find((e) => e.id === workingRating);
  await sleep(300);
  const ratingRes = await probe({
    url: rating.url(target.id),
    headers: { 'User-Agent': CHROME_UA, Accept: rating.kind === 'html' ? 'text/html' : 'application/json' },
    body: rating.post ? rating.post(target.id) : null,
  });

  if (!ratingRes.ok) return line(`  ❌ 取分失败：${ratingRes.error}`);
  const found =
    rating.kind === 'json'
      ? findKeyDeep(tryJson(ratingRes.body).value, 'ratingsSummary')
      : summarizeTitlePage(ratingRes.body).jsonld;
  line(`  取分（第一个候选 ${target.id} ${target.l ?? ''}）：${JSON.stringify(found)}`);
  line(`  ${mark(Boolean(found))} 端到端${found ? '打通' : '未打通'}`);

  results.push({ group: 'e2e', title, candidates: entries.slice(0, 5), rating: found });
}

// ---------------------------------------------------------------------- 结论

function conclude(searchTable, ratingTable) {
  line('\n' + '='.repeat(72));
  line('结论');
  line('='.repeat(72));

  const goodSearch = (searchTable ?? []).filter((row) =>
    row.perQuery.some((q) => q.ok && q.verdict?.usable),
  );
  const goodRating = (ratingTable ?? []).filter((row) => row.ok && row.verdict?.usable);

  line('\n可用的检索入口（按代码里的优先级排）：');
  if (goodSearch.length === 0) line('  ❌ 一条都没有 —— 见下方「全红怎么办」');
  for (const row of goodSearch) {
    const hits = row.perQuery.filter((q) => q.ok && q.verdict?.usable);
    const langs = hits.map((h) => QUERIES.find((c) => c.q === h.query)?.label ?? h.query);
    line(`  ✅ ${row.label}`);
    line(`       命中语言：${langs.join('、')}`);
    const withFields = hits.find((h) => h.verdict.fields);
    if (withFields) {
      const v = withFields.verdict;
      line(`       字段：${v.fields.join(', ')}`);
      line(
        `       解析所依赖的字段是否齐全：` +
          `标题 l ${mark(v.hasTitle)} · 年份 y ${mark(v.hasYear)} · 类型 qid ${mark(v.hasType)}`,
      );
    }
  }

  line('\n可用的取分路径：');
  if (goodRating.length === 0) line('  ❌ 一条都没有');
  for (const row of goodRating) {
    line(`  ✅ ${RATING_ENDPOINTS.find((e) => e.id === row.endpoint).label}  （${(row.bytes / 1024).toFixed(0)}KB / ${row.ms}ms）`);
  }

  if (goodSearch.length === 0 && goodRating.length === 0) {
    line('\n全红怎么办：');
    line('  1. Node 的内置 fetch 默认不读 HTTPS_PROXY，浏览器能开不代表这里能通。');
    line('     若你在用代理，重跑一次：  NODE_USE_ENV_PROXY=1 node scripts/imdb-probe.mjs');
    if (proxyEnv && !usingEnvProxy) line(`     （检测到 HTTPS_PROXY=${proxyEnv}，但没有开 NODE_USE_ENV_PROXY）`);
    line('  2. 或者直接用扩展弹窗里的「检索接口诊断 → 运行 IMDb 诊断」——');
    line('     它跑在浏览器里，走的是浏览器的网络栈和代理设置。');
  }

  line('\n把 probe-out/report.md 发回来即可（原始响应也在同一个目录）。');
}

/**
 * 只打印等价的 curl 命令，不发请求。
 *
 * 用途：Node 的内置 fetch 不读代理环境变量，而 curl 读。如果这个脚本全红
 * 但你怀疑网络其实是通的，用 curl 手动打一发就能立刻分清是「接口不可用」
 * 还是「Node 出不去网」—— 这两件事的应对完全不同。
 */
async function printCurl() {
  line('把下面的命令逐条粘进终端。curl 会读 HTTPS_PROXY，Node 的 fetch 不会。');
  if (IS_WINDOWS) {
    line('（已按 Windows 生成：双引号 + curl.exe。PowerShell 里 curl 是');
    line('  Invoke-WebRequest 的别名，所以必须写成 curl.exe。）');
  }
  line('');

  // cmd.exe / PowerShell 不认单引号，Linux/macOS 的 shell 不认反斜杠转义的
  // 双引号 —— 两边的引号规则不兼容，只能分开生成。
  const q = (text) =>
    IS_WINDOWS ? `"${String(text).replace(/"/g, '\\"')}"` : `'${String(text).replace(/'/g, `'\\''`)}'`;
  const CURL = IS_WINDOWS ? 'curl.exe' : 'curl';
  const CONT = IS_WINDOWS ? '^' : '\\';

  /**
   * POST 的请求体一律写成文件，用 -d @文件 引用，而不是内联进命令行。
   *
   * 内联是行不通的：JSON 里本来就有双引号，Windows 上再套一层双引号之后
   * 会变成 \\" —— cmd.exe 的参数解析（MSVCRT 规则）会把它当成"一个反斜杠 +
   * 一个结束引号"，命令直接散架。换成单引号又轮到 PowerShell 不认。
   * 写成文件就绕过了所有 shell 的引号规则，三种终端里都一样能跑。
   */
  const bodyFiles = [];
  const write = (label, url, body, extra = '', fileHint = '') => {
    line(`\n# ${label}`);
    const parts = [`${CURL} -sS -m 20 -w ${q('\\nHTTP %{http_code} %{size_download}B %{time_total}s\\n')}`];
    parts.push(`  -A ${q(CHROME_UA)}`);
    if (body) {
      const name = `body-${fileHint}.json`;
      bodyFiles.push({ name, content: JSON.stringify(body, null, 2) });
      parts.push(`  -H ${q('Content-Type: application/json')}`);
      parts.push(`  -d @probe-out/${name}`);
    }
    parts.push(`  ${q(url)}${extra}`);
    line(parts.join(` ${CONT}\n`));
  };

  line('# 检索入口');
  for (const endpoint of SEARCH_ENDPOINTS) {
    const term = 'Breaking Bad';
    const build = endpoint.curlPost ?? endpoint.post;
    write(endpoint.label, endpoint.url(term), build ? build(term) : null, '', endpoint.id);
  }

  line('\n\n# 取分路径');
  for (const endpoint of RATING_ENDPOINTS) {
    // HTML 页面有 1–2MB，别把整页倒进终端。Windows 上没有 grep，
    // 改成存盘再让用户自己搜 —— 比给一条跑不起来的命令强。
    // 三条 HTML 路径各存各的文件，否则后一条会把前一条覆盖掉，
    // 想对比"哪个页面里有评分"就无从比起。
    const file = `imdb-${endpoint.id}.html`;
    const extra = endpoint.kind === 'html' ? ` -o ${file}` : '';
    const build = endpoint.curlPost ?? endpoint.post;
    write(endpoint.label, endpoint.url(SAMPLE.id), build ? build(SAMPLE.id) : null, extra, endpoint.id);
    if (endpoint.kind === 'html') {
      line(
        IS_WINDOWS
          ? `#   ↑ 存成 ${file}，然后：findstr /C:"aggregateRating" ${file}`
          : `#   ↑ 存成 ${file}，然后：grep -o 'aggregateRating.\\{0,120\\}' ${file} | head -3`,
      );
    }
  }

  if (bodyFiles.length > 0) {
    await mkdir(outDir, { recursive: true });
    for (const file of bodyFiles) await writeFile(resolve(outDir, file.name), file.content);
    line(`\n# 已把 ${bodyFiles.length} 个 POST 请求体写进 probe-out/，命令里用 -d @ 引用。`);
    line('# 请在项目根目录（能看到 probe-out 的那一层）执行上面的命令。');
  }
  line('');
}

/**
 * 自检：不联网，拿构造好的样本喂给判读函数。
 *
 * 为什么值得单独做：这个脚本是在一个**所有 IMDb 域名都被拒**的环境里写的，
 * 判读逻辑（extractCandidates / summarizeTitlePage）从来没跑过成功分支。
 * 万一它有 bug，你本机跑出来的会是「接口全红」——一个假阴性，会把我们俩
 * 一起带到错误的方向上去。所以先证明：拿到正确的响应时，它认得出来。
 */
function selfTest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, pass, actual, expected });
    line(`  ${mark(pass)} ${name}` + (pass ? '' : `\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`));
  };

  line('自检（不联网，只验证判读逻辑）\n');

  // 1. 建议接口的标准形态
  const suggestion = JSON.stringify({
    d: [
      { id: 'tt0903747', l: 'Breaking Bad', qid: 'tvSeries', y: 2008 },
      { id: 'nm0186505', l: 'Bryan Cranston', qid: 'name' },
    ],
  });
  const json = extractCandidates({ id: 'sg-v3-x', kind: 'json' }, suggestion);
  check('建议接口：认出影视条目、滤掉人名', json.entries.map((e) => e.id), ['tt0903747']);
  check('建议接口：字段齐全判定', (({ hasTitle, hasYear, hasType }) => ({ hasTitle, hasYear, hasType }))(summarizeEntries(json.entries)), { hasTitle: true, hasYear: true, hasType: true });

  // 2. JSONP 形态
  const jsonp = extractCandidates({ id: 'sg-v2-suggests', kind: 'jsonp' }, `imdb$breaking_bad(${suggestion})`);
  check('JSONP：剥掉外层函数调用', jsonp.entries.map((e) => e.id), ['tt0903747']);

  // 3. GraphQL 的字段名和建议接口完全不同，必须被归一成同一种形状
  const graphql = extractCandidates(
    { id: 'graphql-search', kind: 'json' },
    JSON.stringify({
      data: { mainSearch: { edges: [{ node: { entity: {
        id: 'tt0903747',
        titleText: { text: 'Breaking Bad' },
        releaseYear: { year: 2008 },
        titleType: { id: 'tvSeries' },
        ratingsSummary: { aggregateRating: 9.5 },
      } } }] } },
    }),
  );
  check('GraphQL：归一成同一种形状', graphql.entries, [
    { id: 'tt0903747', l: 'Breaking Bad', y: 2008, qid: 'tvSeries', rating: 9.5 },
  ]);
  check('GraphQL：识别出自带评分', summarizeEntries(graphql.entries).hasRating, true);

  // 4. GraphQL 报错时要给出错误内容，而不是笼统的「没有结果」
  const gqlError = extractCandidates(
    { id: 'graphql-search', kind: 'json' },
    JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] }),
  );
  check('GraphQL：报错时带出原因', gqlError.note.includes('PersistedQueryNotFound'), true);

  // 5. HTML 搜索页
  const html = extractCandidates(
    { id: 'imdb-find', kind: 'html' },
    '<a href="/title/tt0903747/">Breaking Bad</a><a href="/title/tt0903747/">dup</a>',
  );
  check('HTML：捞出 tt 号并去重', html.entries.map((e) => e.id), ['tt0903747']);

  // 6. 条目页的两条取分路径
  const page = summarizeTitlePage(
    `<script type="application/ld+json">{"aggregateRating":{"ratingValue":9.5,"ratingCount":2200000}}</script>` +
      `<script id="__NEXT_DATA__" type="application/json">{"props":{"x":{"ratingsSummary":{"aggregateRating":9.5}}}}</script>`,
  );
  check('条目页：JSON-LD', page.jsonld.found && page.jsonld.ratingValue, 9.5);
  check('条目页：__NEXT_DATA__', page.nextData.found, true);

  // 7. 坏数据不能崩，也不能误判成可用
  check('坏 JSON 不崩', extractCandidates({ id: 'sg-v3-x', kind: 'json' }, '<html>403</html>').entries, []);
  check('空页面不崩', summarizeTitlePage('').jsonld.found, false);

  const failed = cases.filter((c) => !c.pass);
  line(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项未通过`}  （共 ${cases.length} 项）`);
  if (failed.length > 0) {
    line('判读逻辑本身有问题，先别看联网结果 —— 那会是假阴性。把这段发回来。');
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------------ 主流程

async function main() {
  if (flag('curl')) return await printCurl();
  if (flag('self-test')) return selfTest();

  line('IMDb 取数路径探测  ·  Node ' + process.version);
  if (IS_WINDOWS) {
    // 中文 Windows 的 cmd 默认代码页是 936，Node 输出 UTF-8 会变成乱码。
    // 不影响结果 —— probe-out/ 里的文件始终是 UTF-8 的。
    line('提示：若下面的中文是乱码，先执行  chcp 65001  再重跑（或改用 Windows Terminal）。');
    line('     乱码只影响终端显示，probe-out/ 里的报告始终是正常的 UTF-8。');
  }
  line(`超时 ${TIMEOUT_MS}ms` + (proxyEnv ? ` · 检测到 HTTPS_PROXY=${proxyEnv}` : '') +
    (usingEnvProxy ? ' · 已开启 NODE_USE_ENV_PROXY' : ''));
  if (proxyEnv && !usingEnvProxy) {
    line('⚠️  Node 的内置 fetch 默认忽略 HTTPS_PROXY。若结果全红，请改用：');
    line('    NODE_USE_ENV_PROXY=1 node scripts/imdb-probe.mjs');
  }

  const run = (name) => !ONLY || ONLY === name;

  if (run('reach')) await testReachability();

  let searchTable = null;
  let ratingTable = null;
  if (run('search')) searchTable = await testSearch();
  if (run('rating')) ratingTable = await testRating();

  const bestSearch = (searchTable ?? []).find((row) =>
    row.perQuery.some((q) => q.ok && q.verdict?.usable),
  )?.endpoint;
  const bestRating = (ratingTable ?? []).find((row) => row.ok && row.verdict?.usable)?.endpoint;

  if (run('headers')) await testHeaders(bestSearch);
  if (run('dataset')) await testDataset();
  if (E2E_TITLE && run('e2e')) await testEndToEnd(E2E_TITLE, bestSearch, bestRating);

  conclude(searchTable, ratingTable);

  // 落盘：结构化结果 + 每个响应的原文，方便把真实字节发回来。
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'report.json'),
    JSON.stringify({ node: process.version, at: new Date().toISOString(), results }, null, 2),
  );
  await writeFile(resolve(outDir, 'report.md'), renderMarkdown());
  for (const artifact of artifacts) {
    await writeFile(resolve(outDir, artifact.name), artifact.content);
  }
  line(`\n已写入 ${outDir}/  （report.md、report.json，以及 ${artifacts.length} 份响应原文）`);
}

/** 生成一份适合直接粘贴回来的报告。 */
function renderMarkdown() {
  const lines = [
    '# IMDb 取数路径探测结果',
    '',
    `- Node：${process.version}`,
    `- 时间：${new Date().toISOString()}`,
    `- 代理：${proxyEnv ?? '未设置'}${usingEnvProxy ? '（已开启 NODE_USE_ENV_PROXY）' : ''}`,
    '',
  ];

  for (const entry of results) {
    lines.push(`## ${entry.group}`, '', '```json', JSON.stringify(entry, null, 2), '```', '');
  }
  return lines.join('\n');
}

main().catch((error) => {
  console.error('\n探测脚本本身出错了：');
  console.error(error);
  process.exit(1);
});
