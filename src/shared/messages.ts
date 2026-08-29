import type { LookupOutcome, MediaQuery } from './types';

/** 内容脚本 → background：查一部片子的豆瓣评分。 */
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

export type ExtensionRequest = LookupRequest | ClearCacheRequest | StatusRequest;

export interface StatusResponse {
  cachedEntries: number;
  /** 若正处于退避期，给出恢复时间戳（epoch ms）。 */
  backoffUntil: number | null;
  pendingRequests: number;
}

export type ExtensionResponse =
  | { kind: 'lookup'; outcome: LookupOutcome }
  | { kind: 'clearCache'; cleared: number }
  | { kind: 'status'; status: StatusResponse };

/**
 * 从内容脚本或 popup 发起一次请求。
 *
 * background service worker 随时可能被浏览器回收，此时 sendMessage 会抛
 * "Receiving end does not exist"。这里统一兜住，转成一个可展示的 error，
 * 而不是让内容脚本里冒出一个未捕获的 promise rejection。
 */
export async function sendRequest(request: LookupRequest): Promise<LookupOutcome>;
export async function sendRequest(request: ClearCacheRequest): Promise<number>;
export async function sendRequest(request: StatusRequest): Promise<StatusResponse>;
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
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (request.kind === 'lookup') {
      return { status: 'error', reason } satisfies LookupOutcome;
    }
    throw error;
  }
}
