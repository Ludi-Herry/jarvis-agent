// @ts-check
// 变异测试配置：只改"裁判"代码（权限判定 + 完成判定），看测试能不能抓住改坏。
// 本地跑法见 docs/quality-gates.md；CI 里由 .github/workflows/mutation.yml 调用。
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'scripts/mutation/vitest.mutation.config.ts' },
  mutate: [
    'src/capabilities/goal/verdict.ts',
    'src/runtime/permission/decide.ts',
    'src/runtime/permission/permission-gate.ts',
    'src/runtime/permission/command.ts',
  ],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  // 只报告、不让 CI 因分数失败；放行方向的存活变异由人看摘要处理（见 AGENTS.md）
  thresholds: { high: 90, low: 75, break: null },
  concurrency: 2,
};
