import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const UNTRACKED_STATS_MAX_FILES = 512;
const UNTRACKED_STATS_MAX_BYTES = 5_000_000;

/** Bounded best-effort statistics for paths supplied by the repository backend. */
export async function readUntrackedFileStats(
    repoRoot: string,
    relativePaths: readonly string[],
): Promise<Record<string, { pendingAdded: number; isBinary: boolean }>> {
    const statsByPath: Record<string, { pendingAdded: number; isBinary: boolean }> = {};
    for (const relativePath of relativePaths.filter((path) => path.length > 0 && path !== '.').slice(0, UNTRACKED_STATS_MAX_FILES)) {
        try {
            const absolutePath = join(repoRoot, relativePath);
            const info = await lstat(absolutePath);
            // A skipped file has no measured statistics; its size is not binary evidence.
            if ((!info.isFile() && !info.isSymbolicLink()) || info.size > UNTRACKED_STATS_MAX_BYTES) continue;
            const buffer = info.isSymbolicLink()
                ? await readlink(absolutePath, { encoding: 'buffer' })
                : await readFile(absolutePath);
            const isBinary = buffer.includes(0);
            let pendingAdded = 0;
            if (!isBinary && buffer.length > 0) {
                for (const byte of buffer) {
                    if (byte === 10) pendingAdded += 1;
                }
                if (buffer[buffer.length - 1] !== 10) pendingAdded += 1;
            }
            statsByPath[relativePath] = { pendingAdded, isBinary };
        } catch {
            // Files can disappear or become unreadable between status and this optional enrichment.
        }
    }
    return statsByPath;
}
