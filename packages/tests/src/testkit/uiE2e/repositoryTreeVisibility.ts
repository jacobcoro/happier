import { expect, type Locator } from '@playwright/test';

export async function selectRepositoryAllFiles(params: Readonly<{
  rightPane: Locator;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const allFilesTab = params.rightPane.getByTestId('repository-tree-visibility:all');

  await expect(allFilesTab).toBeVisible({ timeout: timeoutMs });
  await allFilesTab.click();
  await expect(allFilesTab).toHaveAttribute('aria-selected', 'true', { timeout: timeoutMs });
}
