import type { PermissionMode } from '@/api/types';
import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';

export type SessionPermissionRpcPayload = {
  id: string;
  approved: boolean;
  decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  reason?: string;
  mode?: PermissionMode;
  allowedTools?: string[];
  allowTools?: string[];
  updatedPermissions?: unknown;
  execPolicyAmendment?: {
    command: string[];
  };
  answers?: Record<string, string>;
  structuredAnswersV1?: StructuredQuestionAnswersV1;
  receivedAt?: number;
};
