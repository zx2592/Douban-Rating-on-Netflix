/**
 * 临时诊断：把豆瓣两个检索入口的真实响应打出来。定完方案就删。
 *
 * 起因：实测发现英文片名的匹配率反而比中文差很多。推测是豆瓣的 sub_title
 * 存的是「原始语言标题」而非英文标题 —— 韩剧的原名是韩文，日剧是日文，
 * 拿英文去对根本对不上。但这只是推测，得看真实响应才能定。
 *
 * 同时对比 subject_suggest（自动补全，召回窄）和 search.douban.com 的完整
 * 搜索（会搜「又名」，理论上能覆盖港台译名）。
 */

const SUGGEST = 'https://movie.douban.com/j/subject_suggest?q=';
const SEARCH = 'https://search.douban.com/movie/subject_search?cat=1002&search_text=';

/** 覆盖几种典型情况：韩产/美产 × 简体/繁体/英文。 */
const CASES = [
  { label: '简体·韩产', q: '鱿鱼游戏' },
  { label: '英文·韩产', q: 'Squid Game' },
  { label: '简体·美产', q: '星河战队' },
  { label: '英文·美产', q: 'Starship Troopers' },
  { label: '繁体台译·美产', q: '星艦戰將' },
];

async function get(url: string): Promise<{ status: number; body: string; finalUrl: string }> {
  const response = await fetch(url, { credentials: 'omit' });
  return { status: response.status, body: await response.text(), finalUrl: response.url };
}

const gap = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));

export const PROBE_TOTAL = CASES.length + CASES.length - 1;

/**
 * 跑完整套探测，返回可直接复制回报的纯文本。
 * onProgress 用于让诊断页面边跑边显示进度，不必干等十几秒。
 */
export async function runProbe(onProgress?: (done: number, total: number, label: string) => void): Promise<string> {
  const report: string[] = [];
  let done = 0;
  const tick = (label: string): void => {
    done += 1;
    onProgress?.(done, PROBE_TOTAL, label);
  };

  report.push('===== subject_suggest（当前在用的接口）=====');
  for (const item of CASES) {
    await gap();
    try {
      const { status, body } = await get(SUGGEST + encodeURIComponent(item.q));
      let summary = `HTTP ${status}`;
      try {
        const data = JSON.parse(body) as Array<Record<string, unknown>>;
        summary += ` · 返回 ${data.length} 条`;
        if (data.length > 0) {
          // 字段名是关键：我一直假设有 sub_title，从没真正确认过。
          summary += `\n    字段: ${Object.keys(data[0]!).join(', ')}`;
          for (const entry of data.slice(0, 3)) {
            summary += `\n    · ${JSON.stringify(entry)}`;
          }
        }
      } catch {
        summary += ` · 非 JSON: ${body.slice(0, 150)}`;
      }
      report.push(`[${item.label}] "${item.q}" → ${summary}`);
    } catch (error) {
      report.push(`[${item.label}] "${item.q}" → 失败: ${String(error)}`);
    }
    tick(`suggest · ${item.label}`);
  }

  report.push('', '===== search.douban.com 完整搜索（候选方案）=====');
  for (const item of CASES.filter((c) => c.label !== '简体·美产')) {
    await gap();
    try {
      const { status, body, finalUrl } = await get(SEARCH + encodeURIComponent(item.q));
      const marker = body.indexOf('window.__DATA__');
      let summary = `HTTP ${status} · ${body.length} 字节`;
      if (finalUrl.includes('sec.douban.com')) summary += ' · 被风控拦截';
      else if (marker < 0) summary += ' · 没找到 __DATA__';
      // __DATA__ 的形态是接下来能不能用这个接口的关键，多截一些。
      else summary += `\n    ${body.slice(marker, marker + 700).replace(/\s+/g, ' ')}`;
      report.push(`[${item.label}] "${item.q}" → ${summary}`);
    } catch (error) {
      report.push(`[${item.label}] "${item.q}" → 失败: ${String(error)}`);
    }
    tick(`search · ${item.label}`);
  }

  return report.join('\n');
}
