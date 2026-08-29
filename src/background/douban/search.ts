import type { Candidate } from '../matcher';
import type { MediaType } from '../../shared/types';
import { extractYear, normalizeScore } from './parse';

/**
 * 解析 `https://search.douban.com/movie/subject_search?cat=1002&search_text=X`。
 *
 * 这是取代 subject_suggest 的检索入口。换过来的原因是实测 suggest 已经废了 ——
 * 对任何查询词都返回空数组（连简体主标题都查不到），而完整搜索：
 * - 英文、简体、繁体台译三种输入都能命中同一部片（它会检索「又名」）
 * - 返回里直接带评分，省掉了原先取分的第二次请求
 *
 * 代价是响应有 20KB 左右（suggest 只有几百字节），但省掉一次请求之后
 * 总耗时反而更短，而且请求数减半对限流也更友好。
 */

/**
 * 结果页把数据塞在 `window.__DATA__ = {...}` 里。
 *
 * 不用正则去框这个对象：JSON 里有大量花括号和转义引号，正则要么截断要么
 * 贪婪吞掉后面的脚本。改为从第一个 `{` 开始做括号配对扫描，并跳过字符串
 * 字面量里的括号，这样无论后面跟着什么都能准确切出来。
 */
export function extractEmbeddedData(html: string): unknown {
  const marker = html.indexOf('window.__DATA__');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 豆瓣给条目打的标签，用来区分电影和剧集。 */
function labelType(labels: unknown): MediaType {
  if (!Array.isArray(labels)) return 'unknown';
  for (const label of labels) {
    if (typeof label !== 'object' || label === null) continue;
    const text = (label as Record<string, unknown>)['text'];
    if (typeof text !== 'string') continue;
    if (text.includes('剧集') || text.includes('电视') || text.includes('综艺')) return 'tv';
    if (text.includes('电影')) return 'movie';
  }
  return 'unknown';
}

/**
 * abstract 的格式是「国家 / 类型 / 类型 / 又名 / 又名 / 时长」，
 * 又名夹在中间，没有分隔标记，只能靠排除法把国家、类型、时长滤掉。
 */
const NON_ALIAS = new Set([
  // 国家地区
  '中国大陆', '中国香港', '中国台湾', '香港', '台湾', '中国', '美国', '英国', '日本', '韩国',
  '法国', '德国', '意大利', '西班牙', '印度', '泰国', '加拿大', '澳大利亚', '俄罗斯', '巴西',
  '墨西哥', '瑞典', '丹麦', '挪威', '荷兰', '比利时', '波兰', '土耳其', '以色列', '阿根廷',
  '新西兰', '爱尔兰', '瑞士', '奥地利', '葡萄牙', '芬兰', '捷克', '匈牙利', '南非', '埃及',
  '伊朗', '越南', '菲律宾', '印度尼西亚', '马来西亚', '新加坡', '苏联', '智利', '哥伦比亚',
  // 类型
  '剧情', '喜剧', '动作', '爱情', '科幻', '动画', '悬疑', '惊悚', '恐怖', '纪录片', '短片',
  '情色', '同性', '音乐', '歌舞', '家庭', '儿童', '传记', '历史', '战争', '犯罪', '西部',
  '奇幻', '冒险', '灾难', '武侠', '古装', '运动', '黑色电影', '真人秀', '脱口秀', '舞台艺术',
]);

function isAlias(token: string): boolean {
  if (!token) return false;
  if (NON_ALIAS.has(token)) return false;
  // 时长和集数：「129分钟」「60分钟」「共 8 集」
  if (/^\d+\s*分钟$/.test(token) || /^\d+\s*集$/.test(token)) return false;
  return true;
}

/** 从 abstract 里抠出又名，包括港台译名和外语原名。 */
export function parseAliases(abstract: unknown): string[] {
  if (typeof abstract !== 'string') return [];
  return abstract
    .split('/')
    .map((token) => token.trim())
    // 豆瓣会在港台译名后面标注来源，比如「星舰战将(台)」，比较时要去掉。
    .map((token) => token.replace(/[(（](台|港|大陆|内地|又名)[)）]\s*$/u, '').trim())
    .filter(isAlias);
}

/**
 * 豆瓣搜索结果的标题常常是「中文名 原名」拼在一起，例如
 * 「星河战队 Starship Troopers」。拆开之后英文查询能和原名精确对上，
 * 拿整串去比只能算「包含关系」，分数不够过阈值。
 */
export function splitBilingualTitle(title: string): { primary: string; original?: string } {
  const trimmed = title.trim();
  // 前半段必须含中日韩文字，后半段必须是拉丁字母开头，才认为是「中文名 + 原名」。
  const match = /^(.*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][^\s]*)\s+([A-Za-z0-9][^一-鿿]*)$/u.exec(
    trimmed,
  );
  if (!match) return { primary: trimmed };
  const primary = match[1]!.trim();
  const original = match[2]!.trim();
  if (!primary || !original) return { primary: trimmed };
  return { primary, original };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** 解析整个 __DATA__ 对象，产出候选条目。字段缺失只跳过该条，不影响其余。 */
export function parseSearchResults(payload: unknown): Candidate[] {
  const root = asRecord(payload);
  const items = root?.['items'];
  if (!Array.isArray(items)) return [];

  const candidates: Candidate[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;

    const id = item['id'];
    const idText = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
    const rawTitle = typeof item['title'] === 'string' ? item['title'].trim() : '';
    if (!idText || !rawTitle) continue;

    const { primary, original } = splitBilingualTitle(rawTitle);
    const rating = asRecord(item['rating']);
    const votes = rating ? rating['count'] : undefined;

    candidates.push({
      id: idText,
      title: primary,
      ...(original ? { originalTitle: original } : {}),
      aliases: parseAliases(item['abstract']),
      type: labelType(item['labels']),
      // 年份在搜索结果里没有独立字段，能从 abstract 里捞到就捞，捞不到就算了 ——
      // 匹配器对没有年份的情况会自动收紧阈值。
      year: extractYear(item['year']) ?? extractYear(item['abstract']),
      score: normalizeScore(rating?.['value']),
      votes: typeof votes === 'number' && Number.isFinite(votes) ? votes : null,
      url:
        typeof item['url'] === 'string' && item['url'].startsWith('http')
          ? item['url']
          : `https://movie.douban.com/subject/${idText}/`,
    });
  }
  return candidates;
}
