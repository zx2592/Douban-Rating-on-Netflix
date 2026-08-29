/**
 * IMDb 取数路径的实测诊断。
 *
 * 为什么需要它：开发环境的网络策略禁止访问 imdb.com（CONNECT 被拒 403），
 * 所以 IMDb 这套客户端是**没有经过真实响应验证**就写出来的 —— 这正是这个
 * 项目在 v0.1 栽过的那个跟头（Netflix 选择器凭记忆写，线上一张卡片都匹配
 * 不到）。这次不重蹈覆辙：把候选路径逐条打到真实网络上跑一遍，由用户的
 * 浏览器给出答案，再据此收敛代码。
 *
 * 这个页面跑在扩展自己的上下文里，享有 manifest 里声明的 host 权限，
 * 不受 CORS 限制，所以能直接请求这些接口。
 */

/** 检索入口候选，和 imdb/client.ts 里那份保持一致。 */
const SUGGESTION_ENDPOINTS: Array<{ label: string; url: (q: string) => string }> = [
  {
    label: 'v3.sg.media-imdb.com/suggestion/x',
    url: (q) =>
      `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json?includeVideos=0`,
  },
  {
    label: 'v2.sg.media-imdb.com/suggestion/t',
    url: (q) => `https://v2.sg.media-imdb.com/suggestion/t/${encodeURIComponent(q)}.json`,
  },
];

/** 覆盖英文原名、中文译名、剧集与电影。 */
const CASES = [
  { label: '英文·剧集', q: 'Breaking Bad' },
  { label: '英文·电影', q: 'Starship Troopers' },
  { label: '简体中文', q: '鱿鱼游戏' },
];

/** 取分路径用一部一定存在、一定有分的片子来验证。 */
const RATING_SAMPLE = { id: 'tt0903747', name: 'Breaking Bad' };

const GRAPHQL_URL = 'https://api.graphql.imdb.com/';
const RATING_QUERY =
  'query TitleRating($id: ID!) { title(id: $id) { ratingsSummary { aggregateRating voteCount } } }';

/**
 * 取分路径的几种身份。
 *
 * 本机用 Node 跑的那轮结论很明确：检索四种语言全通，取分一条都不通 ——
 * GraphQL 回 403，网页端全是 HTTP 202 + 约 2KB 的反爬拦截页。挡住 Node 的
 * 多半是 TLS 指纹和 HTTP/2 帧序这类"整体不像浏览器"的特征，那是脚本补不出来的。
 *
 * 这个页面不一样：请求由 Chrome 自己发出，指纹是真的。所以同样的地址在这里
 * 很可能直接就过 —— 这也是为什么必须在浏览器里再验一次。
 *
 * ⚠️ 一个硬限制：Origin 和 Referer 是 Fetch 规范里的禁止修改头，扩展设了也
 * 会被浏览器忽略。所以如果 GraphQL 非要 `Origin: https://www.imdb.com` 才给过，
 * 扩展这条路就是走不通的，得换方案 —— 这一点只有在这里才测得出来。
 */
const RATING_ATTEMPTS: Array<{ label: string; run: () => Promise<Response> }> = [
  {
    label: 'GraphQL · 裸请求',
    run: () =>
      fetch(GRAPHQL_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: RATING_QUERY, variables: { id: RATING_SAMPLE.id } }),
      }),
  },
  {
    label: 'GraphQL · 带 imdb 前端的自定义头',
    run: () =>
      fetch(GRAPHQL_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 这几个是自定义头，扩展可以设；Origin/Referer 设了也会被忽略。
          'x-imdb-client-name': 'imdb-web-next',
          'x-imdb-user-country': 'US',
          'x-imdb-user-language': 'en-US',
        },
        body: JSON.stringify({ query: RATING_QUERY, variables: { id: RATING_SAMPLE.id } }),
      }),
  },
  {
    label: 'GraphQL · 用 GET',
    run: () =>
      fetch(
        `${GRAPHQL_URL}?query=${encodeURIComponent(
          `{ title(id: "${RATING_SAMPLE.id}") { ratingsSummary { aggregateRating voteCount } } }`,
        )}`,
        { credentials: 'omit', headers: { Accept: 'application/json' } },
      ),
  },
  {
    label: '条目页 www.imdb.com',
    run: () =>
      fetch(`https://www.imdb.com/title/${RATING_SAMPLE.id}/`, {
        credentials: 'omit',
        headers: { Accept: 'text/html' },
      }),
  },
  {
    label: '条目页 m.imdb.com（移动版）',
    run: () =>
      fetch(`https://m.imdb.com/title/${RATING_SAMPLE.id}/`, {
        credentials: 'omit',
        headers: { Accept: 'text/html' },
      }),
  },
];

const gap = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

export const IMDB_PROBE_TOTAL = SUGGESTION_ENDPOINTS.length * CASES.length + RATING_ATTEMPTS.length;

/**
 * 反爬拦截页的特征：2xx，但正文极小。
 * 只看状态码会以为成功了，然后一路报「页面里没有评分数据」——
 * 那个结论会把人引向"解析写错了"，而真实原因是根本没拿到页面。
 */
function challengeHint(status: number, body: string): string | null {
  if (body.length > 50_000) return null;
  const reasons: string[] = [];
  if (status === 202) reasons.push('HTTP 202');
  if (body.length < 50_000) reasons.push(`正文只有 ${body.length}B`);
  const head = body.slice(0, 3000).toLowerCase();
  for (const marker of ['captcha', 'unusual traffic', 'enable javascript', 'challenge']) {
    if (head.includes(marker)) reasons.push(`含「${marker}」`);
  }
  return reasons.length >= 2 ? `🚧 疑似反爬拦截页（${reasons.join('；')}）` : null;
}

export async function runImdbProbe(
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<string> {
  const report: string[] = [];
  let done = 0;
  const tick = (label: string): void => {
    done += 1;
    onProgress?.(done, IMDB_PROBE_TOTAL, label);
  };

  report.push('===== 检索入口（下拉建议接口）=====');
  for (const endpoint of SUGGESTION_ENDPOINTS) {
    report.push(`--- ${endpoint.label}`);
    for (const item of CASES) {
      await gap();
      try {
        const response = await fetch(endpoint.url(item.q), {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
        });
        const body = await response.text();
        let summary = `HTTP ${response.status} · ${body.length} 字节`;
        try {
          const data = JSON.parse(body) as { d?: unknown };
          const entries = Array.isArray(data.d) ? data.d : [];
          summary += ` · 返回 ${entries.length} 条`;
          if (entries.length > 0) {
            // 字段名是关键：客户端的解析全靠 id / l / y / qid 这几个短名。
            summary += `\n    字段: ${Object.keys(entries[0] as object).join(', ')}`;
            for (const entry of entries.slice(0, 3)) {
              summary += `\n    · ${JSON.stringify(entry).slice(0, 400)}`;
            }
          }
        } catch {
          summary += ` · 非 JSON: ${body.slice(0, 200)}`;
        }
        report.push(`[${item.label}] "${item.q}" → ${summary}`);
      } catch (error) {
        report.push(`[${item.label}] "${item.q}" → 失败: ${String(error)}`);
      }
      tick(`${endpoint.label} · ${item.label}`);
    }
    report.push('');
  }

  report.push(`===== 取分路径（样本：${RATING_SAMPLE.name} ${RATING_SAMPLE.id}）=====`);
  report.push('本机用 Node 跑时这一组全军覆没，浏览器里未必 —— 见下。', '');

  for (const attempt of RATING_ATTEMPTS) {
    await gap();
    try {
      const response = await attempt.run();
      const body = await response.text();
      let summary = `HTTP ${response.status} · ${body.length} 字节`;
      if (response.url && response.url !== GRAPHQL_URL) summary += ` · 最终地址 ${response.url}`;

      const hint = challengeHint(response.status, body);
      if (hint) summary += `\n    ${hint}`;

      // 只要能在响应里找到评分字段，这条路就是通的。
      const marker = /aggregateRating|ratingsSummary/.exec(body);
      summary +=
        marker && marker.index !== undefined
          ? `\n    ✅ 找到评分数据：${body.slice(Math.max(0, marker.index - 60), marker.index + 240).replace(/\s+/g, ' ')}`
          : `\n    ❌ 响应里没有评分字段。开头：${body.slice(0, 240).replace(/\s+/g, ' ')}`;
      report.push(`[${attempt.label}] ${summary}`, '');
    } catch (error) {
      // 网络层直接失败（CORS、被拦、断网）在这里会走到。
      report.push(`[${attempt.label}] 失败: ${String(error)}`, '');
    }
    tick(attempt.label);
  }

  return report.join('\n');
}
