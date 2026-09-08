import { describe, expect, it, vi } from 'vitest';

import { promptMultipleChoice } from './promptMultipleChoice';
import type { promptInput } from './promptInput';

describe('promptMultipleChoice arrow navigation', () => {
  const options = [
    { id: 'first', keys: ['a', 'first', ''], short: 'a' },
    { id: 'second', keys: ['b', 'second'], short: 'b' },
    { id: 'third', keys: ['c', 'third'], short: 'c' },
  ] as const;

  it('wraps arrow selection and maps empty Enter to the highlighted option', async () => {
    const renderMessage = vi.fn((_seconds: number, selectedId?: string) => `selected=${selectedId ?? 'none'}`);
    const promptInputFn = vi.fn(async (_prompt: string, config?: Parameters<typeof promptInput>[1]) => {
      config?.animation?.onMove?.(-1);
      expect(config?.animation?.render(1)).toContain('selected=third');
      return config?.animation?.answerOnEmpty?.() ?? '';
    });

    await expect(promptMultipleChoice('menu', options, {
      defaultId: 'first',
      promptInputFn,
      renderMessage,
    })).resolves.toBe('third');
  });

  it('keeps explicit letter aliases authoritative and resets navigation after an invalid attempt', async () => {
    let attempt = 0;
    const promptInputFn = vi.fn(async (_prompt: string, config?: Parameters<typeof promptInput>[1]) => {
      attempt += 1;
      if (attempt === 1) {
        config?.animation?.onMove?.(1);
        return 'invalid';
      }
      expect(config?.animation?.answerOnEmpty?.()).toBe('a');
      return 'c';
    });

    await expect(promptMultipleChoice('menu', options, {
      defaultId: 'first',
      maxAttempts: 2,
      promptInputFn,
      renderMessage: (_seconds, selectedId) => `selected=${selectedId}`,
    })).resolves.toBe('third');
  });
});
