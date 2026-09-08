import { describe, expect, it } from 'vitest';

import { buildExecutionRunCompletionInputV1 } from './executionRunCompletionV1.js';

describe('buildExecutionRunCompletionInputV1', () => {
  it('renders the same versioned completion into provider text and structured input metadata', () => {
    const input = buildExecutionRunCompletionInputV1({
      v: 1,
      runId: 'run_1',
      status: 'succeeded',
      finishedAtMs: 42,
      canInspect: true,
      summary: 'Done',
    });

    expect(input.text).toContain('"runId":"run_1"');
    expect((input.meta.happierStructuredInputV1 as Record<string, unknown>).executionRunCompletion)
      .toEqual({ v: 1, runId: 'run_1', status: 'succeeded', finishedAtMs: 42, canInspect: true, summary: 'Done' });
  });
});
