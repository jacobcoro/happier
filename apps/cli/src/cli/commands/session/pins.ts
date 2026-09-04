import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';

/**
 * Reads the account's pinned sessions back from the server, so a caller can verify a pin landed
 * instead of trusting the write response.
 */
export async function cmdSessionPins(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_pins', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.pins.list',
    {},
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_pins',
        error: {
          code: normalized.errorCode,
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const pins = ((normalized.data as any)?.pins ?? []) as readonly { sessionId: string; pinnedAt: number }[];

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_pins', data: { pins } });
    return;
  }

  if (pins.length === 0) {
    console.log('No pinned sessions.');
    return;
  }
  for (const pin of pins) {
    console.log(pin.sessionId);
  }
}
