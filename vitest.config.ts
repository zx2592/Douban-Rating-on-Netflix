import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // 默认跑在 node 里；需要 DOM 的用例在文件顶部用
    // `// @vitest-environment jsdom` 单独声明，避免所有用例都付出 jsdom 的启动开销。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
