'use strict';

const { runRustPlannerPipeline } = require('./rust-planner-runner');

/**
 * @param {object} deps — 同 rust-planner-runner
 */
function createMainPlannerRunner(deps) {
  return {
    runPipeline(payload, opts = {}) {
      return runRustPlannerPipeline(deps, payload, opts);
    }
  };
}

module.exports = { createMainPlannerRunner, runRustPlannerPipeline };
