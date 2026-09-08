import { expect, type Page } from '@playwright/test';

async function maybeDismissWebModal(params: Readonly<{ page: Page; timeoutMs: number }>): Promise<boolean> {
  const startedAt = Date.now();
  const confirm = params.page.locator('[data-testid="web-modal-confirm"]:visible').first();
  const button0 = params.page.locator('[data-testid="web-modal-button-0"]:visible').first();

  while (Date.now() - startedAt < params.timeoutMs) {
    if ((await confirm.count()) > 0) {
      // Modal closure is the boundary here; authenticateAndStartDaemon then
      // waits for CLI authentication success before starting the daemon.
      await confirm.click({ timeout: 15_000, noWaitAfter: true });
      await expect(confirm).toHaveCount(0, { timeout: 60_000 });
      return true;
    }
    if ((await button0.count()) > 0) {
      await button0.click({ timeout: 15_000, noWaitAfter: true });
      await expect(button0).toHaveCount(0, { timeout: 60_000 });
      return true;
    }
    await params.page.waitForTimeout(200);
  }

  return false;
}

export async function approveTerminalConnect(params: Readonly<{ page: Page }>): Promise<void> {
  const approveByTestId = params.page.locator('[data-testid="terminal-connect-approve"]:visible').first();
  if ((await approveByTestId.count()) > 0) {
    await expect(approveByTestId).toBeVisible({ timeout: 60_000 });
    await approveByTestId.click();
  } else {
    const approveByRole = params.page.getByRole('button', { name: 'Accept Connection' });
    try {
      await expect(approveByRole).toHaveCount(1, { timeout: 60_000 });
      await approveByRole.click();
    } catch {
      const approveByText = params.page.getByText('Accept Connection', { exact: true }).first();
      await expect(approveByText).toBeVisible({ timeout: 60_000 });
      await approveByText.click({ force: true });
    }
  }

  // Terminal connect can succeed with a web modal (OK button) that must be dismissed before
  // continuing to drive the UI.
  await maybeDismissWebModal({ page: params.page, timeoutMs: 30_000 });
}
