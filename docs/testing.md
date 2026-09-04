# Testing

This document records the repository-level test lane map and placement conventions. For workflow details, use the repo skill `skills/happier-testing` and the development guide at `apps/docs/content/docs/development/testing.mdx`.

## Top-level lanes

Canonical lanes:

- `yarn test` — fast unit lane across apps.
- `yarn test:import-cycles` — CLI runtime import-cycle guard, also enforced by the CLI unit lane.
- `yarn test:integration` — orchestration-heavy app integration lane.
- `yarn test:e2e:core:fast` — default local core e2e loop.
- `yarn test:e2e:core:slow` — long orchestration core e2e.
- `yarn test:e2e:ui` — Playwright UI/browser e2e exercising real UI + server + CLI/daemon flows.
- `yarn test:providers` — provider contracts; opt-in/flag-driven.
- `yarn test:db-contract:docker` — server DB contract via Docker.

Use the smallest relevant subset during RED/GREEN loops. Before handoff, run the touched package typecheck/build-enforcing lane and at least one broader relevant lane when shared contracts are touched.

## Local verdict

`yarn verdict` runs the checks from `.github/workflows/tests.yml` natively against the working
tree and prints one pass/fail result. It is the answer to "is this tree good?" without waiting on
a hosted runner.

- `yarn verdict` — fast tier: typecheck, wiring/policy/inventory, and the unit and integration
  lanes for UI, server, CLI, stack, shared packages, and release contracts.
- `yarn verdict:slow` — opt-in tier: UI e2e, core e2e, CLI daemon e2e, and the Postgres DB
  contract. Separate because these boot a web app, build artifacts, or need a service or device.
- `yarn verdict:all`, `--lane=<id,...>`, `--list`, `--jobs=N` for narrower or wider runs.

Lanes run in parallel, packed by a per-lane core `weight` so lanes that already parallelise
internally do not oversubscribe the machine. Per-lane output lands in `.project/logs/verdict/`.

Two properties make the result trustworthy:

- The lane commands are copied from the workflow, and
  `scripts/ci/verdictLanes.contract.test.mjs` fails if one stops appearing there. The local run
  and CI cannot drift apart silently.
- A lane whose prerequisite is missing (Bun, Sapling, Playwright browsers, `DATABASE_URL`) is
  reported as `skip` and the run is `INCOMPLETE`, never `PASS`. A check that did not run is never
  counted as one that passed.

`yarn ci:act` is a different tool: it replays a GitHub Actions job inside Docker, which is for
debugging the workflow itself rather than for getting a verdict on your code.

## TypeScript toolchain

The repository deliberately separates the compiler from the programmatic TypeScript API:

- `@typescript/native` provides the TypeScript 7 compiler used by first-party typecheck and package-build lanes.
- `typescript` remains the TypeScript 5.9 API consumed by AST tooling and ecosystem integrations such as `prisma-json-types-generator`. Do not replace it with TypeScript 7 until the native release provides a stable compatible API and every consumer supports it.
- `scripts/workspaces/typescriptCommand.mjs` is the only compiler-selection owner. First-party scripts must use `runTypeScriptCli.mjs`, `buildTypeScriptPackageDist.mjs`, or that resolver directly; do not invoke a bare `tsc` shim or resolve `typescript/bin/tsc`.
- `yarn tsc ...` is an intentional convenience command at the repository root and in every TypeScript-owning workspace; it delegates to `runTypeScriptCli.mjs` and therefore uses TypeScript 7 rather than the package-manager bin shim.

The root `devDependencies` own both versions. Package manifests that run TypeScript lanes mirror those values, with parity enforced by the release tooling contract tests.

## Lane naming and placement

- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`.
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`.
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`.
- UI Playwright e2e: `packages/tests/suites/ui-e2e/**/*.spec.ts`.
- Provider/stress suites remain under `packages/tests/suites/providers` and `packages/tests/suites/stress`.

Treat `test` and `test:unit` as fast lanes. Put Dockerized dependencies, multiprocess setups, external services, real network calls, or other heavy orchestration into integration/e2e/provider lanes.

When introducing or moving a lane/pattern, update all relevant places in the same change:

1. package-level scripts/config,
2. root `package.json` lane scripts,
3. CI workflow wiring.

## UI e2e authoring

- Prefer stable React Native `testID` selectors, queried in Playwright with `getByTestId(...)`.
- Treat e2e `testID`s as API surface; update specs when renaming/removing them.
- Wait for controls to be enabled before clicking.
- Click the real submit/confirm affordance.
- Do not rely on settings-sensitive shortcuts such as Enter-to-send unless the test explicitly configures that setting.
- UI e2e artifacts live under `packages/tests/.project/logs/e2e/ui-playwright/`.
- UI e2e runtime process logs live under `.project/logs/e2e/*ui-e2e*/`.

## Guardrails

- No `.skip`, `.todo`, `.only`, or hidden conditional skips in committed tests unless an explicit opt-in external probe documents the gate.
- No debugging logs in tests.
- No duplicate test intent.
- Evidence must come from trusted runners, not fabricated/manual output.
- Prefer contract-focused assertions over copy/formatting assertions.
