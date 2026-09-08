import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCodexCliInvocation } from './resolveCodexCliInvocation';

// Observe genuine filesystem reads while keeping executable resolution and runtime selection real.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

async function createExecutable(params: Readonly<{ dir: string; name: string }>): Promise<string> {
    mkdirSync(params.dir, { recursive: true });
    const filePath = join(params.dir, params.name);
    writeFileSync(filePath, '#!/bin/sh\necho codex\n', 'utf8');
    chmodSync(filePath, 0o755);
    return filePath;
}

describe('resolveCodexCliInvocation', () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
        vi.unstubAllEnvs();
        vi.mocked(readFileSync).mockClear();
    });

    it.each([
        { name: 'native', contents: '\u007fELF\u0000native executable payload', needsRuntime: false },
        { name: 'node-shim', contents: '#!/usr/bin/env node\nconsole.log("codex");', needsRuntime: true },
        { name: 'codex.js', contents: 'console.log("codex");', needsRuntime: true },
    ])('resolves $name without reading the entire executable', async ({ name, contents, needsRuntime }) => {
        if (process.platform === 'win32') return;
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-header-'));
        try {
            const executable = join(root, name);
            writeFileSync(executable, contents, 'utf8');
            chmodSync(executable, 0o755);
            const args = ['app-server', '--listen', 'stdio://'];
            const invocation = await resolveCodexCliInvocation({
                args,
                processEnv: {
                    ...process.env,
                    HAPPIER_CODEX_APP_SERVER_BIN: executable,
                    HAPPIER_JS_RUNTIME_PATH: process.execPath,
                },
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
            });

            expect(invocation).toEqual(needsRuntime
                ? { command: process.execPath, args: [executable, ...args] }
                : { command: executable, args });
            expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === executable)).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('ignores missing app-server override paths and falls back to the provider CLI resolution', async () => {
        if (process.platform === 'win32') {
            // Windows PATH resolution + exec bits differ; current failure mode is Unix-only.
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-'));
        const binDir = join(root, 'bin');
        const codexPath = await createExecutable({ dir: binDir, name: 'codex' });

        const originalPath = process.env.PATH ?? '';
        vi.stubEnv('PATH', `${binDir}:${originalPath}`);
        vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', join(root, 'missing-codex-app-server'));

        const invocation = await resolveCodexCliInvocation({
            args: ['app-server', '--listen', 'stdio://'],
            processEnv: process.env,
            overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
            targetLabel: 'Codex app-server',
        });

        expect(invocation.command).toBe(codexPath);
    });

    it('expands ~ in override env vars before resolving the Codex CLI invocation', async () => {
        if (process.platform === 'win32') {
            // Windows home dir resolution differs; `~` expansion is primarily a Unix affordance.
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-home-'));
        try {
            const homeTmp = join(root, 'fixture');
            const binDir = join(homeTmp, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex-app-server' });

            vi.stubEnv('HOME', root);
            const override = '~/fixture/bin/codex-app-server';
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', override);

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('expands ~ in override env vars against the provided processEnv HOME', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-scoped-home-'));
        const scopedHome = join(root, 'home');
        try {
            const binDir = join(scopedHome, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex-app-server' });

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                processEnv: {
                    ...process.env,
                    HOME: scopedHome,
                    HAPPIER_CODEX_APP_SERVER_BIN: '~/bin/codex-app-server',
                },
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('ignores override paths that point at a directory and falls back to provider CLI resolution', async () => {
        if (process.platform === 'win32') {
            // Windows PATH resolution + exec bits differ; current failure mode is Unix-only.
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-'));
        try {
            const homeTmp = join(root, 'home-fixture');
            const homeBinDir = join(homeTmp, 'bin');
            mkdirSync(homeBinDir, { recursive: true });
            vi.stubEnv('HOME', root);
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', '~/home-fixture/bin');

            const binDir = join(root, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex' });
            const originalPath = process.env.PATH ?? '';
            vi.stubEnv('PATH', `${binDir}:${originalPath}`);

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('resolves relative override paths against the provided cwd', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-cwd-'));
        try {
            const cwd = join(root, 'project');
            const binDir = join(cwd, 'bin');
            const codexPath = await createExecutable({ dir: binDir, name: 'codex-app-server' });
            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', './bin/codex-app-server');

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                cwd,
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command).toBe(codexPath);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('prefers the .cmd shim over an extensionless Windows override path', async () => {
        if (!originalPlatformDescriptor) {
            throw new Error('Expected process.platform to be configurable for this test');
        }
        Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

        const root = await mkdtemp(join(tmpdir(), 'happier-codex-cli-invocation-win32-'));
        try {
            const cwd = join(root, 'project');
            const binDir = join(cwd, 'bin');
            mkdirSync(binDir, { recursive: true });

            const extensionlessPath = join(binDir, 'codex-app-server');
            writeFileSync(extensionlessPath, '', 'utf8');
            const cmdShimPath = join(binDir, 'codex-app-server.cmd');
            writeFileSync(cmdShimPath, '@echo off\r\necho codex\r\n', 'utf8');

            vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', './bin/codex-app-server');
            vi.stubEnv('PATHEXT', '.CMD;.EXE');

            const invocation = await resolveCodexCliInvocation({
                args: ['app-server', '--listen', 'stdio://'],
                cwd,
                processEnv: process.env,
                overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN'],
                targetLabel: 'Codex app-server',
            });

            expect(invocation.command.toLowerCase()).toBe(cmdShimPath.toLowerCase());
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
