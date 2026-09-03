import fs from 'node:fs';
import path from 'node:path';

/**
 * Integrity gate for the vendored `react-native-unistyles` batched-remove patch.
 *
 * WHY THIS EXISTS
 * The patch is a PERFORMANCE fix, so losing it fails silently in the worst way: every test still
 * passes, the UI still renders the right pixels, and the only symptom is that typing gets slower the
 * longer the app has been open. `patch-package` regenerates a patch from whatever is in
 * `node_modules` at the time, so a regeneration performed against a partially-reverted tree drops
 * hunks with no error and exit 0. That failure mode has already fired in this checkout for the
 * reanimated patch; see {@link ./verifyVendoredReanimatedPatchMarkers.mjs}.
 *
 * WHAT THE PATCH FIXES
 * `createUnistylesElement` builds a fresh inline ref callback on every render. React therefore
 * detaches and re-attaches every Unistyles element's ref on every render, and upstream's
 * `UnistylesRegistry.remove` answered each detach with its own microtask running a whole-document
 * `document.querySelector('.hash')` scan. Measured on this app: typing 10 characters into the
 * session composer ran 736 whole-document scans across 39 style hashes, every one of them for an
 * element that never left the DOM. Any hash that genuinely reached zero additionally rebuilt the
 * entire stylesheet through `CSSState.remove` -> `recreate` -> `getStyles`.
 *
 * WHAT IT PROVES, AND WHY IT ASSERTS THE INSTALLED ARTIFACT
 * Asserting the `.patch` FILE's text is worthless — it reads the same whether or not the patch was
 * applied. This gate reads the installed `node_modules` sources instead: pure `fs`, no external
 * binary, same answer on every platform.
 *
 * WHY ALL THREE ARTIFACTS
 * The package ships the same module three times and resolves a different one per consumer:
 * `src/web/registry.ts` under the `react-native` export condition, `lib/module/web/registry.js`
 * under `import`/`browser`, `lib/commonjs/web/registry.js` under `default`. Metro's web build picks
 * one of the compiled copies; a patched `src` copy does not vindicate an unpatched `lib` copy, and
 * the unpatched one is the one that would ship.
 *
 * LOUD ON UPSTREAM DRIFT
 * Every check fails rather than skips when the file it names is present but unrecognisable. An
 * upstream bump that rewrites `remove` must stop the install so a human re-derives the fix, not
 * quietly certify a tree that no longer contains it.
 */

/** Marker the patch writes into every artifact it rewrites. */
export const UNISTYLES_REMOVE_PATCH_MARKER = 'UNISTYLES_WEB_BATCHED_REMOVE_PATCH';

/**
 * Every installed copy of the web registry. Each is resolved by a different export condition, so
 * each must carry the fix independently.
 */
export const UNISTYLES_REGISTRY_SOURCES = Object.freeze([
    'src/web/registry.ts',
    'lib/module/web/registry.js',
    'lib/commonjs/web/registry.js',
]);

/**
 * One entry per check, with the provenance that lets a future reader decide whether it is still
 * needed. `removeWhen` is the condition under which the check should be DELETED rather than carried
 * forward — most likely because upstream fixed it.
 */
export const UNISTYLES_PATCH_CHECKS = Object.freeze([
    {
        id: 'batched-remove-installed',
        defect: 'Upstream `UnistylesRegistry.remove` scheduled one microtask per call, and each one ran '
            + 'a whole-document `document.querySelector(".hash")` scan. Because React re-creates the '
            + 'inline ref callback in `createUnistylesElement` on every render, that is one scan per '
            + 'styled element per render on elements that never unmount. Without the batching the '
            + 'session composer costs ~76 whole-document scans per keystroke.',
        removeWhen: 'upstream batches its own removals, or stops scanning the document to decide '
            + 'whether a hash is still in use',
    },
    {
        id: 'refcount-checked-before-dom-scan',
        defect: 'Batching alone does not remove the scans — it only groups them. The saving comes from '
            + 'consulting `stylesCounter` first and skipping any hash whose refcount recovered before '
            + 'the flush, which is the detach/re-attach case and therefore almost all of them. A flush '
            + 'that scans unconditionally reintroduces the original cost one frame later.',
        removeWhen: 'the flush no longer needs a refcount short-circuit because upstream stopped '
            + 'detaching refs on re-render',
    },
    {
        id: 'hidden-tab-flush-fallback',
        defect: '`requestAnimationFrame` never fires while the tab is hidden. A rAF-only flush would '
            + 'leave a backgrounded app holding its pending resolvers, and the dependency listeners '
            + 'those resolvers dispose, for as long as the tab stays in the background — a new leak '
            + 'introduced by the fix itself. The timer fallback bounds it.',
        removeWhen: 'the flush stops owning promise resolvers whose non-delivery leaks anything',
    },
]);

/**
 * @param {Readonly<{ packageDir: string }>} params
 * @returns {{ status: 'ok' | 'failed' | 'skipped', reason?: string, failures: Array<{ id: string, file: string, detail: string }> }}
 */
export function verifyUnistylesWebRemovePatch(params) {
    const packageDir = params.packageDir;
    if (!fs.existsSync(packageDir)) {
        // Not installed (fresh clone, pruned install, or a workspace that does not depend on it).
        // Absence of the package is not a patch-integrity failure.
        return {
            status: 'skipped',
            reason: `package not installed at ${packageDir}`,
            failures: [],
        };
    }

    const failures = [];
    const fail = (id, file, detail) => failures.push({ id, file, detail });

    for (const relativePath of UNISTYLES_REGISTRY_SOURCES) {
        const contents = readInstalledSource(packageDir, relativePath);

        if (contents === null) {
            // The package IS installed, so every copy of the module that owns the fix must be
            // readable. Reporting `ok` for a file the gate could not open is the exact vacuity this
            // gate exists to replace.
            fail('batched-remove-installed', relativePath, 'not readable, so the fix could not be certified');
            continue;
        }

        if (!contents.includes(UNISTYLES_REMOVE_PATCH_MARKER)) {
            fail(
                'batched-remove-installed',
                relativePath,
                `\`${UNISTYLES_REMOVE_PATCH_MARKER}\` is absent; this copy still schedules one document scan per ref detach`,
            );
            continue;
        }

        const body = extractArrowBody(contents, 'flushRemovals');
        if (body === null) {
            fail(
                'refcount-checked-before-dom-scan',
                relativePath,
                'the marker is present but no `flushRemovals` body was found; the patch was hand-edited or partially reverted',
            );
            continue;
        }

        const counterIndex = body.indexOf('stylesCounter');
        const scanIndex = body.indexOf('document.querySelector');

        if (counterIndex === -1) {
            fail(
                'refcount-checked-before-dom-scan',
                relativePath,
                '`flushRemovals` no longer consults `stylesCounter`, so a hash whose ref re-attached in the same frame is still scanned for',
            );
        } else if (scanIndex !== -1 && counterIndex > scanIndex) {
            fail(
                'refcount-checked-before-dom-scan',
                relativePath,
                '`flushRemovals` scans the document before checking `stylesCounter`; the refcount short-circuit cannot save the scan it is there to save',
            );
        }

        const scheduleBody = extractArrowBody(contents, 'scheduleRemovalFlush');
        if (scheduleBody === null) {
            fail('hidden-tab-flush-fallback', relativePath, 'no `scheduleRemovalFlush` body was found');
        } else if (!scheduleBody.includes('setTimeout')) {
            fail(
                'hidden-tab-flush-fallback',
                relativePath,
                'the flush is scheduled without a `setTimeout` fallback; a hidden tab never runs `requestAnimationFrame`, so pending resolvers would never settle',
            );
        }
    }

    return failures.length > 0 ? { status: 'failed', failures } : { status: 'ok', failures: [] };
}

/** @param {ReturnType<typeof verifyUnistylesWebRemovePatch>} result */
export function formatUnistylesWebRemovePatchFailure(result) {
    const lines = ['Vendored react-native-unistyles batched-remove patch is not installed correctly:'];
    for (const failure of result.failures) {
        const check = UNISTYLES_PATCH_CHECKS.find((candidate) => candidate.id === failure.id);
        lines.push(`  - ${failure.id} (${failure.file}): ${failure.detail}`);
        if (check) lines.push(`      ${check.defect}`);
    }
    lines.push('');
    lines.push('This usually means the patch was regenerated against a partially-reverted node_modules,');
    lines.push('or an upstream bump moved the code the fix lives in.');
    lines.push('Do NOT hand-edit the .patch file. Restore the behaviour in node_modules, then run:');
    lines.push('  npx patch-package react-native-unistyles --patch-dir patches');
    return lines.join('\n');
}

function readInstalledSource(packageDir, relativePath) {
    const filePath = path.join(packageDir, ...relativePath.split('/'));
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Return the brace-delimited body of the class-property arrow function named `name`, or `null` when
 * it is absent.
 *
 * Scoping to the body is load-bearing rather than tidiness: a whole-file `indexOf` would happily
 * compare a `stylesCounter` read in one method against a `document.querySelector` call in another
 * and certify an ordering that no single execution ever performs.
 */
function extractArrowBody(contents, name) {
    const signature = new RegExp(`(^|[^\\w$])${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`, 'm').exec(contents);
    if (!signature) return null;

    const openIndex = contents.indexOf('{', signature.index + signature[0].length - 1);
    if (openIndex === -1) return null;

    let depth = 0;
    for (let i = openIndex; i < contents.length; i += 1) {
        const char = contents[i];

        if (char === '/' && contents[i + 1] === '/') {
            const newline = contents.indexOf('\n', i);
            if (newline === -1) return null;
            i = newline;
            continue;
        }
        if (char === '/' && contents[i + 1] === '*') {
            const close = contents.indexOf('*/', i + 2);
            if (close === -1) return null;
            i = close + 1;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            const end = findLiteralEnd(contents, i, char);
            if (end === -1) return null;
            i = end;
            continue;
        }

        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return contents.slice(openIndex + 1, i);
        }
    }
    return null;
}

function findLiteralEnd(contents, startIndex, quote) {
    for (let i = startIndex + 1; i < contents.length; i += 1) {
        if (contents[i] === '\\') {
            i += 1;
            continue;
        }
        if (contents[i] === quote) return i;
    }
    return -1;
}
