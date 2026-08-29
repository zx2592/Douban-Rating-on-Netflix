/**
 * 豆瓣接口探测器 —— 临时诊断工具，选定可用接口后就删掉。
 *
 * 背景：原先用的 www.douban.com/j/subject_suggest 已返回 404，豆瓣把这个站内
 * 接口下掉了。开发环境访问不了豆瓣，没法逐个试候选方案，所以把探测逻辑放进
 * service worker，由使用者在真实网络环境下跑一遍，再据结果决定走哪条路。
 *
 * 必须在 service worker 里跑：那里有 host 权限，不受 CORS 限制，结果才反映
 * 扩展真实的访问能力；在普通页面的 Console 里跑会因跨子域被 CORS 挡掉，
 * 得到的全是假阴性。
 */

const SAMPLE = '河边的错误';
const SAMPLE_ID = '35131346';

interface Candidate {
  name: string;
  url: string;
  /** 期望的响应形态，只用于在输出里提示怎么读结果。 */
  expect: string;
  init?: RequestInit;
}

const CANDIDATES: Candidate[] = [
  {
    name: 'A. movie 子域的 suggest',
    url: `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(SAMPLE)}`,
    expect: 'JSON 数组，含 id/title/year',
  },
  {
    name: 'B. 旧的 www suggest（已知 404，作对照）',
    url: `https://www.douban.com/j/subject_suggest?q=${encodeURIComponent(SAMPLE)}`,
    expect: '预期 404',
  },
  {
    name: 'C. 搜索页 HTML（window.__DATA__）',
    url: `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(SAMPLE)}&cat=1002`,
    expect: 'HTML，正文里应含 window.__DATA__',
  },
  {
    name: 'D. rexxar 搜索（不带 Referer）',
    url: `https://m.douban.com/rexxar/api/v2/search?q=${encodeURIComponent(SAMPLE)}&type=movie&count=5`,
    expect: 'JSON，items[].target.rating.value 直接带评分',
  },
  {
    name: 'E. rexxar 搜索（尝试带 Referer）',
    url: `https://m.douban.com/rexxar/api/v2/search?q=${encodeURIComponent(SAMPLE)}&type=movie&count=5`,
    expect: '同上；fetch 能否设置 referrer 也在此验证',
    init: { referrer: 'https://m.douban.com/movie/' },
  },
  {
    name: 'F. frodo 搜索（公开 apikey）',
    url:
      `https://frodo.douban.com/api/v2/search/movie?q=${encodeURIComponent(SAMPLE)}` +
      '&count=5&apikey=0ac44ae016490db2204ce0a042db2916',
    expect: 'JSON，items[] 直接带评分',
  },
  {
    name: 'G. frodo weixin 搜索',
    url:
      `https://frodo.douban.com/api/v2/search/weixin?q=${encodeURIComponent(SAMPLE)}` +
      '&count=5&apikey=0ac44ae016490db2204ce0a042db2916',
    expect: 'JSON，items[]',
  },
  {
    name: 'H. 条目详情 subject_abstract',
    url: `https://movie.douban.com/j/subject_abstract?subject_id=${SAMPLE_ID}`,
    expect: 'JSON，subject.rate',
  },
  {
    name: 'I. 条目页 HTML（取分的兜底）',
    url: `https://movie.douban.com/subject/${SAMPLE_ID}/`,
    expect: 'HTML，含 v:average 或 ld+json',
  },
  {
    name: 'J. frodo 条目详情',
    url: `https://frodo.douban.com/api/v2/movie/${SAMPLE_ID}?apikey=0ac44ae016490db2204ce0a042db2916`,
    expect: 'JSON，rating.value',
  },
];

/** 响应体里出现这些串，说明拿到的是风控页而不是数据。 */
const ANTI_BOT = ['sec.douban.com', '有异常请求', '检测到有异常'];

async function probeOne(candidate: Candidate): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(candidate.url, {
      credentials: 'omit',
      signal: controller.signal,
      ...candidate.init,
    });
    const body = await response.text();
    const blocked = ANTI_BOT.some((marker) => body.slice(0, 3000).includes(marker));

    let verdict: string;
    if (blocked) verdict = '❌ 风控页';
    else if (!response.ok) verdict = `❌ HTTP ${response.status}`;
    else if (body.includes('window.__DATA__')) verdict = '✅ 可用（HTML，含 __DATA__）';
    else if (body.includes('v:average') || body.includes('aggregateRating')) verdict = '✅ 可用（HTML，含评分）';
    else {
      try {
        const data: unknown = JSON.parse(body);
        const size = Array.isArray(data) ? data.length : Object.keys(data as object).length;
        verdict = size > 0 ? '✅ 可用（JSON）' : '⚠️ JSON 但内容为空';
      } catch {
        verdict = '⚠️ 200 但不是 JSON / 未识别';
      }
    }

    return {
      结论: verdict,
      状态码: String(response.status),
      最终地址: response.url === candidate.url ? '（未跳转）' : response.url,
      长度: String(body.length),
      片段: body.replace(/\s+/g, ' ').slice(0, 220),
      期望: candidate.expect,
    };
  } catch (error) {
    return {
      结论: '❌ 请求失败',
      状态码: '-',
      最终地址: '-',
      长度: '-',
      片段: error instanceof Error ? error.message : String(error),
      期望: candidate.expect,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逐个探测所有候选接口并打印结果。在 service worker 的 Console 里执行
 * `probeDouban()` 即可。
 */
export async function probeDouban(): Promise<void> {
  console.log('开始探测豆瓣接口，每个间隔 1.5 秒，全部跑完约 15 秒…');
  const summary: Record<string, Record<string, string>> = {};

  for (const candidate of CANDIDATES) {
    const result = await probeOne(candidate);
    summary[candidate.name] = result;
    console.log(`${result.结论}  ${candidate.name}\n    ${candidate.url}\n    ${result.片段}`);
    // 探测本身也要克制，别因为诊断反倒把自己打进风控。
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log('%c探测完成，把下面这张表整个复制回去：', 'font-weight:bold');
  console.table(summary);
}
