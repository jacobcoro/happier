import { z } from 'zod';

import {
  ScmOperationErrorCodeSchema,
  ScmRequestBaseSchema,
} from './scm.js';

export const ScmWorktreeCommandResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmWorktreeCommandResponse = z.infer<typeof ScmWorktreeCommandResponseSchema>;

export const ScmWorktreeCreateRequestSchema = ScmRequestBaseSchema.extend({
  displayName: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  branchMode: z.enum(['new', 'existing']).optional(),
});
export type ScmWorktreeCreateRequest = z.infer<typeof ScmWorktreeCreateRequestSchema>;

export const ScmWorktreeCreateResponseSchema = z.object({
  success: z.boolean(),
  worktreePath: z.string(),
  branchName: z.string(),
  sourceRootPath: z.string().optional(),
  repositoryRootPath: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmWorktreeCreateResponse = z.infer<typeof ScmWorktreeCreateResponseSchema>;

export const ScmWorktreeRemoveRequestSchema = ScmRequestBaseSchema.extend({
  worktreePath: z.string().min(1),
});
export type ScmWorktreeRemoveRequest = z.infer<typeof ScmWorktreeRemoveRequestSchema>;

export const ScmWorktreeRemoveResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreeRemoveResponse = z.infer<typeof ScmWorktreeRemoveResponseSchema>;

export const ScmWorktreePruneRequestSchema = ScmRequestBaseSchema;
export type ScmWorktreePruneRequest = z.infer<typeof ScmWorktreePruneRequestSchema>;

export const ScmWorktreePruneResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreePruneResponse = z.infer<typeof ScmWorktreePruneResponseSchema>;

function normalizeWorktreePath(value: string): string {
  const normalizedSeparators = value.trim().replace(/\\+/g, '/');
  const normalizedDriveLetter = normalizedSeparators.replace(
    /^([A-Z]):/,
    (_match, driveLetter: string) => `${driveLetter.toLowerCase()}:`,
  );
  const trimmedTrailingSeparator = normalizedDriveLetter.replace(/\/+$/, '');
  return trimmedTrailingSeparator.length > 0 ? trimmedTrailingSeparator : normalizedDriveLetter;
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:($|\/)/i.test(value);
}

function normalizeWorktreePathForComparison(value: string): string {
  return isWindowsPath(value) ? value.toLowerCase() : value;
}

function isPathAtOrWithinRoot(path: string, rootPath: string): boolean {
  const comparablePath = normalizeWorktreePathForComparison(path);
  const comparableRootPath = normalizeWorktreePathForComparison(rootPath);
  if (comparablePath === comparableRootPath) return true;
  return comparablePath.startsWith(comparableRootPath)
    && comparablePath.charAt(comparableRootPath.length) === '/';
}

export function resolveSessionPathWithinWorktree(params: Readonly<{
  selectedPath: string;
  worktreePath: string;
  sourceRootPath: string;
}>): string {
  const selectedPath = normalizeWorktreePath(params.selectedPath);
  const worktreePath = normalizeWorktreePath(params.worktreePath);
  const sourceRootPath = normalizeWorktreePath(params.sourceRootPath);
  if (!isPathAtOrWithinRoot(selectedPath, sourceRootPath)) return params.worktreePath;

  const relativePath = selectedPath.slice(sourceRootPath.length).replace(/^\/+/, '');
  return relativePath ? `${worktreePath}/${relativePath}` : params.worktreePath;
}
