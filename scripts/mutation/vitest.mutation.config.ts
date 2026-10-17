import { defineConfig } from 'vitest/config';

// 变异测试只跑和"裁判"代码相关的测试，速度快很多
export default defineConfig({
  test: {
    include: [
      'test/capabilities/goal/verdict*.test.ts',
      'test/runtime/permission/**/*.test.ts',
      'test/surfaces/gui/gui-plain-controls*.test.ts',
    ],
    testTimeout: 20_000,
  },
});
