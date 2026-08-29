export type BadgePosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface Settings {
  /** 总开关。关掉后内容脚本不注入任何东西。 */
  enabled: boolean;
  /** 分站点开关。第一版只有 netflix，加站点时在这里扩展。 */
  sites: { netflix: boolean };
  badgePosition: BadgePosition;
  /** 在列表页的封面卡片上显示角标。 */
  showOnCards: boolean;
  /** 在详情弹层 / 播放页顶部显示角标。 */
  showOnDetail: boolean;
  /** 豆瓣查不到时，是否也占位显示一个"—"。默认只在详情里显示，列表页留白。 */
  showUnrated: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  sites: { netflix: true },
  badgePosition: 'top-left',
  showOnCards: true,
  showOnDetail: true,
  showUnrated: false,
};

const STORAGE_KEY = 'settings';

/** 逐字段合并，保证旧版本存下来的设置在新增字段后仍然可用。 */
function withDefaults(stored: unknown): Settings {
  const raw = (stored ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    sites: { ...DEFAULT_SETTINGS.sites, ...(raw.sites ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return withDefaults(stored[STORAGE_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = withDefaults({ ...(await loadSettings()), ...patch });
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

/** 订阅设置变更，用于让已经打开的 Netflix 页面立刻响应开关。 */
export function onSettingsChanged(handler: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    handler(withDefaults(changes[STORAGE_KEY].newValue));
  });
}
