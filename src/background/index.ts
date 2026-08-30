import { loadBackoff, saveBackoff } from './backoff-store';
import { CACHE_PREFIXES, chromeLocalStorage, RatingCache, sweepLegacyEntries } from './cache';
import { runProbe } from '../shared/probe';
import { DoubanClient } from './douban/client';
import { DoubanProvider } from './douban/provider';
import { ImdbClient } from './imdb/client';
import { ImdbProvider } from './imdb/provider';
import { InterestStore } from './interest';
import { RatingLookup } from './lookup';
import { RequestQueue } from './queue';
import type { ExtensionRequest, ExtensionResponse } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import type { LookupOutcome, RatingsOutcome } from '../shared/types';

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

const interest = new InterestStore(storage);

/**
 * 豆瓣和 IMDb 各持一条独立的请求队列。
 *
 * 这不是洁癖，是必须的：两边的限流是各自独立的，共用一条队列意味着豆瓣
 * 进入退避期时 IMDb 也一起停摆 —— 而这个项目里豆瓣的匿名配额恰恰是最容易
 * 打穿的那个。分开之后，最坏情况也只是少一半分数，而不是整个角标消失。
 */
const doubanQueue = new RequestQueue({
  onBackoffChange: (until) => void saveBackoff(storage, { queue: until }),
});
const doubanClient = new DoubanClient(doubanQueue, {
  onFullSearchBackoffChange: (until) => void saveBackoff(storage, { fullSearch: until }),
});
const doubanCache = new RatingCache(storage, undefined, undefined, CACHE_PREFIXES.douban);
const doubanLookup = new RatingLookup(new DoubanProvider(doubanClient), doubanCache, interest);

/**
 * IMDb 侧的节流明显放宽：它不像豆瓣那样对匿名访问掐得那么死，而且每部片
 * 要两次请求（检索 + 取分），沿用 2.5 秒的间隔会让 IMDb 的分永远落在
 * 豆瓣后面很久才出来。
 */
const imdbQueue = new RequestQueue({
  minIntervalMs: 600,
  jitterMs: 300,
  onBackoffChange: (until) => void saveBackoff(storage, { imdbQueue: until }),
});
const imdbClient = new ImdbClient(imdbQueue);
const imdbCache = new RatingCache(storage, undefined, undefined, CACHE_PREFIXES.imdb);
const imdbLookup = new RatingLookup(new ImdbProvider(imdbClient), imdbCache, interest);

/**
 * 恢复上一次进程留下的退避状态。
 *
 * service worker 每次冷启动都会重新执行本模块，若不恢复，扩展会在对方仍在
 * 限流时立刻重新开打 —— 而 MV3 的 worker 闲置 30 秒就被回收，用户稍作停顿
 * 再滚动就会触发一次，等于持续把限流打得更深。
 */
const backoffRestored = (async () => {
  const state = await loadBackoff(storage);
  doubanQueue.restoreBackoff(state.queue);
  doubanClient.restoreFullSearchBackoff(state.fullSearch);
  imdbQueue.restoreBackoff(state.imdbQueue);
})();

const DISABLED: LookupOutcome = { status: 'disabled' };

async function handle(request: ExtensionRequest): Promise<ExtensionResponse> {
  switch (request.kind) {
    case 'lookup': {
      // 等退避状态恢复完再放行，否则冷启动后的头几个请求会绕过退避。
      await backoffRestored;
      const settings = await loadSettings();
      // 分站点开关：关掉的站点不产生任何请求，不只是不显示。
      const active = settings.enabled && settings.sites[request.site];

      // 两个来源并行查。它们走各自的队列，谁也不用等谁 —— 串行的话
      // 一张卡片要等两条队列依次排完，出分速度直接砍半。
      const [douban, imdb] = await Promise.all([
        active && settings.sources.douban ? doubanLookup.lookup(request.query) : DISABLED,
        active && settings.sources.imdb ? imdbLookup.lookup(request.query) : DISABLED,
      ]);
      return { kind: 'lookup', outcome: { douban, imdb } satisfies RatingsOutcome };
    }
    case 'interest': {
      // 关掉扩展时不记录 —— 用户没在用这个功能，攒的记录只是噪音。
      const settings = await loadSettings();
      const recorded = settings.enabled ? await interest.mark(request.query) : false;
      return { kind: 'interest', recorded };
    }
    case 'clearCache': {
      // 两边一起清。用户点这个按钮的意思是「重新查一遍」，
      // 只清一半会留下一半旧结果，反而更难解释。
      const [douban, imdb] = await Promise.all([doubanCache.clear(), imdbCache.clear()]);
      return { kind: 'clearCache', cleared: douban + imdb };
    }
    case 'status': {
      const [doubanEntries, imdbEntries, interestEntries] = await Promise.all([
        doubanCache.size(),
        imdbCache.size(),
        interest.size(),
      ]);
      return {
        kind: 'status',
        status: {
          cachedEntries: doubanEntries + imdbEntries,
          doubanEntries,
          imdbEntries,
          // 任一来源在退避都要让用户看见，取恢复得最晚的那个。
          backoffUntil: latest(doubanQueue.backoffUntil, imdbQueue.backoffUntil),
          pendingRequests: doubanQueue.pending + imdbQueue.pending,
          interestEntries,
        },
      };
    }
  }
}

function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  handle(request).then(sendResponse, (error: unknown) => {
    console.error('[豆瓣评分] 处理消息失败', error);
    const reason = error instanceof Error ? error.message : String(error);
    sendResponse({
      kind: 'lookup',
      outcome: { douban: { status: 'error', reason }, imdb: { status: 'error', reason } },
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
