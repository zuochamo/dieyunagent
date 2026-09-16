'use strict';

const path = require('path');
const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');

function coreBinaryPath() {
  const exe = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
  return (
    process.env.DIEYUN_CORE_BIN ||
    resolveDieyunCoreBinary() ||
    path.join(__dirname, '..', 'target', 'debug', exe)
  );
}

async function main() {
  const bridge = createCoreBridge({ binaryPath: coreBinaryPath() });
  await bridge.start();
  await bridge.configure({
    data_dir: path.join(require('os').tmpdir(), 'dieyun-planner-rpc-test'),
    workspace_roots: [process.cwd()],
    models_dirs: [path.join(__dirname, '..', 'models')],
    embedding: { disabled: true, builtin: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024 }
  });

  const ping = await bridge.invoke('planner.ping', {}, 10000);
  if (!ping?.ok) throw new Error('planner.ping failed');

  const start = await bridge.invoke(
    'planner.run.start',
    {
      model: 'test',
      sysContent: 'sys',
      userText: 'fix bug',
      hasExploreTools: false
    },
    10000
  );
  const runId = start?.runId;
  if (!runId) throw new Error('missing runId');
  if (start.phase !== 'need_plan_llm') throw new Error(`expected need_plan_llm got ${start.phase}`);

  const planJson =
    '{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do","expectedOutput":"done"}]}';
  let r = await bridge.invoke(
    'planner.run.continue',
    { runId, step: 'plan_llm', content: planJson },
    10000
  );
  if (r.phase !== 'need_workers') throw new Error(`expected need_workers got ${r.phase}`);

  r = await bridge.invoke(
    'planner.run.continue',
    {
      runId,
      step: 'worker_batch',
      workerResults: [{ id: 'A1', worker: 'A', output: 'done', error: null }]
    },
    10000
  );
  if (r.phase !== 'need_review_llm') throw new Error(`expected need_review_llm got ${r.phase}`);

  r = await bridge.invoke(
    'planner.run.continue',
    { runId, step: 'review_llm', content: '{"accepted":true,"retry":[],"notes":"ok"}' },
    10000
  );
  if (r.phase !== 'need_synthesize_llm') throw new Error(`expected need_synthesize_llm got ${r.phase}`);

  r = await bridge.invoke(
    'planner.run.continue',
    { runId, step: 'synthesize_llm', content: 'final answer' },
    10000
  );
  if (r.phase !== 'done') throw new Error(`expected done got ${r.phase}`);

  console.log('OK planner.run RPC flow', { runId, content: r.content });

  const startBn = await bridge.invoke(
    'planner.run.start',
    {
      model: 'test',
      sysContent: 'sys',
      userText: 'build feature',
      hasExploreTools: false,
      bestOfN: 3
    },
    10000
  );
  const runIdBn = startBn?.runId;
  const planBn =
    '{"planSummary":"bn","bestOfN":3,"subtasks":[{"id":"A1","worker":"A","agentType":"build","title":"t","instruction":"do","expectedOutput":"done"}]}';
  r = await bridge.invoke(
    'planner.run.continue',
    { runId: runIdBn, step: 'plan_llm', content: planBn },
    10000
  );
  if (r.phase !== 'need_best_of_n_attempt') throw new Error(`expected need_best_of_n_attempt got ${r.phase}`);
  for (let i = 1; i <= 3; i++) {
    r = await bridge.invoke(
      'planner.run.continue',
      {
        runId: runIdBn,
        step: 'best_of_n_attempt',
        workerResults: [{ id: 'A1', worker: 'A', output: `try${i}`, error: null }]
      },
      10000
    );
    if (i < 3 && r.phase !== 'need_best_of_n_attempt') {
      throw new Error(`attempt ${i} expected need_best_of_n_attempt got ${r.phase}`);
    }
  }
  if (r.phase !== 'need_best_of_n_pick_llm') throw new Error(`expected need_best_of_n_pick_llm got ${r.phase}`);
  r = await bridge.invoke(
    'planner.run.continue',
    { runId: runIdBn, step: 'best_of_n_pick_llm', content: '{"winnerIndex":2}' },
    10000
  );
  if (r.phase !== 'need_review_llm') throw new Error(`expected need_review_llm after pick got ${r.phase}`);
  console.log('OK planner.run Best-of-N RPC flow');

  const resumeCp = {
    plan: {
      planSummary: 'resume',
      todos: ['a', 'b'],
      subtasks: [
        {
          id: 'A1',
          worker: 'A',
          agentType: 'build',
          title: 't1',
          instruction: 'i1',
          expectedOutput: 'o1'
        },
        {
          id: 'B1',
          worker: 'B',
          agentType: 'shell',
          title: 't2',
          instruction: 'i2',
          expectedOutput: 'o2'
        }
      ],
      bestOfN: 0,
      fallback: false
    },
    completedOutputs: [{ id: 'A1', worker: 'A', output: 'done-a' }]
  };
  const startResume = await bridge.invoke(
    'planner.run.start',
    {
      model: 'test',
      sysContent: 'sys',
      userText: 'resume run',
      hasExploreTools: false,
      resumeCheckpoint: resumeCp
    },
    10000
  );
  const runIdResume = startResume?.runId;
  if (startResume.phase !== 'need_workers') {
    throw new Error(`resume expected need_workers got ${startResume.phase}`);
  }
  const jobs = startResume.workerJobs || [];
  if (jobs.length !== 1 || jobs[0].worker !== 'B') {
    throw new Error(`resume expected only worker B, got ${JSON.stringify(jobs)}`);
  }
  r = await bridge.invoke(
    'planner.run.continue',
    {
      runId: runIdResume,
      step: 'worker_batch',
      workerResults: [{ id: 'B1', worker: 'B', output: 'done-b', error: null }]
    },
    10000
  );
  if (r.phase !== 'need_review_llm') throw new Error(`resume expected need_review_llm got ${r.phase}`);
  console.log('OK planner.run checkpoint resume RPC flow');

  await bridge.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
