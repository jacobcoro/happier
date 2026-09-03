import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    UNISTYLES_REGISTRY_SOURCES,
    UNISTYLES_REMOVE_PATCH_MARKER,
    formatUnistylesWebRemovePatchFailure,
    verifyUnistylesWebRemovePatch,
} from './verifyUnistylesWebRemovePatch.mjs';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLED_PACKAGE_DIR = path.join(UI_DIR, 'node_modules', 'react-native-unistyles');

/**
 * A stand-in package whose registry copies carry the patched shape.
 *
 * The generator writes the ordering the gate cares about — refcount read before document scan, and a
 * `setTimeout` fallback beside the `requestAnimationFrame` — so a test that mutates one property is
 * measuring the gate rather than the generator.
 */
function createFakePackage(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unistyles-web-remove-'));
    for (const relativePath of UNISTYLES_REGISTRY_SOURCES) {
        if (options.omitFiles?.includes(relativePath)) continue;
        const filePath = path.join(dir, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, renderRegistry(relativePath, options), 'utf8');
    }
    return dir;
}

function renderRegistry(relativePath, options) {
    const marker = options.omitMarkerFrom === relativePath || options.omitMarker
        ? '// (marker removed)'
        : `// ${UNISTYLES_REMOVE_PATCH_MARKER}`;
    const schedule = options.omitTimeoutFallback
        ? '        this.pendingFlush = { frame: requestAnimationFrame(flush) };'
        : '        this.pendingFlush = { frame: requestAnimationFrame(flush), timer: setTimeout(flush, 250) };';
    const flushBody = options.scanBeforeRefcount
        ? [
            '        const removed = !document.querySelector(`.${hash}`);',
            '        const stillInUse = (this.stylesCounter.get(hash)?.size ?? 0) > 0;',
        ].join('\n')
        : options.omitRefcountCheck
            ? '        const removed = !document.querySelector(`.${hash}`);'
            : [
                '        const stillInUse = (this.stylesCounter.get(hash)?.size ?? 0) > 0;',
                '        const removed = !stillInUse && !document.querySelector(`.${hash}`);',
            ].join('\n');

    return [
        `// ${relativePath}`,
        marker,
        '    scheduleRemovalFlush = () => {',
        '        const flush = () => this.flushRemovals();',
        schedule,
        '    };',
        '    flushRemovals = () => {',
        flushBody,
        '    };',
        '',
    ].join('\n');
}

test('reports ok when every installed registry copy carries the batched-remove fix', () => {
    const result = verifyUnistylesWebRemovePatch({ packageDir: createFakePackage() });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.failures, []);
});

test('skips when the package is not installed, because absence is not a patch failure', () => {
    const result = verifyUnistylesWebRemovePatch({
        packageDir: path.join(os.tmpdir(), 'react-native-unistyles-absent-uzzz'),
    });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.failures, []);
});

test('fails when the marker is missing from a single copy, because Metro may resolve that copy', () => {
    for (const relativePath of UNISTYLES_REGISTRY_SOURCES) {
        const result = verifyUnistylesWebRemovePatch({
            packageDir: createFakePackage({ omitMarkerFrom: relativePath }),
        });
        assert.equal(result.status, 'failed', `${relativePath} should not be allowed to go unpatched`);
        assert.deepEqual(
            result.failures.map((failure) => failure.file),
            [relativePath],
        );
        assert.equal(result.failures[0].id, 'batched-remove-installed');
    }
});

test('fails when a copy is absent entirely rather than certifying the ones that remain', () => {
    const result = verifyUnistylesWebRemovePatch({
        packageDir: createFakePackage({ omitFiles: ['lib/commonjs/web/registry.js'] }),
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.failures.map((failure) => failure.file), ['lib/commonjs/web/registry.js']);
});

test('fails when the flush stopped consulting the refcount, since batching alone saves no scans', () => {
    const result = verifyUnistylesWebRemovePatch({
        packageDir: createFakePackage({ omitRefcountCheck: true }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failures.length, UNISTYLES_REGISTRY_SOURCES.length);
    for (const failure of result.failures) {
        assert.equal(failure.id, 'refcount-checked-before-dom-scan');
    }
});

test('fails when the document scan happens before the refcount check, which restores the original cost', () => {
    const result = verifyUnistylesWebRemovePatch({
        packageDir: createFakePackage({ scanBeforeRefcount: true }),
    });
    assert.equal(result.status, 'failed');
    for (const failure of result.failures) {
        assert.equal(failure.id, 'refcount-checked-before-dom-scan');
    }
});

test('fails when the hidden-tab timer fallback is dropped, because rAF never fires in a hidden tab', () => {
    const result = verifyUnistylesWebRemovePatch({
        packageDir: createFakePackage({ omitTimeoutFallback: true }),
    });
    assert.equal(result.status, 'failed');
    for (const failure of result.failures) {
        assert.equal(failure.id, 'hidden-tab-flush-fallback');
    }
});

test('the failure report names the file, the check, and the regeneration command', () => {
    const result = verifyUnistylesWebRemovePatch({ packageDir: createFakePackage({ omitMarker: true }) });
    const report = formatUnistylesWebRemovePatchFailure(result);
    assert.match(report, /src\/web\/registry\.ts/);
    assert.match(report, /batched-remove-installed/);
    assert.match(report, /npx patch-package react-native-unistyles/);
});

// The only test that touches REAL bytes. It is what stops the whole gate from being a test of its
// own generator: the checks above would all pass against a package that was never patched.
test('the installed package carries the fix', { skip: !fs.existsSync(INSTALLED_PACKAGE_DIR) }, () => {
    const result = verifyUnistylesWebRemovePatch({ packageDir: INSTALLED_PACKAGE_DIR });
    assert.equal(
        result.status,
        'ok',
        result.status === 'failed' ? formatUnistylesWebRemovePatchFailure(result) : 'unexpected status',
    );
});
