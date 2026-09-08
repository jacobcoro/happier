import type {
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmLogEntry,
    ScmLogListRequest,
    ScmLogListResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { normalizeCommitRef, normalizeRepoRootRelativePath, runScmCommand } from '../../../runtime';

const GIT_LOG_FIELDS_PER_ENTRY = 7;

function parseGitLogEntries(rawOutput: string): ScmLogEntry[] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let fieldStart = 0;

    for (let index = 0; index < rawOutput.length; index += 1) {
        if (rawOutput.charCodeAt(index) !== 0) {
            continue;
        }

        currentRow.push(rawOutput.slice(fieldStart, index));
        fieldStart = index + 1;

        if (currentRow.length === GIT_LOG_FIELDS_PER_ENTRY) {
            rows.push(currentRow);
            currentRow = [];
        }
    }

    return rows.map((row) => {
        const timestampSeconds = Number(row[4] || 0);
        const timestampRaw = Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : 0;
        return {
            sha: row[0] || '',
            shortSha: row[1] || '',
            authorName: row[2] || '',
            authorEmail: row[3] || '',
            timestamp: Number.isFinite(timestampRaw) ? timestampRaw : 0,
            subject: row[5] || '',
            body: row[6] || '',
        };
    });
}

export async function gitDiffFile(input: {
    context: ScmBackendContext;
    request: ScmDiffFileRequest;
}): Promise<ScmDiffFileResponse> {
    const { context, request } = input;
    const normalized = normalizeRepoRootRelativePath(request.path);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: normalized.error,
        };
    }
    const area = request.area ?? 'pending';
    const args =
        area === 'included'
            ? ['diff', '--no-ext-diff', '--cached', '--', normalized.pathspec]
            : area === 'both'
                ? ['diff', '--no-ext-diff', 'HEAD', '--', normalized.pathspec]
                : ['diff', '--no-ext-diff', '--', normalized.pathspec];
    let result = await runScmCommand({ bin: 'git', cwd: context.cwd, args, timeoutMs: 10_000 });
    if (area === 'both' && !result.success && result.exitCode !== 1 && !result.timedOut && !result.outputLimitExceeded) {
        const head = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], timeoutMs: 10_000 });
        if (!head.success && head.exitCode === 1 && !head.timedOut && !head.outputLimitExceeded) {
            // An unborn checkout has no HEAD. Git accepts its format-specific empty tree
            // as a diff base without writing an object or changing the index.
            const emptyTree = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['hash-object', '-t', 'tree', '--stdin'], stdin: '', timeoutMs: 10_000 });
            if (!emptyTree.success) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: emptyTree.stderr || 'Failed to resolve empty tree' };
            }
            result = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['diff', '--no-ext-diff', emptyTree.stdout.trim(), '--', normalized.pathspec], timeoutMs: 10_000 });
        }
    }
    // git diff uses exit code 1 to indicate "differences found". Treat that as success so
    // callers can still render patches.
    const diffCommandOk =
        result.success || (result.exitCode === 1 && !result.timedOut && !result.outputLimitExceeded);
    if (!diffCommandOk) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load file diff',
        };
    }

    const diff = result.stdout ?? '';
    if (diff.trim().length > 0 || area === 'included') {
        return { success: true, diff };
    }

    const repoRoot = context.detection.rootPath ?? context.cwd;
    const relativePath = normalized.relativePath;
    if (!repoRoot || !relativePath || relativePath === '.') {
        return { success: true, diff };
    }

    // git diff does not report untracked file diffs. Detect untracked files and synthesize
    // an add diff against /dev/null so UI can show a meaningful patch.
    const untrackedCheck = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['ls-files', '--others', '--exclude-standard', '-z', '--', normalized.pathspec],
        timeoutMs: 10_000,
    });
    if (!untrackedCheck.success) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: untrackedCheck.stderr || 'Failed to inspect untracked file' };
    }
    const isUntracked =
        typeof untrackedCheck.stdout === 'string'
        && untrackedCheck.stdout.split('\0').includes(relativePath);

    if (!isUntracked) {
        return { success: true, diff };
    }

    const untrackedDiff = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', relativePath],
        timeoutMs: 10_000,
    });
    const untrackedDiffOk =
        untrackedDiff.success || (untrackedDiff.exitCode === 1 && !untrackedDiff.timedOut && !untrackedDiff.outputLimitExceeded);
    return untrackedDiffOk
        ? { success: true, diff: untrackedDiff.stdout }
        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: untrackedDiff.stderr || 'Failed to load untracked file diff' };
}

export async function gitDiffCommit(input: {
    context: ScmBackendContext;
    request: ScmDiffCommitRequest;
}): Promise<ScmDiffCommitResponse> {
    const { context, request } = input;
    const commitRef = normalizeCommitRef(request.commit);
    if (!commitRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: commitRef.error,
        };
    }
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['show', '--no-ext-diff', '--patch', '--format=fuller', commitRef.commit],
        timeoutMs: 15_000,
    });
    return result.success
        ? { success: true, diff: result.stdout }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load commit diff',
        };
}

export async function gitLogList(input: {
    context: ScmBackendContext;
    request: ScmLogListRequest;
}): Promise<ScmLogListResponse> {
    const { context, request } = input;
    const limit = request.limit ?? 50;
    const skip = request.skip ?? 0;
    const log = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: [
            'log',
            `--max-count=${limit}`,
            `--skip=${skip}`,
            '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00',
        ],
        timeoutMs: 15_000,
    });
    if (!log.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: log.stderr || 'Failed to list commits',
        };
    }
    return { success: true, entries: parseGitLogEntries(log.stdout) };
}
