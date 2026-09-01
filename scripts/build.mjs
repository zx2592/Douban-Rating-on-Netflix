#!/usr/bin/env node
/**
 * 构建脚本。
 *
 * 用 esbuild 直接打包，没有走 Vite / CRXJS 之类的扩展脚手架：MV3 对三类产物的
 * 要求各不相同（service worker 必须是 ESM、内容脚本必须是无 import 的 IIFE、
 * popup 是普通脚本），用 esbuild 逐个指定反而最直白，也免去了脚手架插件跟
 * Chrome 规则不同步时的排查成本。
 */
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

/** 静态文件：原样拷进 dist。 */
const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/content/badge.css', 'badge.css'],
  ['src/probe/probe.html', 'probe.html'],
  ['src/probe/probe.css', 'probe.css'],
  ['icons', 'icons'],
];

const bundles = [
  {
    entryPoints: [resolve(root, 'src/background/index.ts')],
    outfile: resolve(outDir, 'background.js'),
    // service worker 在 manifest 里声明为 "type": "module"，所以产物必须是 ESM。
    format: 'esm',
  },
  {
    entryPoints: [resolve(root, 'src/content/netflix/index.ts')],
    outfile: resolve(outDir, 'content-netflix.js'),
    // 内容脚本不支持 ESM，必须打成自执行函数，且不能残留 import。
    format: 'iife',
  },
  {
    entryPoints: [resolve(root, 'src/content/primevideo/index.ts')],
    outfile: resolve(outDir, 'content-primevideo.js'),
    format: 'iife',
  },
  {
    entryPoints: [resolve(root, 'src/popup/popup.ts')],
    outfile: resolve(outDir, 'popup.js'),
    format: 'iife',
  },
  {
    // 临时的检索接口诊断页，定完检索方案后连同 src/probe/ 一起删掉。
    entryPoints: [resolve(root, 'src/probe/probe.ts')],
    outfile: resolve(outDir, 'probe.js'),
    format: 'iife',
  },
];

/** 构建版本戳：注入进产物，页面上可查，用于确认「跑的是哪一版」。 */
const buildId = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const shared = {
  bundle: true,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  target: 'chrome110',
  platform: 'browser',
  logLevel: 'info',
  // 保留可读的产物，方便应用商店审核时人工核对代码。
  minify: false,
  sourcemap: watch ? 'inline' : false,
};

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    await cp(resolve(root, from), resolve(outDir, to), { recursive: true });
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyStatic();

  if (!watch) {
    await Promise.all(bundles.map((bundle) => build({ ...shared, ...bundle })));
    console.log(`构建完成 → ${outDir}`);
    console.log(`版本戳 ${buildId}`);
    console.log('在 Netflix 页面 Console 里执行 document.documentElement.dataset.dbrLoaded');
    console.log('应当返回同一个版本戳；不一致说明扩展还没重新加载。');
    console.log('在 chrome://extensions 打开开发者模式，点「加载已解压的扩展程序」选择 dist 目录。');
    return;
  }

  const contexts = await Promise.all(bundles.map((bundle) => context({ ...shared, ...bundle })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('监听中，修改源码会自动重建。改完在 chrome://extensions 点一下刷新按钮。');
}

await main();
