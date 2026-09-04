// The lanes a local verdict runs, mirroring the jobs in .github/workflows/tests.yml.
//
// Each `commands` entry is copied from that workflow so a local run exercises the same
// checks rather than a separately invented set. verdictLanes.contract.test.mjs fails if a
// command here stops appearing in the workflow, so the two cannot drift apart silently.
//
// `tier` decides what a bare `yarn verdict` runs:
//   fast — native, hermetic, and worth blocking on. This is the default verdict.
//   slow — real but expensive or environment-dependent; opt in with `yarn verdict:slow`.
//
// `weight` is the approximate number of cores a lane saturates on its own. The scheduler
// packs lanes up to the core count so lanes that already parallelise internally (vitest,
// node --test) do not oversubscribe the machine and end up slower than running in series.
//
// `expectSeconds` is a measured rough duration, used only to start the slowest lane first.
// It does not need to be accurate; being wrong costs ordering, never correctness.
//
// `probe` is a command that must succeed for the lane to be runnable. A lane whose probe
// fails is reported as SKIPPED with its reason and makes the run incomplete; it is never
// counted as a pass, because a check that did not run has not told you anything.

/**
 * @typedef {{
 *   id: string, job: string, tier: 'fast' | 'slow', weight: number, expectSeconds: number,
 *   commands: string[], requires?: string, probe?: string,
 * }} Lane
 */

/** @type {Lane[]} */
export const LANES = [
  {
    id: 'typecheck',
    job: 'typecheck',
    tier: 'fast',
    weight: 8,
    expectSeconds: 230,
    commands: [
      'yarn test:wiring:self && yarn test:policy:self',
      'yarn test:wiring',
      'yarn test:inventory && yarn test:migration:inventory',
      'yarn typecheck',
    ],
  },
  {
    id: 'shared-packages',
    job: 'shared-packages-unit',
    tier: 'fast',
    weight: 6,
    expectSeconds: 210,
    commands: [
      'yarn workspace privacy-kit test',
      'yarn workspace @happier-dev/transfers test',
      'yarn workspace @happier-dev/agents test',
      'yarn workspace @happier-dev/cli-common test',
      'yarn workspace @happier-dev/connection-supervisor test',
      'yarn workspace @happier-dev/bootstrap test',
      'yarn --cwd packages/relay-server test',
    ],
  },
  {
    // Split out from shared-packages because it is the one lane there needing a runtime
    // this machine may not have. Keeping it separate means a missing Bun skips one lane
    // instead of silently dropping a check or failing six unrelated ones.
    id: 'privacy-kit-bun',
    job: 'shared-packages-unit',
    tier: 'fast',
    weight: 2,
    expectSeconds: 10,
    requires: 'Bun on PATH',
    probe: 'bun --version',
    commands: ['yarn workspace privacy-kit test:runtime:bun'],
  },
  {
    id: 'ui',
    job: 'ui',
    tier: 'fast',
    weight: 8,
    expectSeconds: 80,
    commands: [
      'yarn workspace @happier-dev/protocol test',
      'yarn workspace @happier-dev/app test:unit',
      'yarn workspace @happier-dev/app test:integration',
    ],
  },
  {
    id: 'server',
    job: 'server',
    tier: 'fast',
    weight: 6,
    expectSeconds: 215,
    commands: [
      'yarn --cwd apps/server test:unit',
      'yarn --cwd apps/server test:integration',
    ],
  },
  {
    id: 'cli',
    job: 'cli',
    tier: 'fast',
    weight: 6,
    expectSeconds: 215,
    commands: [
      'yarn workspace @happier-dev/cli test:unit',
      'yarn workspace @happier-dev/cli test:integration',
    ],
  },
  {
    id: 'stack',
    job: 'stack',
    tier: 'fast',
    weight: 2,
    expectSeconds: 1300,
    commands: [
      'yarn --cwd apps/stack test:unit',
      'yarn --cwd apps/stack test:integration',
    ],
  },
  {
    id: 'release-contracts',
    job: 'release-contracts',
    tier: 'fast',
    weight: 2,
    expectSeconds: 430,
    commands: [
      'yarn -s test:release:contracts',
      'node scripts/pipeline/run.mjs release-sync-installers --check',
    ],
  },

  // Slow tier. These are real checks, not skipped ones. They are separated because they
  // boot a web app, build artifacts, or need a service or device this machine may not have.
  {
    id: 'ui-e2e',
    job: 'ui-e2e',
    tier: 'slow',
    weight: 24,
    expectSeconds: 5400,
    requires: 'Playwright browsers (yarn playwright install chromium)',
    probe: 'test -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"',
    commands: ['yarn -s test:e2e:ui'],
  },
  {
    id: 'e2e-core',
    job: 'e2e-core',
    tier: 'slow',
    weight: 8,
    expectSeconds: 900,
    requires: 'Sapling (sl) on PATH',
    probe: 'sl --version',
    commands: ['yarn test:e2e:core:fast'],
  },
  {
    id: 'cli-daemon-e2e',
    job: 'cli-daemon-e2e',
    tier: 'slow',
    weight: 4,
    expectSeconds: 600,
    // No external prerequisite: the lane builds the CLI and mints its own test credentials.
    // It is slow-tier because of that build cost, not because the machine might lack something.
    commands: [
      'yarn workspace @happier-dev/cli build',
      'node scripts/pipeline/run.mjs testing-create-auth-credentials',
      'yarn --cwd apps/cli -s vitest run --config vitest.integration.config.ts src/daemon/daemon.integration.test.ts',
    ],
  },
  {
    id: 'server-db-contract',
    job: 'server-db-contract',
    tier: 'slow',
    weight: 2,
    expectSeconds: 300,
    requires: 'a Postgres instance on DATABASE_URL',
    probe: 'test -n "$DATABASE_URL"',
    commands: ['yarn --cwd apps/server test:server:db-contract'],
  },
];

// Run before any lane, in order. A hosted runner gets this from installing into a clean
// checkout; a long-lived working tree does not, and a stale Prisma client makes typecheck and
// the server lane report hundreds of failures that say nothing about the code. Generating is
// a few seconds and idempotent, so paying it every run is cheaper than misreading a verdict.
// Toolchains that some tests inside an otherwise runnable lane shell out to. Missing one does
// not skip the lane, because that would drop thousands of good tests to protect a handful.
// It is surfaced up front so a toolchain gap does not get misread as a code failure: on a box
// without Rust, the stack lane reports eight Tauri failures that are green on a CI runner.
export const ENVIRONMENT_NOTES = [
  { probe: 'command -v cargo', note: 'cargo (Rust) missing — 8 Tauri tests in the stack lane will fail' },
];

export const PREPARE = [
  { label: 'prisma client', command: 'yarn --cwd apps/server -s generate' },
];

/** @param {'fast' | 'slow' | 'all'} tier */
export function lanesForTier(tier) {
  if (tier === 'all') return LANES;
  return LANES.filter((lane) => lane.tier === tier);
}
