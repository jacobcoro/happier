import { describe, expect, it } from 'vitest';

import {
    assertNonEscalatingPermissionMode,
    resolveNearestPermissionModeAtOrBelow,
    resolvePermissionPrivilegeOrdinal,
} from './privilege.js';

describe('permission privilege policy', () => {
    it.each([
        ['plan', 0],
        ['read-only', 0],
        ['read_only', 0],
        ['no_tools', 0],
        ['default', 1],
        ['acceptEdits', 2],
        ['safe-yolo', 2],
        ['workspace_write', 2],
        ['bypassPermissions', 3],
        ['yolo', 3],
    ] as const)('maps %s to privilege ordinal %s', (mode, ordinal) => {
        expect(resolvePermissionPrivilegeOrdinal(mode)).toBe(ordinal);
    });

    it('allows explicit same-or-lower requested permission modes', () => {
        expect(assertNonEscalatingPermissionMode({
            requestedMode: 'read_only',
            callerMode: 'default',
        })).toEqual({
            ok: true,
            requestedMode: 'read-only',
            requestedOrdinal: 0,
            callerMode: 'default',
            callerOrdinal: 1,
        });

        expect(assertNonEscalatingPermissionMode({
            requestedMode: 'workspace_write',
            callerMode: 'acceptEdits',
        })).toEqual({
            ok: true,
            requestedMode: 'safe-yolo',
            requestedOrdinal: 2,
            callerMode: 'safe-yolo',
            callerOrdinal: 2,
        });
    });

    it('rejects explicit escalation above the caller permission mode', () => {
        expect(assertNonEscalatingPermissionMode({
            requestedMode: 'acceptEdits',
            callerMode: 'default',
        })).toEqual({
            ok: false,
            reason: 'permission_escalation_denied',
            requestedMode: 'safe-yolo',
            requestedOrdinal: 2,
            callerMode: 'default',
            callerOrdinal: 1,
        });
    });

    it('defaults missing caller permission to default instead of bypass', () => {
        expect(assertNonEscalatingPermissionMode({
            requestedMode: 'safe-yolo',
            callerMode: undefined,
        })).toEqual({
            ok: false,
            reason: 'permission_escalation_denied',
            requestedMode: 'safe-yolo',
            requestedOrdinal: 2,
            callerMode: 'default',
            callerOrdinal: 1,
        });
    });

    it('treats the authenticated CLI surface as a full-privilege operator', () => {
        expect(assertNonEscalatingPermissionMode({
            requestedMode: 'bypassPermissions',
            callerMode: undefined,
            callerSurface: 'cli',
        })).toEqual({
            ok: true,
            requestedMode: 'yolo',
            requestedOrdinal: 3,
            callerMode: 'yolo',
            callerOrdinal: 3,
        });
    });

    it('maps omitted requests to the nearest supported same-or-lower caller mode', () => {
        expect(resolveNearestPermissionModeAtOrBelow({
            requestedMode: undefined,
            callerMode: 'bypassPermissions',
            supportedModes: ['read-only', 'default', 'safe-yolo'],
        })).toEqual({
            ok: true,
            requestedMode: 'safe-yolo',
            requestedOrdinal: 2,
            callerMode: 'yolo',
            callerOrdinal: 3,
        });

        expect(resolveNearestPermissionModeAtOrBelow({
            requestedMode: undefined,
            callerMode: undefined,
            supportedModes: ['read-only', 'safe-yolo'],
        })).toEqual({
            ok: true,
            requestedMode: 'read-only',
            requestedOrdinal: 0,
            callerMode: 'default',
            callerOrdinal: 1,
        });
    });
});
