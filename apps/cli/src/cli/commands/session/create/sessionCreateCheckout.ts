import {
  SCM_OPERATION_ERROR_CODES,
  resolveSessionPathWithinWorktree,
  type ScmWorktreeCreateRequest,
  type ScmWorktreeCreateResponse,
  type ScmWorktreeRemoveRequest,
  type ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';

import { notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';

export type SessionCreateCheckoutRequest = Readonly<{
  displayName: string;
  baseRef?: string;
}>;

export type SessionCreateCheckout = Readonly<{
  kind: 'git_worktree';
  worktreePath: string;
  sessionPath: string;
  branchName: string;
  sourceRootPath: string;
  repositoryRootPath: string;
  disposition: 'retained' | 'removed' | 'remove_failed';
}>;

export type SessionCreateCheckoutCleanup = Readonly<{
  checkout: SessionCreateCheckout;
  cleanupError?: string;
}>;

export async function materializeSessionCreateCheckout(params: Readonly<{
  sourcePath: string;
  request: SessionCreateCheckoutRequest;
}>): Promise<SessionCreateCheckout> {
  const request: ScmWorktreeCreateRequest = {
    cwd: params.sourcePath,
    backendPreference: { kind: 'prefer', backendId: 'git' },
    displayName: params.request.displayName,
    ...(params.request.baseRef ? { baseRef: params.request.baseRef } : {}),
    branchMode: 'new',
  };
  const result = await runScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
    request,
    workingDirectory: params.sourcePath,
    onNonRepository: async () => notRepositoryResponse<ScmWorktreeCreateResponse>(),
    runWithBackend: ({ context, selection }) => selection.backend.worktreeCreate({ context, request }),
  });
  if (!result.success) {
    throw Object.assign(new Error(result.error || 'Failed to create Git worktree'), {
      code: result.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    });
  }

  const sourceRootPath = result.sourceRootPath || params.sourcePath;
  return {
    kind: 'git_worktree',
    worktreePath: result.worktreePath,
    sessionPath: resolveSessionPathWithinWorktree({
      selectedPath: params.sourcePath,
      worktreePath: result.worktreePath,
      sourceRootPath,
    }),
    branchName: result.branchName,
    sourceRootPath,
    repositoryRootPath: result.repositoryRootPath || sourceRootPath,
    disposition: 'retained',
  };
}

export async function cleanupSessionCreateCheckout(
  checkout: SessionCreateCheckout,
): Promise<SessionCreateCheckoutCleanup> {
  try {
    const request: ScmWorktreeRemoveRequest = {
      cwd: checkout.sourceRootPath,
      backendPreference: { kind: 'prefer', backendId: 'git' },
      worktreePath: checkout.worktreePath,
    };
    const result = await runScmRoute<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>({
      request,
      workingDirectory: checkout.sourceRootPath,
      onNonRepository: async () => notRepositoryResponse<ScmWorktreeRemoveResponse>(),
      runWithBackend: ({ context, selection }) => selection.backend.worktreeRemove({ context, request }),
    });
    if (result.success) {
      return { checkout: { ...checkout, disposition: 'removed' } };
    }
    return {
      checkout: { ...checkout, disposition: 'remove_failed' },
      cleanupError: result.error || result.stderr || 'Failed to remove Git worktree',
    };
  } catch (error) {
    return {
      checkout: { ...checkout, disposition: 'remove_failed' },
      cleanupError: error instanceof Error ? error.message : String(error),
    };
  }
}
