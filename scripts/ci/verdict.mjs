#!/usr/bin/env node
// Run the repository's CI checks natively against the current working tree and print one
// pass/fail verdict.
//
// The lanes and their commands live in verdictLanes.mjs and mirror .github/workflows/tests.yml.
// This runner owns scheduling, capture, and reporting only; it does not decide what a check is.
//
//   node scripts/ci/verdict.mjs                 fast tier (the default verdict)
//   node scripts/ci/verdict.mjs --tier=slow     the expensive/environment-dependent tier
//   node scripts/ci/verdict.mjs --lane=cli,ui   named lanes, any tier
//   node scripts/ci/verdict.mjs --list          show lanes without running them
//   node scripts/ci/verdict.mjs --jobs=N        override the core budget

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { argv, cwd, env, exit, stdout } from 'node:process';

import { ENVIRONMENT_NOTES, LANES, PREPARE, lanesForTier } from './verdictLanes.mjs';

const LOG_DIR = join(cwd(), '.project', 'logs', 'verdict');
const CORES = availableParallelism();

const COLOR = stdout.isTTY && !env.NO_COLOR;
const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

function parseArgs(args) {
  const options = { tier: 'fast', lanes: null, list: false, jobs: CORES };
  for (const arg of args) {
    if (arg === '--list') options.list = true;
    else if (arg.startsWith('--tier=')) options.tier = arg.slice('--tier='.length);
    else if (arg.startsWith('--lane=')) options.lanes = arg.slice('--lane='.length).split(',').filter(Boolean);
    else if (arg.startsWith('--jobs=')) options.jobs = Number(arg.slice('--jobs='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['fast', 'slow', 'all'].includes(options.tier)) {
    throw new Error(`--tier must be fast, slow, or all (got ${options.tier})`);
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) {
    throw new Error(`--jobs must be a positive integer (got ${options.jobs})`);
  }
  return options;
}

function selectLanes(options) {
  if (!options.lanes) return lanesForTier(options.tier);
  const byId = new Map(LANES.map((lane) => [lane.id, lane]));
  return options.lanes.map((id) => {
    const lane = byId.get(id);
    if (!lane) throw new Error(`Unknown lane: ${id}. Known lanes: ${LANES.map((l) => l.id).join(', ')}`);
    return lane;
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// Run one shell command, capturing combined output. Resolves with the exit code rather
// than rejecting, so a failing check is data and not an exception.
function runCommand(command, { onChunk, workers }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: '/bin/bash',
      cwd: cwd(),
      env: {
        ...env,
        CI: '1',
        FORCE_COLOR: '0',
        // vitest reads these as its pool ceiling. Without them every lane sizes its own pool
        // from the full core count, so N concurrent lanes each try to own the machine and the
        // run gets slower and flakier than running them one at a time.
        ...(workers ? { VITEST_MAX_THREADS: String(workers), VITEST_MAX_FORKS: String(workers) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (error) => {
      onChunk(Buffer.from(`\n[verdict] failed to spawn: ${error.message}\n`));
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function probeLane(lane) {
  if (!lane.probe) return true;
  const code = await runCommand(lane.probe, { onChunk: () => {} });
  return code === 0;
}

async function runLane(lane) {
  const startedAt = Date.now();
  if (!(await probeLane(lane))) {
    return {
      lane,
      status: 'skipped',
      durationMs: Date.now() - startedAt,
      reason: lane.requires ?? 'prerequisite missing',
      logPath: null,
      failedCommand: null,
    };
  }

  const chunks = [];
  let failedCommand = null;
  let code = 0;
  for (const command of lane.commands) {
    chunks.push(Buffer.from(`\n$ ${command}\n`));
    code = await runCommand(command, { onChunk: (chunk) => chunks.push(chunk), workers: lane.weight });
    if (code !== 0) {
      failedCommand = command;
      break; // Later commands in a lane assume the earlier ones succeeded.
    }
  }

  const logPath = join(LOG_DIR, `${lane.id}.log`);
  await writeFile(logPath, Buffer.concat(chunks));
  return {
    lane,
    status: code === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    reason: null,
    logPath,
    failedCommand,
  };
}

// Pack lanes onto the core budget by weight, starting the slowest first so a long pole runs
// from t=0 instead of being scheduled last and defining the wall clock on its own. Ordering is
// by expected duration, not weight: the slowest lanes here are the deliberately serial ones,
// which are exactly the lanes a weight-ordered queue would start last.
async function runLanes(lanes, budget) {
  const queue = [...lanes].sort((a, b) => b.expectSeconds - a.expectSeconds);
  const results = [];
  const running = new Set();
  let used = 0;

  const startable = () => queue.findIndex((lane) => used === 0 || used + lane.weight <= budget);

  while (queue.length > 0 || running.size > 0) {
    let index = startable();
    while (index !== -1) {
      const [lane] = queue.splice(index, 1);
      used += lane.weight;
      stdout.write(dim(`  ▸ ${lane.id} started\n`));
      const task = runLane(lane).then((result) => {
        used -= lane.weight;
        running.delete(task);
        results.push(result);
        const mark = result.status === 'passed' ? green('✓') : result.status === 'failed' ? red('✗') : yellow('–');
        stdout.write(`  ${mark} ${lane.id} ${dim(formatDuration(result.durationMs))}\n`);
        return result;
      });
      running.add(task);
      index = startable();
    }
    if (running.size > 0) await Promise.race(running);
  }
  return results;
}

function report(results, wallMs, options) {
  const order = new Map(LANES.map((lane, index) => [lane.id, index]));
  results.sort((a, b) => order.get(a.lane.id) - order.get(b.lane.id));

  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const passed = results.filter((r) => r.status === 'passed');

  stdout.write(`\n${bold('Lane results')}\n`);
  const width = Math.max(...results.map((r) => r.lane.id.length));
  for (const result of results) {
    const mark = result.status === 'passed' ? green('pass') : result.status === 'failed' ? red('FAIL') : yellow('skip');
    const note = result.status === 'skipped' ? dim(`  needs ${result.reason}`) : '';
    stdout.write(`  ${mark}  ${result.lane.id.padEnd(width)}  ${formatDuration(result.durationMs).padStart(6)}${note}\n`);
  }

  if (failed.length > 0) {
    stdout.write(`\n${bold('Failures')}\n`);
    for (const result of failed) {
      stdout.write(`\n  ${red(result.lane.id)} — ${result.failedCommand}\n`);
      stdout.write(`  ${dim(`full log: ${result.logPath}`)}\n`);
    }
  }

  stdout.write(`\n${bold('Wall clock')}: ${formatDuration(wallMs)} (tier=${options.tier}, ${options.jobs} cores)\n`);

  if (failed.length === 0 && skipped.length === 0) {
    stdout.write(`${green(bold('VERDICT: PASS'))} — ${passed.length} lanes, nothing skipped.\n`);
    return 0;
  }
  if (failed.length === 0) {
    stdout.write(
      `${yellow(bold('VERDICT: INCOMPLETE'))} — ${passed.length} lanes passed, ` +
        `${skipped.length} could not run (${skipped.map((r) => r.lane.id).join(', ')}).\n`,
    );
    return 0;
  }
  stdout.write(
    `${red(bold('VERDICT: FAIL'))} — ${failed.length} of ${results.length} lanes failed: ` +
      `${failed.map((r) => r.lane.id).join(', ')}.\n`,
  );
  return 1;
}

async function main() {
  const options = parseArgs(argv.slice(2));
  const lanes = selectLanes(options);

  if (options.list) {
    for (const lane of LANES) {
      const selected = lanes.includes(lane) ? '*' : ' ';
      stdout.write(`${selected} ${lane.id.padEnd(20)} ${lane.tier.padEnd(5)} weight=${String(lane.weight).padEnd(3)}`);
      stdout.write(lane.requires ? ` ${dim(`needs ${lane.requires}`)}\n` : '\n');
    }
    return 0;
  }

  await mkdir(LOG_DIR, { recursive: true });
  stdout.write(`${bold('Local verdict')} — ${lanes.length} lanes, ${options.jobs} cores\n`);
  const startedAt = Date.now();

  for (const note of ENVIRONMENT_NOTES) {
    if ((await runCommand(note.probe, { onChunk: () => {} })) !== 0) {
      stdout.write(`  ${yellow('!')} ${note.note}\n`);
    }
  }

  for (const step of PREPARE) {
    const chunks = [];
    const code = await runCommand(step.command, { onChunk: (chunk) => chunks.push(chunk) });
    if (code !== 0) {
      const logPath = join(LOG_DIR, 'prepare.log');
      await writeFile(logPath, Buffer.concat(chunks));
      stdout.write(`${red('prepare failed')}: ${step.command}\n  ${dim(`full log: ${logPath}`)}\n`);
      return 2;
    }
    stdout.write(dim(`  prepared ${step.label}\n`));
  }

  const results = await runLanes(lanes, options.jobs);
  return report(results, Date.now() - startedAt, options);
}

main().then(exit, (error) => {
  stdout.write(`${red('verdict failed to start')}: ${error.message}\n`);
  exit(2);
});
