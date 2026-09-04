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
//   node scripts/ci/verdict.mjs --workers=N     per-lane vitest worker cap (default 6)
//   node scripts/ci/verdict.mjs --lanes-at-once=N  concurrent lanes (default 1, serial)
//
// This machine is shared with other agent sessions and with Jacob's desktop, so the run is a
// guest on it: lanes go one at a time, every child runs at nice 19, the vitest pool is capped
// well below the core count, and the fleet gate is consulted before each lane. Fanning out
// bought little (the wall clock is the serial `stack` lane either way) and cost a lot: it drove
// load to 108 on a 36-core box and corrupted a sibling session's test run in another worktree.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { argv, cwd, env, exit, stdout } from 'node:process';

import { ENVIRONMENT_NOTES, LANES, PREPARE, lanesForTier } from './verdictLanes.mjs';

const LOG_DIR = join(cwd(), '.project', 'logs', 'verdict');
const CORES = availableParallelism();

// Single digit on purpose. vitest otherwise sizes its pool from the core count, which is wrong
// on a box where 17 other sessions are doing the same thing.
const DEFAULT_WORKERS = 6;
// Lanes are serial by default; the long pole is serial anyway, so fan-out is nearly free to give up.
const DEFAULT_LANES_AT_ONCE = 1;
const FLEET_GATE = '/home/jacob/code/hermes-lite/bin/fleet-gate.py';
const GATE_POLL_MS = 30_000;
const GATE_MAX_WAIT_MS = 20 * 60_000;
// A lane that emits nothing for this long is hung, not slow: the serial stack lane prints a TAP
// line per test and vitest reports per file, so real work is never silent for a quarter hour.
const STALL_MS = 15 * 60_000;
const STALL_CHECK_MS = 15_000;

const COLOR = stdout.isTTY && !env.NO_COLOR;
const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

function parseArgs(args) {
  const options = {
    tier: 'fast',
    lanes: null,
    list: false,
    workers: DEFAULT_WORKERS,
    lanesAtOnce: DEFAULT_LANES_AT_ONCE,
  };
  for (const arg of args) {
    if (arg === '--list') options.list = true;
    else if (arg.startsWith('--tier=')) options.tier = arg.slice('--tier='.length);
    else if (arg.startsWith('--lane=')) options.lanes = arg.slice('--lane='.length).split(',').filter(Boolean);
    else if (arg.startsWith('--workers=')) options.workers = Number(arg.slice('--workers='.length));
    else if (arg.startsWith('--lanes-at-once=')) options.lanesAtOnce = Number(arg.slice('--lanes-at-once='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['fast', 'slow', 'all'].includes(options.tier)) {
    throw new Error(`--tier must be fast, slow, or all (got ${options.tier})`);
  }
  for (const key of ['workers', 'lanesAtOnce']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new Error(`--${key} must be a positive integer (got ${options[key]})`);
    }
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
function runCommand(command, { onChunk, workers, stallMs = 0 }) {
  return new Promise((resolve) => {
    // nice 19 so anything Jacob does at the keyboard preempts the suite. detached gives the
    // command its own process group, so a stall abort takes the whole worker pool with it
    // rather than orphaning workers that keep holding the machine.
    const child = spawn(`nice -n 19 ${command}`, {
      shell: '/bin/bash',
      cwd: cwd(),
      detached: true,
      env: {
        ...env,
        CI: '1',
        FORCE_COLOR: '0',
        // vitest reads these as its pool ceiling; without them it sizes the pool from the core
        // count and ignores every other session on the box.
        ...(workers ? { VITEST_MAX_THREADS: String(workers), VITEST_MAX_FORKS: String(workers) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastOutputAt = Date.now();
    let stalled = false;
    const observe = (chunk) => {
      lastOutputAt = Date.now();
      onChunk(chunk);
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);

    const watchdog = stallMs
      ? setInterval(() => {
          if (Date.now() - lastOutputAt < stallMs) return;
          stalled = true;
          clearInterval(watchdog);
          onChunk(Buffer.from(`\n[verdict] no output for ${Math.round(stallMs / 60_000)}m — aborting\n`));
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, STALL_CHECK_MS)
      : null;

    child.on('error', (error) => {
      if (watchdog) clearInterval(watchdog);
      onChunk(Buffer.from(`\n[verdict] failed to spawn: ${error.message}\n`));
      resolve({ code: 1, stalled: false });
    });
    child.on('close', (code) => {
      if (watchdog) clearInterval(watchdog);
      resolve({ code: code ?? 1, stalled });
    });
  });
}

async function probeLane(lane) {
  if (!lane.probe) return true;
  const { code } = await runCommand(lane.probe, { onChunk: () => {} });
  return code === 0;
}

async function runLane(lane, workers) {
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

  // Stream to the log as output arrives, rather than buffering to the end. A lane that is
  // still writing is demonstrably alive, which is what makes watching this run cheap.
  const logPath = join(LOG_DIR, `${lane.id}.log`);
  const log = createWriteStream(logPath);
  let failedCommand = null;
  let code = 0;
  let stalled = false;
  for (const command of lane.commands) {
    log.write(`\n$ ${command}\n`);
    ({ code, stalled } = await runCommand(command, {
      onChunk: (chunk) => log.write(chunk),
      workers,
      stallMs: STALL_MS,
    }));
    if (code !== 0) {
      failedCommand = command;
      break; // Later commands in a lane assume the earlier ones succeeded.
    }
  }
  await new Promise((resolve) => log.end(resolve));

  return {
    lane,
    status: stalled ? 'stalled' : code === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    reason: stalled ? `no output for ${Math.round(STALL_MS / 60_000)}m` : null,
    logPath,
    failedCommand,
  };
}

// Ask the shared-machine gate whether it is polite to start more work. A refusal is honoured,
// not overridden: this box runs Jacob's desktop and other agent sessions. Waiting is correct;
// starting anyway is how load reached 108 earlier and broke a sibling session's suite.
async function waitForFleetGate() {
  if (!existsSync(FLEET_GATE)) return { ok: true, waitedMs: 0 };
  const startedAt = Date.now();
  for (;;) {
    const chunks = [];
    await runCommand(FLEET_GATE, { onChunk: (chunk) => chunks.push(chunk) });
    const output = Buffer.concat(chunks).toString();
    if (output.includes('Launch allowed')) return { ok: true, waitedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= GATE_MAX_WAIT_MS) {
      return { ok: false, waitedMs: Date.now() - startedAt, reason: output.trim().split('\n')[0] };
    }
    stdout.write(dim(`  … fleet busy, waiting ${GATE_POLL_MS / 1000}s before the next lane\n`));
    await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
  }
}

// Slowest lane first, so if the gate later refuses and the run stops short, the expensive lane
// is already done rather than the one left unrun.
async function runLanes(lanes, options) {
  const queue = [...lanes].sort((a, b) => b.expectSeconds - a.expectSeconds);
  const results = [];
  const running = new Set();

  while (queue.length > 0) {
    if (running.size >= options.lanesAtOnce) {
      await Promise.race(running);
      continue;
    }
    const gate = await waitForFleetGate();
    if (!gate.ok) {
      // Never silently drop a lane: everything left is reported as not run.
      for (const lane of queue) {
        results.push({ lane, status: 'not-run', durationMs: 0, reason: gate.reason, logPath: null, failedCommand: null });
      }
      break;
    }
    const lane = queue.shift();
    stdout.write(dim(`  ▸ ${lane.id} started\n`));
    const task = runLane(lane, Math.min(options.workers, lane.weight)).then((result) => {
      running.delete(task);
      results.push(result);
      const mark = result.status === 'passed' ? green('✓') : result.status === 'failed' ? red('✗') : yellow('–');
      stdout.write(`  ${mark} ${lane.id} ${dim(formatDuration(result.durationMs))}\n`);
      return result;
    });
    running.add(task);
  }
  await Promise.all(running);
  return results;
}

function report(results, wallMs, options) {
  const order = new Map(LANES.map((lane, index) => [lane.id, index]));
  results.sort((a, b) => order.get(a.lane.id) - order.get(b.lane.id));

  const failed = results.filter((r) => r.status === 'failed' || r.status === 'stalled');
  const skipped = results.filter((r) => r.status === 'skipped');
  const notRun = results.filter((r) => r.status === 'not-run');
  const stalled = results.filter((r) => r.status === 'stalled');
  const passed = results.filter((r) => r.status === 'passed');

  stdout.write(`\n${bold('Lane results')}\n`);
  const width = Math.max(...results.map((r) => r.lane.id.length));
  for (const result of results) {
    const mark = result.status === 'passed'
      ? green('pass')
      : result.status === 'failed' || result.status === 'stalled'
        ? red(result.status === 'stalled' ? 'HUNG' : 'FAIL')
        : result.status === 'not-run' ? yellow('----') : yellow('skip');
    const note = result.status === 'skipped'
      ? dim(`  needs ${result.reason}`)
      : result.status === 'not-run'
        ? dim('  not run — fleet gate refused')
        : result.status === 'stalled' ? dim(`  aborted — ${result.reason}`) : '';
    stdout.write(`  ${mark}  ${result.lane.id.padEnd(width)}  ${formatDuration(result.durationMs).padStart(6)}${note}\n`);
  }

  if (failed.length > 0) {
    stdout.write(`\n${bold('Failures')}\n`);
    for (const result of failed) {
      stdout.write(`\n  ${red(result.lane.id)} — ${result.failedCommand}\n`);
      stdout.write(`  ${dim(`full log: ${result.logPath}`)}\n`);
    }
  }

  stdout.write(
    `\n${bold('Wall clock')}: ${formatDuration(wallMs)} ` +
      `(tier=${options.tier}, ${options.workers} workers/lane, ${options.lanesAtOnce} lane at a time, nice 19)\n`,
  );

  const incomplete = [...skipped, ...notRun];
  if (failed.length === 0 && incomplete.length === 0) {
    stdout.write(`${green(bold('VERDICT: PASS'))} — ${passed.length} lanes, nothing skipped.\n`);
    return 0;
  }
  if (failed.length === 0) {
    stdout.write(
      `${yellow(bold('VERDICT: INCOMPLETE'))} — ${passed.length} lanes passed, ` +
        `${incomplete.length} did not run (${incomplete.map((r) => r.lane.id).join(', ')}).\n`,
    );
    return 0;
  }
  stdout.write(
    `${red(bold('VERDICT: FAIL'))} — ${failed.length} of ${results.length} lanes failed: ` +
      `${failed.map((r) => r.lane.id).join(', ')}.` +
      (incomplete.length > 0 ? ` ${incomplete.length} did not run.` : '') + '\n',
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
  stdout.write(
    `${bold('Local verdict')} — ${lanes.length} lanes, ${options.workers} workers/lane, ` +
      `${options.lanesAtOnce} lane at a time, nice 19\n`,
  );
  const startedAt = Date.now();

  for (const note of ENVIRONMENT_NOTES) {
    if ((await runCommand(note.probe, { onChunk: () => {} })).code !== 0) {
      stdout.write(`  ${yellow('!')} ${note.note}\n`);
    }
  }

  for (const step of PREPARE) {
    const chunks = [];
    const { code } = await runCommand(step.command, { onChunk: (chunk) => chunks.push(chunk) });
    if (code !== 0) {
      const logPath = join(LOG_DIR, 'prepare.log');
      await writeFile(logPath, Buffer.concat(chunks));
      stdout.write(`${red('prepare failed')}: ${step.command}\n  ${dim(`full log: ${logPath}`)}\n`);
      return 2;
    }
    stdout.write(dim(`  prepared ${step.label}\n`));
  }

  const results = await runLanes(lanes, options);
  return report(results, Date.now() - startedAt, options);
}

main().then(exit, (error) => {
  stdout.write(`${red('verdict failed to start')}: ${error.message}\n`);
  exit(2);
});
