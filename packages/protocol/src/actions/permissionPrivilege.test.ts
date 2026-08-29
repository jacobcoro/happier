import { describe, expect, it } from 'vitest';

import { assertNonEscalatingPermissionMode } from './permissionPrivilege.js';

describe('permission privilege', () => {
  it('grants the authenticated CLI surface full caller privilege', () => {
    expect(assertNonEscalatingPermissionMode({
      requestedMode: 'yolo',
      callerMode: undefined,
      callerSurface: 'cli',
    })).toMatchObject({
      ok: true,
      requestedMode: 'yolo',
      callerMode: 'yolo',
      callerOrdinal: 3,
    });
  });

  it('keeps an unknown non-CLI caller at the default fallback', () => {
    expect(assertNonEscalatingPermissionMode({
      requestedMode: 'safe-yolo',
      callerMode: undefined,
      callerSurface: 'mcp',
    })).toMatchObject({
      ok: false,
      reason: 'permission_escalation_denied',
      callerMode: 'default',
      callerOrdinal: 1,
    });
  });
});
