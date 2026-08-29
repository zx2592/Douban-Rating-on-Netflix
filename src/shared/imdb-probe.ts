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

const gap = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

export const IMDB_PROBE_TOTAL = SUGGESTION_ENDPOINTS.length * CASES.length + 2;

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

  await gap();
  report.push('--- 路径一：GraphQL（轻，首选）');
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: RATING_QUERY, variables: { id: RATING_SAMPLE.id } }),
    });
    const body = await response.text();
    report.push(`HTTP ${response.status} · ${body.length} 字节\n    ${body.slice(0, 600)}`);
  } catch (error) {
    report.push(`失败: ${String(error)}`);
  }
  tick('GraphQL 取分');

  await gap();
  report.push('', '--- 路径二：条目页 JSON-LD（重，兜底）');
  try {
    const response = await fetch(`https://www.imdb.com/title/${RATING_SAMPLE.id}/`, {
      credentials: 'omit',
      headers: { Accept: 'text/html' },
    });
    const body = await response.text();
    let summary = `HTTP ${response.status} · ${body.length} 字节 · 最终地址 ${response.url}`;
    const marker = body.indexOf('aggregateRating');
    // 只要能在页面里找到 aggregateRating 这段，兜底路径就是通的。
    summary +=
      marker < 0
        ? '\n    ⚠️ 页面里没有 aggregateRating'
        : `\n    ${body.slice(Math.max(0, marker - 60), marker + 260).replace(/\s+/g, ' ')}`;
    report.push(summary);
  } catch (error) {
    report.push(`失败: ${String(error)}`);
  }
  tick('条目页取分');

  return report.join('\n');
}
