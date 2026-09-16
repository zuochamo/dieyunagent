'use strict';

module.exports = {
  root: true,
  ignorePatterns: [
    'node_modules',
    'dist',
    'release',
    'target',
    '打分',
    'DeepSeek-Harness'
  ],
  overrides: [
    {
      files: ['src/agent/**/*.js', 'scripts/test-*.cjs'],
      env: { node: true, es2022: true },
      parserOptions: { ecmaVersion: 2022 },
      extends: ['eslint:recommended'],
      rules: {
        'no-undef': 'off',
        'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        // 空 catch 不再豁免：本 scope（等价于 lint:agent 的扫描范围）实测 0 处空 catch。
        // 页面注入脚本里的 `catch (_) {}` 位于模板字符串内（是字符串、不是代码），ESLint 解析不到，无需在此开口子。
        'no-empty': 'error',
        'no-constant-condition': ['error', { checkLoops: false }],
        'no-useless-escape': 'off',
        'no-control-regex': 'off',
        'no-inner-declarations': 'off'
      }
    }
  ]
};
