import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSetupChoicePrompt, renderNumericPlanet, renderSetupChoice, renderSetupWelcome } from './planet';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('setup welcome handoff', () => {
  it('keeps setup context without repeating installer artwork or the brand heading', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    expect(renderSetupWelcome({ machineName: 'preview-machine', subtitle: 'Choose your connection' }).split('\n')).toContain('Happier');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '1');
    const output = renderSetupWelcome({ machineName: 'preview-machine', subtitle: 'Choose your connection', columns: 80 });
    expect(output).toContain('preview-machine');
    expect(output).toContain('Choose your connection');
    expect(output.split('\n')).not.toContain('Happier');
    expect(output).not.toMatch(/[0-9.]{8}/u);
  });

  it('places the static planet beside the complete first setup choice on a wide terminal', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const output = renderSetupChoice({
      machineName: 'preview-machine',
      subtitle: 'Connect your devices. Your coding agents run here.',
      question: 'How would you like to connect your devices?',
      choices: [
        { key: 'c', label: 'Happier Cloud (recommended)', description: 'No server maintenance', isDefault: true },
        { key: 'r', label: 'Existing server', description: 'Address from the Happier app or your administrator' },
        { key: 't', label: 'Host on this computer', description: 'Installs an additional server; needs a reachable network route' },
      ],
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    const lines = output.split('\n');
    expect(lines.some((line) => /^[ 0-9.]{24} {3}Happier$/u.test(line))).toBe(true);
    expect(lines.some((line) => /^[ 0-9.]{24} {3}How would you like to connect your devices\?$/u.test(line))).toBe(true);
    expect(output).toContain('Existing server');
    expect(output).toContain('Happier app or your administrator');
    expect(output.trimEnd().endsWith('Use ↑/↓ to move, Enter to select, or type a letter')).toBe(true);
  });

  it('uses compact complete text without the planet on narrow terminals', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '');
    const options = {
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [{ key: 'a', label: 'A deliberately long option whose meaning must wrap instead of being cropped', isDefault: true }],
      columns: 44,
      rows: 24,
      isTTY: true,
    } as const;
    const narrow = renderSetupChoice(options);
    expect(narrow).toContain('Happier\nChoose your connection\nComputer: preview-machine');
    expect(narrow.replace(/\n\s*/gu, ' ')).toContain('A deliberately long option whose meaning must wrap instead of being cropped');
    expect(narrow).not.toMatch(/[0-9.]{8}/u);

    vi.stubEnv('HAPPIER_INSTALLER_WELCOME_SHOWN', '1');
    const handedOff = renderSetupChoice({ ...options, columns: 100 });
    expect(handedOff).not.toContain('Happier');
    expect(handedOff).toMatch(/[0-9.]{8}/u);
    expect(handedOff).toContain('Question');
    expect(handedOff).toContain('Computer: preview-machine');
  });

  it('offers idle frames only for a wide capable terminal', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    const base = {
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [{ key: 'a', label: 'Answer', isDefault: true }],
      columns: 92,
      rows: 24,
      isTTY: true,
    } as const;
    const animated = createSetupChoicePrompt(base);
    expect(animated.renderMessage?.(1)).not.toBe(animated.message);
    vi.stubEnv('HAPPIER_NO_ANIMATION', ' TRUE ');
    expect(createSetupChoicePrompt(base)).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    expect(createSetupChoicePrompt({ ...base, columns: 44 })).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
    expect(createSetupChoicePrompt({ ...base, isTTY: false }).renderMessage).toBeUndefined();
  });

  it('marks and highlights the currently selected choice independently of the recommendation', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    const output = renderSetupChoice({
      machineName: 'preview-machine',
      subtitle: 'Choose your connection',
      question: 'Question',
      choices: [
        { key: 'a', label: 'Recommended answer', isDefault: true },
        { key: 'b', label: 'Current answer' },
      ],
      selectedId: 'b',
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    expect(output).toContain('  a) Recommended answer');
    expect(output).toContain('› b) Current answer');
  });

  it('renders setup submenus without repeating welcome context or the planet', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', '1');
    const prompt = createSetupChoicePrompt({
      machineName: '',
      subtitle: '',
      showWelcome: false,
      question: 'Try again?',
      choices: [
        { id: 'retry', key: 'r', label: 'Retry', isDefault: true },
        { id: 'exit', key: 'x', label: 'Exit' },
      ],
      columns: 92,
      rows: 24,
      isTTY: true,
    });
    expect(prompt.message).toContain('Try again?\n› r) Retry\n  x) Exit');
    expect(prompt.message).not.toContain('Happier');
    expect(prompt.message).not.toContain('Computer:');
    expect(prompt.message).not.toMatch(/[0-9.]{8}/u);
    expect(prompt).toMatchObject({ animate: false, renderMessage: expect.any(Function) });
  });
});

describe('numeric planet', () => {
  it('grows and shrinks slowly inside a fixed-height, fixed-width ASCII canvas', () => {
    const first = renderNumericPlanet({ columns: 24, seconds: 0, color: false });
    const later = renderNumericPlanet({ columns: 24, seconds: 2, color: false });
    expect(later).not.toEqual(first);
    const occupiedCells = (frame: string[]) => frame.join('').replace(/\s/gu, '').length;
    expect(occupiedCells(later)).toBeGreaterThan(occupiedCells(first));
    expect(occupiedCells(renderNumericPlanet({ columns: 24, seconds: 6, color: false }))).toBeLessThan(occupiedCells(later));
    expect(later).toHaveLength(first.length);
    for (const frame of [first, later]) {
      expect(frame.join('\n')).toMatch(/^[0-9. \n]+$/u);
      expect(frame.every((line) => line.length <= 24)).toBe(true);
    }
  });
});
