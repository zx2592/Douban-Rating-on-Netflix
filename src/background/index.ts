import { loadBackoff, saveBackoff } from './backoff-store';
import { chromeLocalStorage, RatingCache, sweepLegacyEntries } from './cache';
import { runProbe } from '../shared/probe';
import { DoubanClient } from './douban/client';
import { RatingLookup } from './lookup';
import { RequestQueue } from './queue';
import type { ExtensionRequest, ExtensionResponse } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import type { LookupOutcome } from '../shared/types';

/**
 * background service worker。
 *
 * MV3 的 worker 随时会被浏览器回收，下一条消息到来时再冷启动，所以这里的
 * 所有模块都建成「无状态可重建」的：队列和内存缓存丢了不影响正确性，
 * 落盘的评分缓存在 chrome.storage.local 里，重启后照常命中。
 */

const storage = chromeLocalStorage();

// 清理旧版本的缓存条目（接口失效期间写入的「未收录」不能等 12 小时 TTL）。
void sweepLegacyEntries(storage);

const queue = new RequestQueue({
  onBackoffChange: (until) => void saveBackoff(storage, { queue: until }),
});
const cache = new RatingCache(storage);
const client = new DoubanClient(queue, {
  onFullSearchBackoffChange: (until) => void saveBackoff(storage, { fullSearch: until }),
});
const lookup = new RatingLookup(cache, client);

/**
 * 恢复上一次进程留下的退避状态。
 *
 * service worker 每次冷启动都会重新执行本模块，若不恢复，扩展会在豆瓣仍在
 * 限流时立刻重新开打 —— 而 MV3 的 worker 闲置 30 秒就被回收，用户稍作停顿
 * 再滚动就会触发一次，等于持续把限流打得更深。
 */
const backoffRestored = (async () => {
  const state = await loadBackoff(storage);
  queue.restoreBackoff(state.queue);
  client.restoreFullSearchBackoff(state.fullSearch);
})();

async function handle(request: ExtensionRequest): Promise<ExtensionResponse> {
  switch (request.kind) {
    case 'lookup': {
      // 等退避状态恢复完再放行，否则冷启动后的头几个请求会绕过退避。
      await backoffRestored;
      const settings = await loadSettings();
      const outcome: LookupOutcome =
        settings.enabled && settings.sites.netflix
          ? await lookup.lookup(request.query)
          : { status: 'disabled' };
      return { kind: 'lookup', outcome };
    }
    case 'clearCache':
      return { kind: 'clearCache', cleared: await cache.clear() };
    case 'status':
      return {
        kind: 'status',
        status: {
          cachedEntries: await cache.size(),
          backoffUntil: queue.backoffUntil,
          pendingRequests: queue.pending,
        },
      };
  }
}

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  handle(request).then(sendResponse, (error: unknown) => {
    console.error('[豆瓣评分] 处理消息失败', error);
    sendResponse({
      kind: 'lookup',
      outcome: { status: 'error', reason: error instanceof Error ? error.message : String(error) },
    } satisfies ExtensionResponse);
  });
  // 返回 true 告诉 Chrome 这个响应是异步的，否则消息通道会立刻关闭。
  return true;
});

// 备用的 Console 诊断入口。正式入口是扩展弹窗里的「检索接口诊断」页面 ——
// 那里不需要找 service worker 的检查视图，也不会遇到执行上下文的问题。
(globalThis as unknown as { probeDouban: () => Promise<void> }).probeDouban = async () => {
  console.log(await runProbe());
};
