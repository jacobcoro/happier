import { describe, expect, it } from 'vitest';
import { summarizeToolInputForNotification } from './agentRequestNotificationContent.js';

describe('request notification details', () => {
  it.each([
    ['ExitPlanMode', { name: 'Migration', overview: 'Preserve existing data', plan: '1. Back up\n2. Apply migration' }, ['Migration', 'Preserve existing data', '1. Back up', '2. Apply migration']],
    ['AcpHistoryImport', { note: 'History differs. Importing may duplicate messages.', reason: 'no_overlap' }, ['History differs. Importing may duplicate messages.']],
    ['WebFetch', { url: 'https://example.test/documentation' }, ['https://example.test/documentation']],
    ['WebSearch', { query: 'How to migrate SQLite data' }, ['How to migrate SQLite data']],
  ])('includes the supplied context for %s', (toolName, toolInput, expected) => {
    const details = summarizeToolInputForNotification(toolName, toolInput);
    for (const text of expected) expect(details).toContain(text);
  });

  it('retains all arguments in script arrays', () => {
    expect(summarizeToolInputForNotification('Execute', { script: ['git', 'diff', '--stat'] })).toBe('Command: git diff --stat');
  });

  it('uses localized labels without replacing the agent-provided contents', () => {
    expect(summarizeToolInputForNotification('Bash', { command: 'git diff --stat' }, {
      command: 'Commande',
    })).toBe('Commande: git diff --stat');
  });

  it('retains complete Windows paths and rationale without dumping unknown input fields', () => {
    expect(summarizeToolInputForNotification('Edit', {
      file_path: 'C:\\Users\\alice\\work\\project\\src\\main.ts',
      rationale: 'Apply the reviewed change',
      unknownInternalField: 'opaque data',
    })).toBe('File: C:\\Users\\alice\\work\\project\\src\\main.ts\nApply the reviewed change');
  });
});
