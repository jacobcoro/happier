import { isAskUserQuestionToolName, normalizeStructuredQuestionDescriptors } from '../tools/structuredQuestionAnswersV1.js';
import { extractFilePathLike } from './agentRequestSummary.js';
import { extractShellCommand } from './shellCommand.js';
import { maybeParseJson } from './parseJson.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type RequestNotificationLabels = Readonly<{
  command: string;
  file: string;
  selectOne: string;
  selectMultiple: string;
  customAnswer: string;
  localMessages: string;
  remoteMessages: string;
}>;

const defaultLabels: RequestNotificationLabels = {
  command: 'Command', file: 'File', selectOne: 'Select one',
  selectMultiple: 'Select multiple', customAnswer: 'Custom answer allowed',
  localMessages: 'Local messages', remoteMessages: 'Remote messages',
};

/** Human-readable request context shared by device, push, and webhook notifications. */
export function summarizeToolInputForNotification(toolName: string, toolInput: unknown, labels?: Partial<RequestNotificationLabels>): string | null {
  const display = { ...defaultLabels, ...labels };
  const input = maybeParseJson(toolInput);
  const record = asRecord(input);
  if (isAskUserQuestionToolName(toolName)) {
    const normalized = normalizeStructuredQuestionDescriptors(record?.questions);
    if (!normalized.ok) return null;
    return normalized.questions.map((question) => [
      question.header && question.header !== question.question ? question.header : null,
      question.question ?? question.header,
      question.options.length ? question.multiSelect ? display.selectMultiple : display.selectOne : null,
      ...question.options.map((option) => `• ${option.label}${option.description ? ` — ${option.description}` : ''}`),
      question.allowsFreeform ? display.customAnswer : null,
      question.freeform?.description,
      question.freeform?.placeholder,
    ].filter(Boolean).join('\n')).join('\n\n');
  }
  const tool = toolName.trim().toLowerCase();
  const actionDetails: Array<string | null> = [];
  if (tool === 'exitplanmode' || tool === 'exit_plan_mode') {
    actionDetails.push(text(record?.name), text(record?.overview), text(record?.plan));
  } else if (tool === 'acphistoryimport') {
    actionDetails.push(text(record?.note));
    if (typeof record?.localCount === 'number') actionDetails.push(`${display.localMessages}: ${record.localCount}`);
    if (typeof record?.remoteCount === 'number') actionDetails.push(`${display.remoteMessages}: ${record.remoteCount}`);
  } else if (tool === 'webfetch' || tool === 'web_fetch') {
    actionDetails.push(text(record?.url));
  } else if (tool === 'websearch' || tool === 'web_search') {
    actionDetails.push(text(record?.query));
  }
  const permission = asRecord(record?.permission);
  const command = extractShellCommand(input) ?? extractShellCommand({ command: record?.script });
  const path = extractFilePathLike(input);
  const details = [
    ...actionDetails,
    text(permission?.title) ?? text(record?.title),
    command ? `${display.command}: ${command}` : null,
    path ? `${display.file}: ${path}` : null,
    text(permission?.description) ?? text(record?.description),
    text(permission?.justification) ?? text(record?.justification),
    text(permission?.reason) ?? text(record?.reason),
    text(permission?.rationale) ?? text(record?.rationale),
  ].filter((value): value is string => value !== null);
  return [...new Set(details)].join('\n') || null;
}
