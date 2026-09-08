import { describe, expect, it } from 'vitest';

import { appendBrowserDiagnostics } from './browserDiagnostics';

describe('appendBrowserDiagnostics', () => {
  it('preserves the original error and callsite while appending diagnostics', () => {
    const original = new Error('upload did not finish');
    const originalStack = original.stack;

    const decorated = appendBrowserDiagnostics(original, '# Browser diagnostics\n\nrequest failed');

    expect(decorated).toBe(original);
    expect(decorated.message).toContain('upload did not finish');
    expect(decorated.message).toContain('# Browser diagnostics');
    expect(decorated.stack).toContain(originalStack);
    expect(decorated.stack).toContain('request failed');
  });

  it('turns non-Error failures into an Error with diagnostics', () => {
    const decorated = appendBrowserDiagnostics('upload failed', '# Browser diagnostics');

    expect(decorated).toBeInstanceOf(Error);
    expect(decorated.message).toBe('upload failed\n\n# Browser diagnostics');
  });
});
