import {
  openSealedProviderAccountUsageSnapshot,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

export function openProviderAccountUsageSnapshot(
  credentials: AuthCredentials,
  sealed: SealedProviderAccountUsageSnapshotV1,
): ProviderAccountUsageSnapshotV1 | null {
  const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

  return openSealedProviderAccountUsageSnapshot({ material, sealed });
}
