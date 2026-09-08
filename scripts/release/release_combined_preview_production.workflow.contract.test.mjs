import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function workflow(name) {
  return parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'));
}

test('combined preview and production release reuses the canonical channel workflow concurrently', async () => {
  const [release, combined] = await Promise.all([
    workflow('release.yml'),
    workflow('release-preview-and-production.yml'),
  ]);

  assert.ok(release.on.workflow_call, 'the canonical channel workflow must be reusable');
  assert.equal(release.on.workflow_call.inputs.combined_preview_production.default, false);
  assert.equal(release.concurrency.group, 'release-unified-${{ inputs.environment }}');
  assert.equal(release.concurrency['cancel-in-progress'], false);

  const preview = combined.jobs.release_preview;
  const production = combined.jobs.release_production;
  assert.equal(preview.uses, './.github/workflows/release.yml');
  assert.equal(production.uses, './.github/workflows/release.yml');
  assert.equal(preview.needs, 'snapshot_release_issues');
  assert.equal(production.needs, 'snapshot_release_issues');
  assert.notEqual(preview.needs, 'release_production', 'preview must not wait for the production channel');
  assert.notEqual(production.needs, 'release_preview', 'production must not wait for the preview channel');
  assert.equal(preview.with.environment, 'preview');
  assert.equal(preview.with.confirm, 'release dev to preview');
  assert.equal(production.with.environment, 'production');
  assert.equal(production.with.confirm, 'release dev to main');
  assert.equal(preview.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(production.with.authorized_promotion_source_sha, '${{ inputs.authorized_promotion_source_sha }}');
  assert.equal(preview.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(production.with.ci_run_id, '${{ inputs.ci_run_id }}');
  assert.equal(preview.with.combined_preview_production, true);
  assert.equal(production.with.combined_preview_production, true);

  const advance = combined.jobs.advance_release_issues;
  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_preview', 'release_production']);
  assert.match(String(advance.if), /needs\.release_preview\.result == 'success'/u);
  assert.match(String(advance.if), /needs\.release_production\.result == 'success'/u);
  const reconcile = advance.steps.find((step) => step.name === 'Advance the initially eligible issues directly to stable')?.run ?? '';
  assert.match(reconcile, /--from-stage "stage:source"[\s\S]*--to-stage "stage:stable"/u);
  assert.match(reconcile, /--from-stage "stage:dev"[\s\S]*--to-stage "stage:stable"/u);

  for (const forbiddenJob of ['plan', 'publish_cli_binaries', 'publish_server_runtime', 'deploy_ui']) {
    assert.equal(combined.jobs[forbiddenJob], undefined, `combined workflow must not copy the canonical ${forbiddenJob} job`);
  }
});
