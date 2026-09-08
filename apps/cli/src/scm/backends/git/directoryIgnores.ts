import { runScmCommand } from '../../runtime';
import { isGitAdministrativeWorkspacePath } from './sourceController';

/** Git owns ignore semantics, including global excludes, negation and tracked-file exceptions. */
export async function classifyGitDirectoryIgnores(input: Readonly<{
    cwd: string;
    entries: readonly Readonly<{ name: string; type: 'file' | 'directory' | 'other' }>[];
}>): Promise<ReadonlySet<string>> {
    const ignored = new Set(input.entries
        .filter((entry) => isGitAdministrativeWorkspacePath({ relativePath: entry.name }))
        .map((entry) => entry.name));
    const candidates = input.entries.filter((entry) => !ignored.has(entry.name));
    if (candidates.length === 0) return ignored;

    const result = await runScmCommand({
        bin: 'git', cwd: input.cwd,
        args: ['check-ignore', '-z', '--stdin'],
        stdin: candidates.map((entry) => entry.name).join('\0') + '\0',
    });
    // Exit 1 means no paths matched. Never interpret command failure as an empty project.
    if (result.timedOut || result.outputLimitExceeded || (result.exitCode !== 0 && result.exitCode !== 1)) {
        throw new Error(`Git ignore classification unavailable: ${result.stderr}`);
    }
    for (const name of result.stdout.split('\0')) if (name) ignored.add(name);

    // Git can ignore a directory while it still contains force-added tracked source.
    const ignoredDirectories = candidates.filter((entry) => entry.type === 'directory' && ignored.has(entry.name));
    if (ignoredDirectories.length > 0) {
        const tracked = await runScmCommand({
            bin: 'git', cwd: input.cwd,
            args: ['--literal-pathspecs', 'ls-files', '--cached', '-z', '--', ...ignoredDirectories.map((entry) => entry.name)],
        });
        if (!tracked.success) throw new Error(`Git tracked-directory classification unavailable: ${tracked.stderr}`);
        for (const path of tracked.stdout.split('\0')) {
            const separator = path.indexOf('/');
            if (separator > 0) ignored.delete(path.slice(0, separator));
        }
    }
    return ignored;
}
