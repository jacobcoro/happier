import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

/**
 * Pins or unpins one session. Both directions are idempotent at the server, so an automation can
 * pin on every rotation and unpin on every retirement without tracking what it already did.
 */
export async function cmdSessionSetPin(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
  options: Readonly<{ pinned: boolean }>,
): Promise<void> {
  const json = wantsJson(argv);
  const verb = options.pinned ? 'pin' : 'unpin';
  const envelopeKind = options.pinned ? 'session_pin' : 'session_unpin';
  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1 });
  if (!idOrPrefix) {
    throw new Error(`Usage: happier session ${verb} <session-id-or-prefix> [--json]`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: envelopeKind, error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    options.pinned ? 'session.pin' : 'session.unpin',
    { sessionId: idOrPrefix },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: envelopeKind,
        error: {
          code: normalized.errorCode,
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const result = normalized.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind, json, result })) {
    return;
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: envelopeKind,
      data: { sessionId: result.sessionId, pinned: result.pinned, pinnedAt: result.pinnedAt },
    });
    return;
  }

  console.log(chalk.green('✓'), `${options.pinned ? 'pinned' : 'unpinned'} ${result.sessionId}`);
}
