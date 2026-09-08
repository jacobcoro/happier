import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';

export function isTerminalAnimationDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.HAPPIER_NO_ANIMATION ?? '').trim().toLowerCase());
}

/** Numeric brand texture only; no identifiers, credentials or progress data. */
export function renderNumericPlanet(options: Readonly<{
  columns?: number;
  seconds?: number;
  chalkLike?: typeof chalk;
  color?: boolean;
}> = {}): string[] {
  const width = Math.min(30, Math.max(8, Math.floor(options.columns ?? 30)));
  const height = Math.ceil(width / 2.4);
  const colors = options.chalkLike ?? chalk;
  const time = options.seconds ?? 0;
  // Quicker inhale, brief hold, longer exhale, then rest: the voice orb's
  // motion language, without coupling terminal activity to microphone state.
  const phase = (time % 6.4) / 6.4;
  const breath = phase < 0.34 ? 1 - (1 - phase / 0.34) ** 2
    : phase < 0.42 ? 1
      : phase < 0.9 ? (1 + Math.cos(Math.PI * (phase - 0.42) / 0.48)) / 2 : 0;
  // Breathe inside the existing canvas: only the planet's radius changes,
  // never the number of rows or the position of the adjacent text/input.
  const radius = 0.88 + breath * 0.12;
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    let line = '';
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5 - width / 2) / (width / 2 * radius);
      const y = (row + 0.5 - height / 2) / (height / 2 * radius);
      const depthSquared = 1 - x * x - y * y;
      if (depthSquared <= 0) { line += ' '; continue; }
      // Mix spatial coordinates so the texture feels like scattered digits,
      // rather than repeating diagonal runs across the entire planet.
      const cell = Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263);
      const seed = (Math.imul(cell ^ (cell >>> 13), 1274126177) >>> 0);
      // Only a few digits change in each sweep; the text layout remains fixed.
      const sweep = Math.floor(time * 2);
      const digit = String((seed + Math.floor((sweep + seed % 19) / 19)) % 10);
      const light = Math.max(0.65, Math.min(1, 0.68 + Math.sqrt(depthSquared) * 0.16 - y * 0.14 + x * 0.1 + breath * 0.1));
      const latitude = (y + 1) / 2;
      // Gold → coral → violet → blue, with a softly lit spherical surface.
      const rgb = latitude < 0.5
        ? [255 - latitude * 150, 220 - latitude * 270, 70 + latitude * 340]
        : [180 - (latitude - 0.5) * 110, 85 + (latitude - 0.5) * 190, 240];
      if (options.color === false || colors.level === 0) {
        line += light < 0.72 && seed % 3 === 0 ? '.' : digit;
      } else {
        line += colors.rgb(Math.round(rgb[0]! * light), Math.round(rgb[1]! * light), Math.round(rgb[2]! * light))(digit);
      }
    }
    rows.push(line.trimEnd());
  }
  return rows;
}

export function renderSetupWelcome(options: Readonly<{
  machineName: string;
  subtitle: string;
  columns?: number;
}>): string {
  // The bootstrapper already introduced Happier. Keep this operation's context,
  // but do not restart the visual welcome when it hands over to guided setup.
  if (process.env.HAPPIER_INSTALLER_WELCOME_SHOWN === '1') {
    return ['', options.subtitle, `Computer: ${options.machineName}`, ''].join('\n');
  }
  const rich = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
  const width = options.columns ?? process.stdout.columns ?? 80;
  const lines = rich && width >= 40 && (process.stdout.rows ?? 24) >= 18
    ? renderNumericPlanet({ color: !process.env.NO_COLOR })
    : [];
  return [...lines, '', 'Happier', options.subtitle, `Computer: ${options.machineName}`, ''].join('\n');
}

export type SetupChoice = Readonly<{
  id?: string;
  key: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}>;

export type SetupChoiceRenderOptions = Readonly<{
  machineName: string;
  subtitle: string;
  question: string;
  description?: string;
  choices: readonly SetupChoice[];
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  seconds?: number;
  selectedId?: string;
  showWelcome?: boolean;
}>;

export type SetupChoicePrompt = Readonly<{
  message: string;
  animate?: boolean;
  renderMessage?: (elapsedSeconds: number, selectedId?: string) => string;
}>;

const SETUP_PLANET_WIDTH = 24;
const SETUP_PLANET_GAP = 3;
const SETUP_MIN_RIGHT_WIDTH = 42;

function wrapSetupText(value: string, width: number, indent = ''): string[] {
  const available = Math.max(12, width - indent.length);
  const words = value.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [indent];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > available) {
      lines.push(`${indent}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(`${indent}${line}`);
  return lines;
}

function renderSetupChoiceText(options: SetupChoiceRenderOptions, width: number, showBrand: boolean, color: boolean): string[] {
  const gold = (value: string): string => color ? chalk.hex('#d6a24a')(value) : value;
  const secondary = (value: string): string => color ? chalk.gray(value) : value;
  const title = (value: string): string => color ? chalk.bold(value) : value;
  const lines: string[] = [];
  if (options.showWelcome !== false) {
    if (showBrand) lines.push(title('Happier'));
    lines.push(...wrapSetupText(options.subtitle, width).map(secondary));
    lines.push(...wrapSetupText(`Computer: ${options.machineName}`, width).map(secondary), '');
  }
  lines.push(...wrapSetupText(options.question, width).map((line) => gold(title(line))));
  if (options.description) lines.push(...wrapSetupText(options.description, width).map(secondary));
  const selectedId = options.selectedId ?? options.choices.find((choice) => choice.isDefault)?.id ?? options.choices.find((choice) => choice.isDefault)?.key;
  for (const choice of options.choices) {
    const selected = (choice.id ?? choice.key) === selectedId;
    const prefix = `${selected ? '›' : ' '} ${choice.key}) `;
    const labelLines = wrapSetupText(choice.label, width, ' '.repeat(prefix.length));
    const firstLabel = labelLines[0]!.slice(prefix.length);
    lines.push(selected
      ? gold(title(`${prefix}${firstLabel}`))
      : `${gold(`  ${choice.key})`)} ${firstLabel}`);
    for (const continuation of labelLines.slice(1)) {
      lines.push(selected ? gold(title(continuation)) : continuation);
    }
    if (choice.description) {
      lines.push(...wrapSetupText(choice.description, width, ' '.repeat(prefix.length)).map(secondary));
    }
  }
  return lines;
}

function canRenderSetupChoiceRich(options: SetupChoiceRenderOptions, width: number, rows: number, isTTY: boolean, showBrand: boolean): boolean {
  if (!isTTY || process.env.TERM === 'dumb' || width < SETUP_PLANET_WIDTH + SETUP_PLANET_GAP + SETUP_MIN_RIGHT_WIDTH) {
    return false;
  }
  const rightWidth = width - SETUP_PLANET_WIDTH - SETUP_PLANET_GAP;
  const rightLineCount = renderSetupChoiceText(options, rightWidth, showBrand, false).length;
  const planetLineCount = Math.ceil(SETUP_PLANET_WIDTH / 2.4);
  return Math.max(rightLineCount, planetLineCount) + 2 < rows;
}

/**
 * Render the welcome and setup's actual first choice as one bounded block.
 * The answer remains a normal line prompt below it; this function owns no input
 * or cursor state and is safe to use as a stable animation frame.
 */
export function renderSetupChoice(options: SetupChoiceRenderOptions): string {
  const width = Math.max(20, Math.floor(options.columns ?? process.stdout.columns ?? 80));
  const rows = options.rows ?? process.stdout.rows ?? 24;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const showBrand = process.env.HAPPIER_INSTALLER_WELCOME_SHOWN !== '1';
  const color = isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR && chalk.level > 0;
  const rich = options.showWelcome !== false && canRenderSetupChoiceRich(options, width, rows, isTTY, showBrand);
  if (!rich) {
    const prompt = isTTY && process.env.TERM !== 'dumb'
      ? 'Use ↑/↓ to move, Enter to select, or type a letter'
      : 'Choose';
    return [...renderSetupChoiceText(options, width, showBrand, color), '', prompt].join('\n');
  }

  const rightWidth = width - SETUP_PLANET_WIDTH - SETUP_PLANET_GAP;
  const right = renderSetupChoiceText(options, rightWidth, showBrand, color);
  const planet = renderNumericPlanet({
    columns: SETUP_PLANET_WIDTH,
    seconds: options.seconds ?? 0,
    color: !process.env.NO_COLOR,
  });
  const lines: string[] = [];
  for (let index = 0; index < Math.max(planet.length, right.length); index += 1) {
    const left = planet[index] ?? '';
    const content = right[index] ?? '';
    const paddedLeft = `${left}${' '.repeat(Math.max(0, SETUP_PLANET_WIDTH - stripVTControlCharacters(left).length))}`;
    lines.push(content ? `${paddedLeft}${' '.repeat(SETUP_PLANET_GAP)}${content}` : left);
  }
  return [...lines, '', 'Use ↑/↓ to move, Enter to select, or type a letter'].join('\n');
}

export function createSetupChoicePrompt(options: SetupChoiceRenderOptions): SetupChoicePrompt {
  const message = renderSetupChoice(options);
  const width = Math.max(20, Math.floor(options.columns ?? process.stdout.columns ?? 80));
  const rows = options.rows ?? process.stdout.rows ?? 24;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const showBrand = process.env.HAPPIER_INSTALLER_WELCOME_SHOWN !== '1';
  const rich = options.showWelcome !== false && canRenderSetupChoiceRich(options, width, rows, isTTY, showBrand);
  const canNavigate = isTTY && process.env.TERM !== 'dumb';
  const canAnimate = !isTerminalAnimationDisabled() && rich;
  return canNavigate
    ? {
        message,
        animate: canAnimate,
        renderMessage: (elapsedSeconds, selectedId) => renderSetupChoice({ ...options, seconds: elapsedSeconds, selectedId }),
      }
    : { message };
}
