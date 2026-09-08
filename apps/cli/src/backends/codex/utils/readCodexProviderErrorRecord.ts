type ReadCodexProviderErrorRecordOptions = Readonly<{
  allowRoot?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrapProviderError(record: Record<string, unknown>): Record<string, unknown> {
  let current = record;
  const seen = new Set<Record<string, unknown>>();
  while (!seen.has(current)) {
    seen.add(current);
    const nested = isRecord(current.error) ? current.error : null;
    if (!nested) break;
    current = nested;
  }
  return current;
}

/**
 * Reads both direct provider failures and app-server `turn/completed` error
 * envelopes, then unwraps transport-level `{ error: ... }` containers.
 */
export function readCodexProviderErrorRecord(
  value: unknown,
  options: ReadCodexProviderErrorRecordOptions = {},
): Record<string, unknown> | null {
  const root = isRecord(value) ? value : null;
  if (!root) return null;
  const direct = isRecord(root.error) ? root.error : null;
  const turn = isRecord(root.turn) ? root.turn : null;
  const turnError = isRecord(turn?.error) ? turn.error : null;
  const candidate = direct ?? turnError ?? (options.allowRoot === false ? null : root);
  return candidate ? unwrapProviderError(candidate) : null;
}
