import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

// The floors below are the observed minimum a job needs on a GitHub-hosted runner. Assert
// `>=` rather than equality: pinning the exact value makes a legitimate raise fail this
// contract, which is how the UI E2E job stayed at a timeout four of its shards could not
// finish within. A drop below the floor still fails, which is what the contract is for.
function assertTimeoutFloor(job, jobLabel, floorMinutes, why) {
  const match = job.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(match, `expected ${jobLabel} to declare timeout-minutes`);
  const actual = Number(match[1]);
  assert.ok(
    actual >= floorMinutes,
    `${why} (${jobLabel} declares timeout-minutes: ${actual}, floor is ${floorMinutes})`,
  );
}

function extractJobBlock(raw, jobName) {
  const match = raw.match(new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9-]+:|\\n$)`));
  assert.ok(match, `expected to find job block for ${jobName}`);
  return match[1];
}

test('tests workflow keeps slow CI jobs above the observed timeout floor', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');
  const uiJob = extractJobBlock(raw, 'ui');
  const serverJob = extractJobBlock(raw, 'server');
  const cliJob = extractJobBlock(raw, 'cli');
  const stackJob = extractJobBlock(raw, 'stack');
  const installerSmokeWindowsJob = extractJobBlock(raw, 'installers-smoke-windows');

  assert.match(uiE2eJob, /name:\s*UI E2E \(Playwright\)/);
  assertTimeoutFloor(
    uiE2eJob,
    'UI E2E',
    75,
    'UI E2E job should reserve enough time to finish the slow multi-session Playwright scenarios on GitHub-hosted runners',
  );
  // 18 shards keeps the slowest observed shard near 50 minutes; 9 shards did not fit the ceiling.
  assert.match(uiE2eJob, /shard:\s*\[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18\]/);
  assert.match(uiE2eJob, /--shard=\$\{\{ matrix\.shard \}\}\/18/);

  assert.match(uiJob, /name:\s*UI Tests \(unit \+ integration\)/);
  assertTimeoutFloor(uiJob, 'UI Tests', 240, 'UI Tests should reserve enough time for all 24 sequential heap-bounded shards');

  assert.match(serverJob, /name:\s*Server Tests \(unit \+ integration\)/);
  assertTimeoutFloor(serverJob, 'Server Tests', 45, 'Server Tests should reserve enough time for dependency installation plus unit and integration suites');

  assert.match(cliJob, /name:\s*CLI Tests \(unit \+ integration\)/);
  assertTimeoutFloor(cliJob, 'CLI Tests', 60, 'CLI Tests should reserve enough time for bounded unit and integration shards');

  assert.match(stackJob, /name:\s*Stack Tests \(unit \+ integration\)/);
  assertTimeoutFloor(stackJob, 'Stack Tests', 45, 'Stack Tests should reserve enough time for dependency installation plus unit and integration suites');

  assert.match(installerSmokeWindowsJob, /name:\s*Installer Smoke \(Windows\)/);
  assertTimeoutFloor(installerSmokeWindowsJob, 'Installer Smoke (Windows)', 45, 'Windows installer smoke should reserve enough time to finish published-channel validation on GitHub-hosted runners');
});

test('UI tests collect protocol, unit, and integration outcomes before failing the job', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiJob = extractJobBlock(raw, 'ui');

  for (const id of ['protocol-tests', 'unit-tests', 'integration-tests']) {
    assert.match(uiJob, new RegExp(`id:\\s*${id}[\\s\\S]*?continue-on-error:\\s*true`));
  }
  assert.match(uiJob, /name:\s*Require all UI test lanes[\s\S]*?if:\s*always\(\)/);
  assert.match(uiJob, /steps\.protocol-tests\.outcome/);
  assert.match(uiJob, /steps\.unit-tests\.outcome/);
  assert.match(uiJob, /steps\.integration-tests\.outcome/);
});

test('combined package jobs collect unit and integration outcomes before failing', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  for (const jobName of ['server', 'cli', 'stack']) {
    const job = extractJobBlock(raw, jobName);
    for (const id of ['unit-tests', 'integration-tests']) {
      assert.match(job, new RegExp(`id:\\s*${id}[\\s\\S]*?continue-on-error:\\s*true`));
    }
    assert.match(job, new RegExp(`name:\\s*Require all ${jobName} test lanes[\\s\\S]*?if:\\s*always\\(\\)`));
    assert.match(job, /steps\.unit-tests\.outcome/);
    assert.match(job, /steps\.integration-tests\.outcome/);
  }
});

test('typecheck enforces clean governance checks without running the known-red migration report', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const typecheckJob = extractJobBlock(raw, 'typecheck');

  assert.match(typecheckJob, /\byarn test:wiring:self\b/);
  assert.match(typecheckJob, /\byarn test:policy:self\b/);
  assert.match(typecheckJob, /\byarn test:wiring\b/);
  assert.doesNotMatch(typecheckJob, /\byarn test:policy(?:\s|$|&&)/);
});
