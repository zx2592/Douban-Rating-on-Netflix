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
