import { sendRequest } from '../shared/messages';
import { loadSettings, saveSettings, type BadgePosition, type Settings } from '../shared/settings';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup 缺少元素 #${id}`);
  return element as T;
}

const controls = {
  enabled: byId<HTMLInputElement>('enabled'),
  showOnCards: byId<HTMLInputElement>('showOnCards'),
  showOnDetail: byId<HTMLInputElement>('showOnDetail'),
  showUnrated: byId<HTMLInputElement>('showUnrated'),
  badgePosition: byId<HTMLSelectElement>('badgePosition'),
  details: byId<HTMLDivElement>('details'),
  status: byId<HTMLDivElement>('status'),
  clearCache: byId<HTMLButtonElement>('clearCache'),
  openProbe: byId<HTMLButtonElement>('openProbe'),
};

function render(settings: Settings): void {
  controls.enabled.checked = settings.enabled;
  controls.showOnCards.checked = settings.showOnCards;
  controls.showOnDetail.checked = settings.showOnDetail;
  controls.showUnrated.checked = settings.showUnrated;
  controls.badgePosition.value = settings.badgePosition;
  // 总开关关掉时，把下面的细项一起置灰，避免让人以为改了会生效。
  controls.details.classList.toggle('is-disabled', !settings.enabled);
}

async function update(patch: Partial<Settings>): Promise<void> {
  render(await saveSettings(patch));
}

function describeBackoff(backoffUntil: number | null): string | null {
  if (backoffUntil === null) return null;
  const seconds = Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000));
  if (seconds === 0) return null;
  const shown = seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
  return `豆瓣暂时限制了访问，${shown}后自动恢复`;
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await sendRequest({ kind: 'status' });
    const backoff = describeBackoff(status.backoffUntil);
    controls.status.textContent = backoff ?? `已缓存 ${status.cachedEntries} 条评分`;
    controls.status.classList.toggle('is-warning', backoff !== null);
  } catch {
    controls.status.textContent = '无法连接到扩展后台';
    controls.status.classList.add('is-warning');
  }
}

controls.enabled.addEventListener('change', () => void update({ enabled: controls.enabled.checked }));
controls.showOnCards.addEventListener('change', () => void update({ showOnCards: controls.showOnCards.checked }));
controls.showOnDetail.addEventListener('change', () => void update({ showOnDetail: controls.showOnDetail.checked }));
controls.showUnrated.addEventListener('change', () => void update({ showUnrated: controls.showUnrated.checked }));
controls.badgePosition.addEventListener('change', () =>
  void update({ badgePosition: controls.badgePosition.value as BadgePosition }),
);

controls.clearCache.addEventListener('click', () => {
  void (async () => {
    controls.clearCache.disabled = true;
    try {
      const cleared = await sendRequest({ kind: 'clearCache' });
      controls.status.textContent = `已清空 ${cleared} 条缓存`;
      controls.status.classList.remove('is-warning');
    } finally {
      controls.clearCache.disabled = false;
    }
  })();
});

// 用 tabs.create 而不是普通链接：弹窗一失焦就会关闭，普通链接的新标签
// 有时来不及打开。
controls.openProbe.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('probe.html') });
});

void (async () => {
  render(await loadSettings());
  await refreshStatus();
})();
