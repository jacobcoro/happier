import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LANES } from './verdictLanes.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

// The local verdict is only trustworthy if it runs what CI runs. These assertions fail when
// the workflow changes a command without the lane table following it, which is the failure
// mode that would otherwise make a local pass quietly mean less than it appears to.

test('every verdict lane command still appears in the tests workflow', () => {
  for (const lane of LANES) {
    for (const command of lane.commands) {
      // A lane may chain commands the workflow runs in one step; check each separately.
      for (const part of command.split('&&').map((piece) => piece.trim())) {
        assert.ok(
          workflow.includes(part),
          `lane ${lane.id} runs "${part}", which no longer appears in .github/workflows/tests.yml`,
        );
      }
    }
  }
});

test('every verdict lane names a job that exists in the tests workflow', () => {
  for (const lane of LANES) {
    assert.match(
      workflow,
      new RegExp(`^  ${lane.job}:$`, 'm'),
      `lane ${lane.id} claims job "${lane.job}", which is not a job in .github/workflows/tests.yml`,
    );
  }
});

test('verdict lane ids are unique', () => {
  const ids = LANES.map((lane) => lane.id);
  assert.deepEqual([...new Set(ids)], ids, 'duplicate lane id');
});

test('a lane that needs a prerequisite can detect whether it has one', () => {
  for (const lane of LANES) {
    if (!lane.requires) continue;
    assert.ok(
      lane.probe,
      `lane ${lane.id} documents a prerequisite but has no probe, so it would fail rather than skip`,
    );
  }
});
