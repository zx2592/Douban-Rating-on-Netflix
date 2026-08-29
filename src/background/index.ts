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

// 清理旧版本的缓存条目（接口失效期间写入的「未收录」不能等 12 小时 TTL）。
void sweepLegacyEntries(chromeLocalStorage());

const queue = new RequestQueue();
const cache = new RatingCache(chromeLocalStorage());
const lookup = new RatingLookup(cache, new DoubanClient(queue));

async function handle(request: ExtensionRequest): Promise<ExtensionResponse> {
  switch (request.kind) {
    case 'lookup': {
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
