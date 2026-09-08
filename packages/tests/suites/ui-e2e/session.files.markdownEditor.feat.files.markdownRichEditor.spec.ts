import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import {
  gotoCommittedWithRetries,
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

// Eligible markdown: clean Phase-1 constructs only (no reference links / HTML).
const ELIGIBLE_MARKDOWN = '# Rich editor doc\n\nHello **world**.\n\n- one\n- two\n';
const FORMATTING_MARKDOWN = 'Hello formatting seed.\n';
// Ineligible markdown: reference-style link definition -> the layered gate (§5.3)
// blocks rich editing with reason `reference-links`, so the file edits as raw.
const INELIGIBLE_MARKDOWN = 'See [the docs][ref].\n\n[ref]: https://example.com\n';
const MARKDOWN_EDITOR_E2E_TIMEOUT_MS = 900_000;

function rightPaneLocator(page: Page): Locator {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
}

function detailsPaneLocator(page: Page): Locator {
  return page.getByTestId('multi-pane-details-docked').or(page.getByTestId('multi-pane-details-overlay'));
}

function visibleDetailsByTestId(page: Page, testId: string): Locator {
  return detailsPaneLocator(page).locator(`[data-testid="${testId}"]:visible`);
}

function firstVisibleDetailsByTestId(page: Page, testId: string): Locator {
  return visibleDetailsByTestId(page, testId).first();
}

async function ensureSwitchEnabled(toggle: Locator): Promise<void> {
  await expect(toggle).toHaveCount(1, { timeout: 60_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

// Enable the experimental rich-markdown-editor flag through the in-app Settings
// (the flag is `isExperimental:true, defaultEnabled:false`, so it requires the
// experiments master switch plus its own toggle).
async function enableMarkdownRichEditorInSettings(params: Readonly<{ baseUrl: string; page: Page }>): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(
    params.page,
    `${params.baseUrl}/settings/features?happier_hmr=0`,
    '/settings/features',
    180_000,
  );
  await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));
  await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-files.markdownRichEditor'));
}

async function openFileInDetailsPane(params: Readonly<{
  page: Page;
  baseUrl: string;
  sessionId: string;
  filePath: string;
}>): Promise<void> {
  const { page, baseUrl, sessionId, filePath } = params;
  const encodedSessionId = encodeURIComponent(sessionId);
  const sessionPath = `/session/${encodedSessionId}`;
  const onCurrentSession = (() => {
    try {
      const pathname = new URL(page.url()).pathname.replace(/\/+$/, '');
      return pathname === sessionPath || pathname.startsWith(`${sessionPath}/`);
    } catch {
      return false;
    }
  })();
  const appReady = onCurrentSession && await page.getByTestId('session-composer-input').count().catch(() => 0) > 0;
  if (!appReady) {
    await gotoDomContentLoadedWithPathFallback(
      page,
      `${baseUrl}${sessionPath}?right=files&happier_hmr=0`,
      sessionPath,
      180_000,
    );
  }
  await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
  await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

  const rightPane = rightPaneLocator(page);
  await clickScopedButtonByTestIdOrRole({
    scope: rightPane,
    testId: 'session-rightpanel-tab:files',
    roleName: 'Files',
    timeoutMs: 180_000,
  });
  await expect(rightPane.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, { timeout: 120_000 });

  const row = rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(filePath)}`);
  await expect(row).toHaveCount(1, { timeout: 180_000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();

  const tab = page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${filePath}`)}`);
  await expect(tab).toHaveCount(1, { timeout: 120_000 });
  await tab.click();
}

test.describe('ui e2e: markdown rich editor (feat.files.markdownRichEditor)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-markdown-editor-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS
        ?? process.env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS
        ?? '900000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    uiWebEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = server.baseUrl;
    ui = await startUiWeb({ testDir: suiteDir, env: uiWebEnv });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('edits an eligible markdown file in the rich surface and writes clean markdown to disk', async ({ page }) => {
    test.setTimeout(MARKDOWN_EDITOR_E2E_TIMEOUT_MS);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't1-markdown-editor'));
    await mkdir(testDir, { recursive: true });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoCommittedWithRetries(page, uiBaseUrl, 180_000);
      await waitForInitialAppUi({ page, browserDiagnostics });

      daemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        initialUiGotoTimeoutMs: 180_000,
        initialUiReadyTimeoutMs: 180_000,
        terminalConnectUrlTimeoutMs: 180_000,
        daemonStartupTimeoutMs: 180_000,
        extraEnv: {
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

      // Turn on the experimental rich-markdown-editor flag so the Raw<->Rich
      // toggle + rich surface are available (the feat.* suffix marks this gate).
      await enableMarkdownRichEditorInSettings({ baseUrl: uiBaseUrl, page });

      // Seed a workspace with an eligible and an ineligible markdown file.
      const repoDir = resolve(join(testDir, 'repo'));
      await initGitRepo({ repoDir });
      const eligiblePath = 'README.md';
      const ineligiblePath = 'refs.md';
      await writeFile(resolve(join(repoDir, eligiblePath)), ELIGIBLE_MARKDOWN, 'utf8');
      await writeFile(resolve(join(repoDir, ineligiblePath)), INELIGIBLE_MARKDOWN, 'utf8');
      execGit(repoDir, ['add', eligiblePath, ineligiblePath]);
      execGit(repoDir, ['commit', '-m', 'chore: seed markdown editor fixture']);

      const sessionId = await spawnSessionFromDaemon({ daemon, directory: repoDir });

      // --- Eligible file: preview -> Edit -> rich surface -> toggle -> type -> Save ---
      await openFileInDetailsPane({ page, baseUrl: uiBaseUrl, sessionId, filePath: eligiblePath });

      // The file details surface is open and editable; the assertions below
      // validate the rich editor mount and persisted markdown behavior.
      await expect(firstVisibleDetailsByTestId(page, 'file-details-edit')).toBeVisible({ timeout: 120_000 });

      // Enter edit mode. With markdownDefaultEditMode='rich' and the file
      // eligible, the rich surface mounts (file-details-rich-editor).
      await firstVisibleDetailsByTestId(page, 'file-details-edit').click({ force: true });
      const richEditor = firstVisibleDetailsByTestId(page, 'file-details-rich-editor');
      await expect(richEditor).toBeVisible({ timeout: 120_000 });

      // The edit-mode control is the repurposed view dropdown (markdown-edit-mode-menu);
      // Rich is the active mode (the rich surface mounted above).
      await expect(firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu')).toBeVisible({
        timeout: 60_000,
      });

      // Toggle to Raw and back to Rich; no data loss is asserted via the final
      // on-disk content below (flush + reseed on every toggle, R-A6). The dropdown
      // portals its options to the body, so the option testIDs are page-scoped.
      await firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu').click({ force: true });
      await page.getByTestId('dropdown-option-raw').click();
      const rawEditor = firstVisibleDetailsByTestId(page, 'file-details-editor');
      await expect(rawEditor).toBeVisible({ timeout: 60_000 });

      // Type an appended line in raw mode (Monaco), the most deterministic way to
      // make a precise on-disk assertion across the rich<->raw round-trip.
      const monacoRoot = rawEditor.locator('.monaco-editor');
      await expect(monacoRoot).toHaveCount(1, { timeout: 60_000 });
      const monacoInput = monacoRoot.locator('textarea');
      if (await monacoInput.count()) {
        await monacoInput.first().click({ force: true });
      } else {
        await monacoRoot.click({ force: true, position: { x: 60, y: 40 } });
      }
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\nAppended by e2e.');

      // Switch back to Rich; the rich surface must remount with the latest text
      // (no character loss across the toggle).
      await firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu').click({ force: true });
      await page.getByTestId('dropdown-option-rich').click();
      await expect(firstVisibleDetailsByTestId(page, 'file-details-rich-editor')).toBeVisible({ timeout: 60_000 });

      await expect(richEditor.locator('.ProseMirror')).toContainText('Appended by e2e.');
      await richEditor.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Rich draft survives lazy remount.');
      await firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu').click({ force: true });
      await page.getByTestId('dropdown-option-raw').click();
      await expect(rawEditor).toBeVisible({ timeout: 60_000 });
      await firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu').click({ force: true });
      await page.getByTestId('dropdown-option-rich').click();
      await expect(richEditor.locator('.ProseMirror')).toContainText('Rich draft survives lazy remount.');
      await expect(richEditor.locator('.ProseMirror')).toContainText('Appended by e2e.');

      // Save and assert the on-disk content contains the original eligible
      // markdown plus the appended line (no clobber / no lost edit).
      await firstVisibleDetailsByTestId(page, 'file-details-save').click({ force: true });

      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 120_000 })
        .toContain('Appended by e2e.');
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Rich draft survives lazy remount.');
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Hello');

      // After save, the file details surface remains available.
      await expect(firstVisibleDetailsByTestId(page, 'file-details-edit')).toBeVisible({ timeout: 120_000 });

      // --- Ineligible file: raw fallback + disabled-reason banner, no rich surface ---
      const eligibleTabClose = page.getByTestId(`session-details-tab-close-${toTestIdSafeValue(`file:${eligiblePath}`)}`);
      if (await eligibleTabClose.count()) {
        await eligibleTabClose.click({ force: true });
      }
      await openFileInDetailsPane({ page, baseUrl: uiBaseUrl, sessionId, filePath: ineligiblePath });
      await expect(firstVisibleDetailsByTestId(page, 'file-details-edit')).toBeVisible({ timeout: 120_000 });

      await firstVisibleDetailsByTestId(page, 'file-details-edit').click({ force: true });

      // The ineligible file must fall back to the raw editor; the rich surface
      // must NOT mount.
      await expect(firstVisibleDetailsByTestId(page, 'file-details-editor')).toBeVisible({ timeout: 120_000 });
      await expect(visibleDetailsByTestId(page, 'file-details-rich-editor')).toHaveCount(0, { timeout: 30_000 });

      // The edit-mode dropdown shows with Rich DISABLED (the gate blocks
      // reference-link files): opening the menu reveals a disabled Rich option
      // (the reason is surfaced as that option's subtitle).
      await expect(firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu')).toBeVisible({
        timeout: 60_000,
      });
      await firstVisibleDetailsByTestId(page, 'markdown-edit-mode-menu').click({ force: true });
      await expect(page.getByTestId('dropdown-option-rich')).toBeDisabled({ timeout: 60_000 });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    }
  });

  test('formats text in the rich (TipTap) surface via the toolbar and writes the formatting to disk', async ({
    page,
  }) => {
    test.setTimeout(MARKDOWN_EDITOR_E2E_TIMEOUT_MS);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't2-markdown-rich-formatting'));
    await mkdir(testDir, { recursive: true });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await daemon?.stop().catch(() => {});
      daemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        initialUiGotoTimeoutMs: 180_000,
        initialUiReadyTimeoutMs: 180_000,
        terminalConnectUrlTimeoutMs: 180_000,
        daemonStartupTimeoutMs: 180_000,
        extraEnv: {
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-formatting`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-formatting`,
        },
      });

      // The experiment flag is account-scoped; re-assert it here because each
      // Playwright test gets a fresh browser context.
      await enableMarkdownRichEditorInSettings({ baseUrl: uiBaseUrl, page });

      // Seed a fresh repo + eligible markdown file for this scenario so the
      // on-disk assertions are independent of the first test's edits.
      const repoDir = resolve(join(testDir, 'repo'));
      await initGitRepo({ repoDir });
      const eligiblePath = 'README.md';
      await writeFile(resolve(join(repoDir, eligiblePath)), FORMATTING_MARKDOWN, 'utf8');
      execGit(repoDir, ['add', eligiblePath]);
      execGit(repoDir, ['commit', '-m', 'chore: seed markdown formatting fixture']);

      const sessionId = await spawnSessionFromDaemon({ daemon, directory: repoDir });

      // --- Eligible file: preview -> Edit -> rich surface mounts ---
      await openFileInDetailsPane({ page, baseUrl: uiBaseUrl, sessionId, filePath: eligiblePath });
      await expect(firstVisibleDetailsByTestId(page, 'file-details-edit')).toBeVisible({ timeout: 120_000 });

      await firstVisibleDetailsByTestId(page, 'file-details-edit').click({ force: true });
      const richEditor = firstVisibleDetailsByTestId(page, 'file-details-rich-editor');
      await expect(richEditor).toBeVisible({ timeout: 120_000 });

      // The TipTap web surface renders a real `.ProseMirror` contenteditable
      // inside the rich panel. Scope to the rich-editor testID so we never pick
      // up an unrelated ProseMirror surface elsewhere on the page.
      const proseMirror = richEditor.locator('.ProseMirror');
      await expect(proseMirror).toHaveCount(1, { timeout: 60_000 });
      await proseMirror.click();

      // Move to the very end of the document, then start a fresh paragraph so
      // the formatting we apply doesn't disturb the seeded eligible markdown.
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');

      // 1) Bold: type a word, select it back to the line start, toggle bold via
      //    the toolbar chip. `@tiptap/markdown` serializes a bold mark as
      //    `**...**`, which we assert on disk below.
      const boldWord = 'BoldByE2E';
      await page.keyboard.type(boldWord);
      await page.keyboard.press('Shift+Home');
      await firstVisibleDetailsByTestId(page, 'file-details-rich-editor-toolbar:bold').click({ force: true });

      // 2) List: start a new line, type an item, toggle a bullet list via the
      //    toolbar chip. TipTap can preserve the active bold mark across the
      //    caret transition, so the disk assertion below checks the stable
      //    toolbar contract (a persisted list marker) rather than the incidental
      //    mark state of the list text.
      await page.keyboard.press('ArrowRight');
      await firstVisibleDetailsByTestId(page, 'file-details-rich-editor-toolbar:bold').click({ force: true });
      await page.keyboard.press('Enter');
      const listItem = 'ListItemByE2E';
      await page.keyboard.type(listItem);
      await firstVisibleDetailsByTestId(page, 'file-details-rich-editor-toolbar:bulletList').click({
        force: true,
      });

      // 3) Heading: start a new line, type text, apply H1 via the toolbar chip.
      //    Serializes as a leading `# `; the heading text may still carry the
      //    active bold mark, which is orthogonal to the block-format contract.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      const headingText = 'HeadingByE2E';
      await page.keyboard.type(headingText);
      await firstVisibleDetailsByTestId(page, 'file-details-rich-editor-toolbar:heading1').click({
        force: true,
      });

      // Save and assert the on-disk markdown reflects the toolbar formatting:
      // a bold span (`**...**`), a bullet-list marker (`- `), and an H1 (`# `).
      await firstVisibleDetailsByTestId(page, 'file-details-save').click({ force: true });

      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 120_000 })
        .toContain(`**${boldWord}**`);
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toMatch(new RegExp(`- (?:\\*\\*)?(?:${boldWord}|${listItem})(?:\\*\\*)?`));
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toMatch(new RegExp(`# (?:\\*\\*)?${headingText}(?:\\*\\*)?`));

      // The original seeded content must survive the rich round-trip (no clobber).
      await expect
        .poll(async () => await readFile(resolve(join(repoDir, eligiblePath)), 'utf8'), { timeout: 60_000 })
        .toContain('Hello formatting seed.');

      // After save, the file details surface remains available.
      await expect(firstVisibleDetailsByTestId(page, 'file-details-edit')).toBeVisible({ timeout: 120_000 });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    }
  });
});
