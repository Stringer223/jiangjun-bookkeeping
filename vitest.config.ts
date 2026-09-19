import { defineConfig } from 'vitest/config'

// ⚠️ jsdom 版本被钉在 24.x，不要升级。
// 本机 Node 是 20，而 jsdom 25+ 的依赖链里存在「CJS 用 require() 加载 ESM-only 模块」的写法，
// Node 20 不支持 require(ESM)，会直接报 ERR_REQUIRE_ESM 让整个测试命令失败
// （jsdom 30 更是明确要求 node ^22.22.2 || ^24.15.0 || >=26）。
// 将来把 Node 升到 22+ 之后，才可以考虑同步升级 jsdom。

export default defineConfig({
  test: {
    // 只收同目录下的 *.test.ts，避免误把打包产物 out/ 或 dist/ 里的文件当测试
    include: ['src/**/*.test.ts'],
    // 全局用 node 环境：多数被测代码是纯 TS，不需要浏览器。
    // 需要 window 的文件（useSnakeGame.test.ts）用文件顶部的
    // `// @vitest-environment jsdom` 单独切换，不影响其他用例
    environment: 'node'
  }
})
