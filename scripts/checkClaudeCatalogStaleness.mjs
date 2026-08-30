#!/usr/bin/env node
/**
 * checkClaudeCatalogStaleness.mjs
 *
 * Compares Happier's curated Claude model catalog against the model IDs the locally installed
 * Claude Code CLI binary knows about, reporting any IDs the CLI knows that Happier does not
 * catalog yet.
 *
 * This is a developer/CI maintenance tool — it does NOT make network calls and does NOT
 * require Claude to be authenticated. It works by extracting strings from the compiled binary.
 *
 * Usage:
 *   node scripts/checkClaudeCatalogStaleness.mjs [--claude-bin <path>] [--warn-only]
 *
 * Options:
 *   --claude-bin <path>  Path to the Claude Code CLI binary. Auto-discovered from PATH and
 *                        common NVM/system install locations if omitted.
 *   --warn-only          Exit 0 even when uncataloged models are found (print warning only).
 *
 * See docs/agents-catalog.md — "Keeping the Claude catalog current" section.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let claudeBinOverride = null;
let warnOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--claude-bin' && args[i + 1]) { claudeBinOverride = args[++i]; }
  if (args[i] === '--warn-only') { warnOnly = true; }
}

// ---------------------------------------------------------------------------
// Resolve the Claude Code CLI binary
// ---------------------------------------------------------------------------
function discoverClaudeBin() {
  if (claudeBinOverride) return claudeBinOverride;

  // 1. Check PATH
  try {
    const fromPath = execSync('command -v claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (fromPath && existsSync(fromPath)) return fromPath;
  } catch { /* ignore */ }

  // 2. Common NVM install location (Linux/macOS)
  const nvmDir = process.env.NVM_DIR ?? resolve(process.env.HOME ?? '/root', '.nvm');
  if (existsSync(nvmDir)) {
    try {
      const found = execSync(
        `find "${nvmDir}/versions/node" -maxdepth 5 -name "claude-code-linux-x64" -type d 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim();
      if (found) {
        const bin = resolve(found, 'claude');
        if (existsSync(bin)) return bin;
      }
    } catch { /* ignore */ }
  }

  // 3. Happier-managed runtime
  const happierRuntime = resolve(process.env.HOME ?? '/root', '.local/share/happier-hermes');
  if (existsSync(happierRuntime)) {
    try {
      const found = execSync(
        `find "${happierRuntime}" -maxdepth 7 -name "claude-agent-sdk-linux-x64" -type d 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim();
      if (found) {
        const bin = resolve(found, 'claude');
        if (existsSync(bin)) return bin;
      }
    } catch { /* ignore */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extract model IDs from binary using `strings`
// ---------------------------------------------------------------------------
const CANONICAL_MODEL_PATTERN = /^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d+)?$/;

function extractCliModelIds(binaryPath) {
  try {
    const output = execSync(`strings "${binaryPath}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ids = new Set();
    for (const line of output.split('\n')) {
      const s = line.trim();
      if (CANONICAL_MODEL_PATTERN.test(s)) {
        ids.add(s);
      }
    }
    return ids;
  } catch (err) {
    throw new Error(`Failed to extract strings from binary at ${binaryPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Load the Happier catalog
// ---------------------------------------------------------------------------
function loadHappierCatalog(repoRoot) {
  const require = createRequire(import.meta.url);
  // Build path: the published package should be at packages/agents/dist or via the workspace
  // In development, we load from the workspace source compiled output.
  const pkgPath = resolve(repoRoot, 'packages/agents');

  // Try the compiled dist first, then the workspace source symlink
  for (const attempt of [
    resolve(pkgPath, 'dist/models.js'),
    resolve(pkgPath, 'src/models.js'), // only if pre-built
  ]) {
    if (existsSync(attempt)) {
      const mod = require(attempt);
      if (mod.getAgentStaticModels) return mod.getAgentStaticModels('claude');
    }
  }

  // Fallback: read the TypeScript source and extract IDs with a regexp (no build needed)
  const srcPath = resolve(pkgPath, 'src/models.ts');
  if (!existsSync(srcPath)) throw new Error(`Cannot find ${srcPath}`);
  const src = require('node:fs').readFileSync(srcPath, 'utf8');
  const ids = new Set();
  // Match `id: 'claude-...'` lines
  for (const m of src.matchAll(/id:\s+'(claude-[^']+)'/g)) {
    ids.add(m[1]);
  }
  return [...ids].map((id) => ({ id }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const claudeBin = discoverClaudeBin();

if (!claudeBin) {
  console.error('⚠️  Claude Code CLI binary not found. Pass --claude-bin <path> to specify it.');
  console.error('   Skipping staleness check.');
  process.exit(0);
}

if (!existsSync(claudeBin)) {
  console.error(`⚠️  Claude Code CLI binary not found at: ${claudeBin}`);
  process.exit(0);
}

console.log(`Using CLI binary: ${claudeBin}`);

const cliModelIds = extractCliModelIds(claudeBin);
console.log(`Claude CLI knows ${cliModelIds.size} canonical model IDs.`);

const catalogModels = loadHappierCatalog(REPO_ROOT);
const catalogIds = new Set(catalogModels.map((m) => m.id));
console.log(`Happier catalog has ${catalogIds.size} Claude model IDs.`);

// Models the CLI knows about that Happier does NOT catalog
const missing = [...cliModelIds].filter((id) => !catalogIds.has(id)).sort();

if (missing.length === 0) {
  console.log('✅  Happier catalog is current — no uncataloged Claude model IDs found.');
  process.exit(0);
}

const message = [
  '',
  `❌  ${missing.length} Claude model ID(s) known to the CLI are not in Happier's catalog:`,
  ...missing.map((id) => `     - ${id}`),
  '',
  '   For each missing model, add an entry to:',
  '     packages/agents/src/models.ts (CLAUDE_STATIC_MODELS)',
  '     packages/agents/src/providers/claude/effort.ts (CLAUDE_EFFORT_LEVELS_BY_MODEL_ID)',
  '     packages/agents/src/providers/claude/contextWindow.ts (if 1M-capable)',
  '',
  '   See docs/agents-catalog.md — "Keeping the Claude catalog current" section.',
  '',
].join('\n');

if (warnOnly) {
  console.warn(message);
  process.exit(0);
} else {
  console.error(message);
  process.exit(1);
}
