import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listDirectoryEntries } from './listDirectoryEntries';

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'happier-directory-listing-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('listDirectoryEntries', () => {
  it('sorts directories before files and returns direct children only', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'z-folder'));
    mkdirSync(join(root, 'a-folder'));
    mkdirSync(join(root, 'a-folder', 'nested'));
    writeFileSync(join(root, 'b-file.txt'), 'b');
    writeFileSync(join(root, 'a-file.txt'), 'a');

    const result = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: true,
      maxEntries: null,
      statConcurrency: 4,
    });

    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['a-folder', 'directory'],
      ['z-folder', 'directory'],
      ['a-file.txt', 'file'],
      ['b-file.txt', 'file'],
    ]);
    expect(result.entries.some((entry) => entry.absolutePath.endsWith('nested'))).toBe(false);
  });

  it('classifies actual Git ignores while preserving tracked descendants and useful dotfiles', async () => {
    const root = createTempDirectory();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n');
    mkdirSync(join(root, 'build'));
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, 'build', 'tracked.txt'), 'source');
    writeFileSync(join(root, 'build', 'noise.log'), 'noise');
    writeFileSync(join(root, 'tracked.log'), 'source');
    writeFileSync(join(root, 'noise.log'), 'noise');
    execFileSync('git', ['add', '-f', 'build/tracked.txt', 'tracked.log'], { cwd: root });
    const list = (directoryPath: string) => listDirectoryEntries({
      directoryPath, includeFiles: true, maxEntries: null, statConcurrency: 4, includeGitIgnore: true,
    });
    const rootResult = await list(root);
    expect(rootResult.gitIgnoreAvailable).toBe(true);
    expect(Object.fromEntries(rootResult.entries.map((entry) => [entry.name, entry.gitIgnored]))).toMatchObject({
      '.git': true, '.gitignore': false, '.github': false, build: false, 'tracked.log': false, 'noise.log': true,
    });
    const nested = await list(join(root, 'build'));
    expect(Object.fromEntries(nested.entries.map((entry) => [entry.name, entry.gitIgnored]))).toEqual({
      'tracked.txt': false, 'noise.log': true,
    });
    writeFileSync(join(root, '.git', 'index'), 'invalid index');
    const failed = await list(root);
    expect(failed.gitIgnoreAvailable).toBe(false);
    expect(failed.entries.some((entry) => entry.name === 'noise.log')).toBe(true);
    expect(failed.entries.every((entry) => entry.gitIgnored === undefined)).toBe(true);
    const outside = createTempDirectory();
    writeFileSync(join(outside, 'keep.log'), 'keep');
    const unavailable = await list(outside);
    expect(unavailable.gitIgnoreAvailable).toBe(false);
    expect(unavailable.entries.map((entry) => entry.name)).toEqual(['keep.log']);
    expect(unavailable.entries[0].gitIgnored).toBeUndefined();
  });

  it('can hide files and report truncation when maxEntries is applied', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    writeFileSync(join(root, 'notes.txt'), 'hello');

    const directoriesOnly = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: false,
      maxEntries: null,
      statConcurrency: 4,
    });

    expect(directoriesOnly.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);

    const truncated = await listDirectoryEntries({
      directoryPath: root,
      includeFiles: true,
      maxEntries: 2,
      statConcurrency: 4,
    });

    expect(truncated.entries).toHaveLength(2);
    expect(truncated.truncated).toBe(true);
  });
});
