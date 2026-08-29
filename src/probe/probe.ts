import { PROBE_TOTAL, runProbe } from '../shared/probe';

/**
 * 诊断页面。做成扩展自己的页面，而不是让人去 service worker 的 Console 里
 * 敲命令：扩展页面同样享有 host 权限（不受 CORS 限制），但不需要使用者找到
 * 「检查视图」那个入口，也不会遇到「函数未定义」这类上下文问题，结果还能
 * 一键复制。
 */

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`诊断页缺少元素 #${id}`);
  return element as T;
}

const ui = {
  bar: byId<HTMLDivElement>('bar'),
  status: byId<HTMLParagraphElement>('status'),
  out: byId<HTMLTextAreaElement>('out'),
  copy: byId<HTMLButtonElement>('copy'),
  rerun: byId<HTMLButtonElement>('rerun'),
  copied: byId<HTMLSpanElement>('copied'),
};

async function run(): Promise<void> {
  ui.copy.disabled = true;
  ui.rerun.disabled = true;
  ui.copied.hidden = true;
  ui.bar.style.width = '0';
  ui.out.value = '';
  ui.status.textContent = `运行中… 0 / ${PROBE_TOTAL}`;

  try {
    const report = await runProbe((done, total, label) => {
      ui.bar.style.width = `${(done / total) * 100}%`;
      ui.status.textContent = `运行中… ${done} / ${total}　${label}`;
    });
    ui.out.value = report;
    ui.status.textContent = '完成。点「复制结果」把内容发回给开发者。';
  } catch (error) {
    ui.out.value = `诊断本身出错了：${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    ui.status.textContent = '运行失败，请把下面的错误信息发回。';
  } finally {
    ui.copy.disabled = false;
    ui.rerun.disabled = false;
  }
}

ui.copy.addEventListener('click', () => {
  void (async () => {
    try {
      await navigator.clipboard.writeText(ui.out.value);
    } catch {
      // 剪贴板被拒时退回到选中文本，用户自己按 Ctrl/Cmd+C。
      ui.out.select();
    }
    ui.copied.hidden = false;
    setTimeout(() => {
      ui.copied.hidden = true;
    }, 2000);
  })();
});

ui.rerun.addEventListener('click', () => void run());

void run();

// ---- 单片排查：跑真实的检索 + 解析 + 打分，暴露每一步的中间结果 ----
//
// 直接在本页面里跑而不是发消息给 background：扩展页面同样有 host 权限，
// 且绕开缓存 —— 排查时永远看到的是新鲜数据，不会被旧的「未收录」误导。

import { DoubanClient } from '../background/douban/client';
import {
  CONFIDENCE_THRESHOLD_WITH_YEAR,
  CONFIDENCE_THRESHOLD_WITHOUT_YEAR,
  scoreCandidate,
} from '../background/matcher';
import { RequestQueue } from '../background/queue';
import { buildSearchTerms } from '../background/search-terms';
import type { MediaQuery } from '../shared/types';

const traceUi = {
  title: byId<HTMLInputElement>('traceTitle'),
  year: byId<HTMLInputElement>('traceYear'),
  run: byId<HTMLButtonElement>('traceRun'),
  copyBtn: byId<HTMLButtonElement>('traceCopy'),
  out: byId<HTMLTextAreaElement>('traceOut'),
};

const traceClient = new DoubanClient(new RequestQueue({ minIntervalMs: 800 }));

async function traceOne(): Promise<void> {
  const title = traceUi.title.value.trim();
  if (!title) return;
  const yearNumber = Number.parseInt(traceUi.year.value.trim(), 10);
  const year = Number.isFinite(yearNumber) ? yearNumber : undefined;

  traceUi.run.disabled = true;
  traceUi.copyBtn.disabled = true;

  const query: MediaQuery = { title, type: 'unknown', ...(year !== undefined ? { year } : {}) };
  const threshold =
    year !== undefined ? CONFIDENCE_THRESHOLD_WITH_YEAR : CONFIDENCE_THRESHOLD_WITHOUT_YEAR;

  const lines: string[] = [
    `排查 "${title}"${year !== undefined ? ` (${year})` : ''} · 阈值 ${threshold} 分` +
      `${year === undefined ? '（没有年份，阈值收紧）' : ''}`,
    '',
  ];

  try {
    // 和线上完全一致的两级检索：先 suggest，拿不到可信匹配再上完整搜索。
    let matched = false;
    outer: for (const term of buildSearchTerms(title)) {
      const tiers: Array<[string, () => ReturnType<typeof traceClient.suggest>]> = [
        [`suggest 检索 "${term}"`, () => traceClient.suggest(term)],
        [`完整搜索 "${term}"`, () => traceClient.fullSearch(term)],
      ];
      for (const [label, run] of tiers) {
        lines.push(label);
        traceUi.out.value = lines.join('\n') + '\n  请求中…';

        let candidates;
        try {
          candidates = await run();
        } catch (error) {
          lines.push(`  ⚠️ ${error instanceof Error ? error.message : String(error)}`, '');
          continue;
        }
        lines.push(`  豆瓣返回 ${candidates.length} 个候选`);

        for (const candidate of candidates) {
          const scored = scoreCandidate(query, candidate);
          const verdict = scored.raw >= threshold ? '✅ 过线' : '❌ 不过';
          const names = [
            candidate.title,
            candidate.originalTitle,
            ...(candidate.aliases ?? []).slice(0, 4),
          ]
            .filter(Boolean)
            .join(' / ');
          lines.push(
            `  ${verdict} ${scored.raw}分  ${names}` +
              `\n        年份:${candidate.year ?? '?'} 类型:${candidate.type}` +
              ` 评分:${candidate.score ?? '无'} 人数:${candidate.votes ?? '?'}` +
              `\n        依据: ${scored.reason}`,
          );
        }
        lines.push('');
        if (candidates.some((candidate) => scoreCandidate(query, candidate).raw >= threshold)) {
          matched = true;
          break outer;
        }
      }
    }
    lines.push(
      matched
        ? '—— 排查完成：有候选过线，线上应能出分。'
        : '—— 排查完成：没有过线候选。把这份结果整个复制回去。',
    );
  } catch (error) {
    lines.push(`❌ 请求或解析失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }

  traceUi.out.value = lines.join('\n');
  traceUi.run.disabled = false;
  traceUi.copyBtn.disabled = false;
}

traceUi.run.addEventListener('click', () => void traceOne());
traceUi.title.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void traceOne();
});
traceUi.copyBtn.addEventListener('click', () => {
  void (async () => {
    try {
      await navigator.clipboard.writeText(traceUi.out.value);
    } catch {
      traceUi.out.select();
    }
  })();
});
