'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    include: ['test/unit/**/*.test.cjs'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    globals: true
  }
});
