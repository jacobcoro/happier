export function isCodexAppServerTerminalOwnedGroupRecoveryClassification(
  classification: Readonly<{
    kind: string;
    groupId: string | null;
    profileId: string | null;
  }>,
): boolean {
  return classification.kind !== 'account_changed'
    && classification.kind !== 'capacity'
    && typeof classification.groupId === 'string'
    && classification.groupId.length > 0
    && typeof classification.profileId === 'string'
    && classification.profileId.length > 0;
}
