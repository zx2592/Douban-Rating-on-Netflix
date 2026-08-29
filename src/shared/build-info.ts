/**
 * 构建版本戳。
 *
 * 加这个是因为排查时反复遇到同一类困惑：改动推送了、代码也验证过是对的，
 * 但页面上的行为还是旧的 —— 因为 git pull 不会自动重建，重建后还要去
 * chrome://extensions 点刷新，三步缺一不可，而少做一步和「代码有 bug」
 * 在表现上完全一样。有了版本戳，「跑的是哪一版」就是一句话能查清的事实，
 * 不用再靠猜。
 */

declare const __BUILD_ID__: string | undefined;

/** 构建时注入；直接跑源码（如单测）时没有注入，回落到 dev。 */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
