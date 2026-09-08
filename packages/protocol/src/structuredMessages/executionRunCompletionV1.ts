import { z } from 'zod';

export const ExecutionRunCompletionV1Schema = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
  finishedAtMs: z.number().int().nonnegative(),
  canInspect: z.boolean(),
  summary: z.string().max(8_000).optional(),
}).passthrough();

export type ExecutionRunCompletionV1 = z.infer<typeof ExecutionRunCompletionV1Schema>;

export function buildExecutionRunCompletionInputV1(value: ExecutionRunCompletionV1): Readonly<{
  text: string;
  meta: Record<string, unknown>;
}> {
  const completion = ExecutionRunCompletionV1Schema.parse(value);
  return {
    text: `<happier_execution_run_completion v="1">\n${JSON.stringify(completion)}\n</happier_execution_run_completion>`,
    meta: {
      source: 'execution_run',
      sentFrom: 'happier',
      happierStructuredInputV1: { v: 1, executionRunCompletion: completion },
    },
  };
}
