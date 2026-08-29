import type { MediaQuery, RatingsOutcome } from './types';

/** 内容脚本 → background：查一部片子在各来源上的评分。 */
export interface LookupRequest {
  kind: 'lookup';
  query: MediaQuery;
}

/** popup → background：清空评分缓存。 */
export interface ClearCacheRequest {
  kind: 'clearCache';
}

/** popup → background：读取运行状态，用于在设置页展示缓存条数、是否正被豆瓣限流。 */
export interface StatusRequest {
  kind: 'status';
}

/**
 * 内容脚本 → background：用户点开了这部片。
 *
 * 点击是最强的兴趣信号，background 据此把这部片的查询提到高优先级，
 * 并允许它绕过一次早先写下的「未收录」缓存。
 */
export interface InterestRequest {
  kind: 'interest';
  query: MediaQuery;
}

export type ExtensionRequest =
  | LookupRequest
  | ClearCacheRequest
  | StatusRequest
  | InterestRequest;

export interface StatusResponse {
  /** 两个来源合计的缓存条数。 */
  cachedEntries: number;
  doubanEntries: number;
  imdbEntries: number;
  /** 若正处于退避期，给出恢复时间戳（epoch ms）。 */
  backoffUntil: number | null;
  pendingRequests: number;
  /** 已记录的「感兴趣」影片数。 */
  interestEntries: number;
}

export type ExtensionResponse =
  | { kind: 'lookup'; outcome: RatingsOutcome }
  | { kind: 'clearCache'; cleared: number }
  | { kind: 'status'; status: StatusResponse }
  | { kind: 'interest'; recorded: boolean };

/**
 * 从内容脚本或 popup 发起一次请求。
 *
 * background service worker 随时可能被浏览器回收，此时 sendMessage 会抛
 * "Receiving end does not exist"。这里统一兜住，转成一个可展示的 error，
 * 而不是让内容脚本里冒出一个未捕获的 promise rejection。
 */
export async function sendRequest(request: LookupRequest): Promise<RatingsOutcome>;
export async function sendRequest(request: ClearCacheRequest): Promise<number>;
export async function sendRequest(request: StatusRequest): Promise<StatusResponse>;
export async function sendRequest(request: InterestRequest): Promise<boolean>;
export async function sendRequest(request: ExtensionRequest): Promise<unknown> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse | undefined;
    if (!response) throw new Error('background 无响应');
    switch (response.kind) {
      case 'lookup':
        return response.outcome;
      case 'clearCache':
        return response.cleared;
      case 'status':
        return response.status;
      case 'interest':
        return response.recorded;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (request.kind === 'lookup') {
      // 两个来源都记成错误：错在消息通道上，跟具体来源无关。
      return {
        douban: { status: 'error', reason },
        imdb: { status: 'error', reason },
      } satisfies RatingsOutcome;
    }
    // 记录兴趣只是一个锦上添花的信号，background 不在时静默失败即可，
    // 不值得让内容脚本因此抛错。
    if (request.kind === 'interest') {
      console.warn('[豆瓣评分] 记录兴趣失败', reason);
      return false;
    }
    throw error;
  }
}
