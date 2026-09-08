import { promptInput } from './promptInput';

/**
 * Multi-choice prompt that supports arrow navigation on a capable terminal and
 * keeps single-letter/full-word aliases everywhere. Empty line input picks the
 * default; Enter after arrow navigation picks the highlighted option.
 *
 * Letter aliases remain case-insensitive and are the static/non-TTY fallback.
 */
export type MultipleChoiceOption<TId extends string> = Readonly<{
  /** The id returned when this option is chosen. */
  id: TId;
  /**
   * The single-letter key (or multi-char word) the user types. Multiple
   * accepted aliases allowed — e.g. `['y', 'yes']`. Case-insensitive.
   */
  keys: readonly string[];
  /** Short label used in the `[Y/n/r/p]` suffix. Usually a single uppercase letter when default, lowercase otherwise. */
  short: string;
}>;

export async function promptMultipleChoice<TId extends string>(
  message: string,
  options: readonly MultipleChoiceOption<TId>[],
  config: Readonly<{
    defaultId: TId;
    maxAttempts?: number;
    promptInputFn?: typeof promptInput;
    animate?: boolean;
    renderMessage?: (elapsedSeconds: number, selectedId?: TId) => string;
  }>,
): Promise<TId> {
  const readAnswer = config.promptInputFn ?? promptInput;
  if (options.length === 0) {
    throw new Error('promptMultipleChoice requires at least one option');
  }
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const suffix = `[${options.map((o) => (o.id === config.defaultId ? o.short.toUpperCase() : o.short.toLowerCase())).join('/')}] `;
  const fullPrompt = `${message.trimEnd()} ${suffix}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let selectedIndex = Math.max(0, options.findIndex((option) => option.id === config.defaultId));
    const answer = config.renderMessage
      ? await readAnswer(fullPrompt, {
          animation: {
            animate: config.animate,
            render: (seconds) => `${config.renderMessage!(seconds, options[selectedIndex]!.id).trimEnd()} ${suffix}`,
            onMove: (delta) => { selectedIndex = (selectedIndex + delta + options.length) % options.length; },
            answerOnEmpty: () => options[selectedIndex]!.keys.find((key) => key.length > 0) ?? options[selectedIndex]!.short,
          },
        })
      : await readAnswer(fullPrompt);
    const raw = answer.trim().toLowerCase();
    if (raw === '') return config.defaultId;
    const match = options.find((o) => o.keys.some((k) => k.toLowerCase() === raw));
    if (match) return match.id;
    // unrecognised — re-prompt
  }
  return config.defaultId;
}
