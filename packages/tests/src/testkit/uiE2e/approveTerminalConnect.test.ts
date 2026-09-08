import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const playwrightExpect = vi.hoisted(() => vi.fn());

vi.mock('@playwright/test', () => ({
  expect: playwrightExpect,
}));

import { approveTerminalConnect } from './approveTerminalConnect';

function createLocator(params: Readonly<{
  count?: number;
  onClick?: (options?: Parameters<Locator['click']>[0]) => void;
}>): Locator {
  return {
    count: async () => params.count ?? 0,
    click: async (options?: Parameters<Locator['click']>[0]) => {
      params.onClick?.(options);
    },
    first: () => createLocator(params),
  } as unknown as Locator;
}

function createFakePage(): Pick<Page, 'getByTestId' | 'getByRole' | 'locator' | 'waitForTimeout'> & {
  clicked: string[];
} {
  const clicked: string[] = [];
  const hiddenApprove = createLocator({ count: 1, onClick: () => clicked.push('hidden-test-id') });
  const visibleApprove = createLocator({ count: 1, onClick: () => clicked.push('visible-test-id') });
  const roleApprove = createLocator({ count: 1, onClick: () => clicked.push('role') });
  const empty = createLocator({ count: 0 });

  return {
    clicked,
    getByTestId: ((testId: string) => testId === 'terminal-connect-approve' ? hiddenApprove : empty) as Page['getByTestId'],
    getByRole: ((_role, options) => options?.name === 'Accept Connection' ? roleApprove : empty) as Page['getByRole'],
    locator: ((selector: string) => {
      if (selector === '[data-testid="terminal-connect-approve"]:visible') return visibleApprove;
      return empty;
    }) as Page['locator'],
    waitForTimeout: async () => {},
  };
}

describe('approveTerminalConnect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    playwrightExpect.mockReset();
    playwrightExpect.mockImplementation(() => ({
      toHaveCount: async () => {},
      toBeVisible: async () => {},
    }));
  });

  it('dismisses the success modal while the destination navigation is loading', async () => {
    const page = createFakePage();
    const originalLocator = page.locator;
    let modalVisible = true;
    const modal = createLocator({
      count: 1,
      onClick: (options) => {
        modalVisible = false;
        // Playwright boundary: click completed but the destination load is pending.
        if (options?.noWaitAfter !== true) throw new Error('scheduled navigation is still loading');
      },
    });
    page.locator = ((selector: string) => selector === '[data-testid="web-modal-button-0"]:visible' ? modal : originalLocator(selector)) as Page['locator'];
    playwrightExpect.mockImplementation(() => ({
      toBeVisible: async () => {},
      toHaveCount: async () => { expect(modalVisible).toBe(false); },
    }));
    await approveTerminalConnect({ page: page as unknown as Page });
    expect(modalVisible).toBe(false);
  });

  it('clicks the visible terminal-connect approve control when hidden controls share the same test id', async () => {
    const page = createFakePage();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(30_001);

    await approveTerminalConnect({ page: page as unknown as Page });

    expect(page.clicked).toEqual(['visible-test-id']);
  });
});
