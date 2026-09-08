import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { withTimeout } from '@/utils/timing/time';

/**
 * Native font registration reaches a platform boundary that can stall without ever rejecting, and
 * `SplashScreen.preventAutoHideAsync()` has already armed the splash by the time we get here — an
 * unbounded await there is a splash-forever bug, not a slow boot. The bound is deliberately far
 * above any healthy load (measured healthy loads are tens of milliseconds) so it only ever fires
 * on a genuine stall.
 */
export const APP_BOOT_FONT_LOAD_TIMEOUT_MS = 6_000;

/**
 * The keychain read has the same stall shape. Missing this deadline does NOT mean "signed out":
 * the read stays in flight and the session is applied when it lands (see `authGeneration`).
 */
export const APP_BOOT_CREDENTIAL_RESOLUTION_TIMEOUT_MS = 8_000;

/**
 * The warm cache's at-rest key is a second keystore read, so it runs alongside the credential read
 * rather than after it and normally costs nothing on top. The bound only matters if the keystore
 * stalls on this read but not on the credential one: missing it means this boot hydrates nothing
 * and paints cold, never that boot waits.
 */
export const APP_BOOT_WARM_CACHE_KEY_TIMEOUT_MS = 3_000;

export type AppBootReadyState = Readonly<{
    credentials: AuthCredentials | null;
    /**
     * `0` for the normal boot. Incremented only when a credential read that missed its deadline
     * lands afterwards, so the auth tree can adopt the recovered session.
     */
    authGeneration: number;
}>;

export type AppBootSequence = Readonly<{
    loadFonts: () => Promise<unknown>;
    sodiumReady: PromiseLike<unknown>;
    resolveCredentials: () => Promise<AuthCredentials | null>;
    /**
     * Resolves the warm cache's at-rest key. Sync restore reads that cache synchronously, so this
     * has to have settled before `restoreSync` runs or the boot hydrates nothing.
     */
    prepareWarmCache: () => Promise<unknown>;
    /** Authoritative user input must be loaded before any synchronous reader can mount. */
    prepareSessionDrafts: () => Promise<void>;
    restoreSync: (credentials: AuthCredentials) => Promise<unknown>;
    onReady: (state: AppBootReadyState) => void;
    fontLoadTimeoutMs?: number;
    credentialResolutionTimeoutMs?: number;
    warmCacheKeyTimeoutMs?: number;
}>;

type CredentialOutcome = Readonly<{ credentials: AuthCredentials | null }>;

function start<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return operation();
    } catch (error) {
        return Promise.reject(error);
    }
}

async function restoreSyncWithoutBlockingBoot(
    sequence: AppBootSequence,
    credentials: AuthCredentials,
): Promise<void> {
    try {
        await sequence.restoreSync(credentials);
    } catch (error) {
        // Preserve app usability even if sync restore fails during boot.
        console.error('Failed to restore sync during init, continuing startup:', error);
    }
}

/**
 * Owns everything that gates the app's first paint.
 *
 * Fonts, the libsodium runtime and the credential read have no dependency on each other, yet they
 * used to run as one `await` chain, so the gate cost their sum. They now start together and the gate
 * costs their maximum. The two legs that reach a stallable system boundary are additionally bounded,
 * because an unbounded await behind an armed splash screen is unrecoverable for the user.
 *
 * Degradation rules:
 * - fonts miss their deadline -> boot with platform fallback fonts; the load stays in flight and
 *   applies to text mounted afterwards.
 * - the credential read misses its deadline -> boot unauthenticated **without** discarding the
 *   session: the same in-flight read is still awaited, and if it yields credentials they are
 *   restored and published with a bumped `authGeneration`.
 * - the warm cache key misses its deadline -> paint cold; the cache is derived state and the key
 *   applies to whatever is written after it lands.
 *
 * Sync restore stays on the critical path on purpose: the warm cache is what makes the first frame
 * show real content instead of an empty list, so trading it for an earlier empty frame is a
 * regression, not an optimisation.
 */
export async function runAppBootSequence(sequence: AppBootSequence): Promise<void> {
    const fontLoadTimeoutMs = sequence.fontLoadTimeoutMs ?? APP_BOOT_FONT_LOAD_TIMEOUT_MS;
    const credentialResolutionTimeoutMs =
        sequence.credentialResolutionTimeoutMs ?? APP_BOOT_CREDENTIAL_RESOLUTION_TIMEOUT_MS;
    const warmCacheKeyTimeoutMs = sequence.warmCacheKeyTimeoutMs ?? APP_BOOT_WARM_CACHE_KEY_TIMEOUT_MS;

    // Every leg starts here, at t0, so each deadline measures wall clock from boot rather than from
    // whenever the previous leg happened to finish.
    const fontsLoaded = start(sequence.loadFonts).then(
        () => {},
        (error: unknown) => {
            // Font loading failures should not brick startup.
            console.error('Failed to load fonts during init, continuing startup:', error);
        },
    );
    const credentialsResolved: Promise<CredentialOutcome | null> = start(sequence.resolveCredentials).then(
        (credentials) => ({ credentials }),
        (error: unknown) => {
            console.error('Failed to resolve credentials during init, continuing startup:', error);
            // A rejected read is a definitive answer for this boot; only a missed deadline is retried.
            return { credentials: null };
        },
    );
    const warmCacheReady = start(sequence.prepareWarmCache).then(
        () => {},
        (error: unknown) => {
            // No key means a cold boot, which the cache is designed to survive.
            console.error('Failed to prepare the warm cache key during init, continuing startup:', error);
        },
    );
    const sodiumReady = Promise.resolve(sequence.sodiumReady);

    // `fontsLoaded` / `credentialsResolved` never reject, so the only rejection either race can
    // produce is its own `AsyncTimeoutError`; both are attached now so a deadline that fires before
    // it is awaited cannot surface as an unhandled rejection.
    const fontGate = withTimeout(fontsLoaded, fontLoadTimeoutMs, 'app font load').catch((error: unknown) => {
        console.error('Font loading missed its boot deadline, continuing startup:', error);
    });
    const credentialGate = withTimeout(
        credentialsResolved,
        credentialResolutionTimeoutMs,
        'boot credential resolution',
    ).catch((error: unknown) => {
        console.error('Credential read missed its boot deadline, continuing startup:', error);
        return null;
    });
    const warmCacheGate = withTimeout(warmCacheReady, warmCacheKeyTimeoutMs, 'warm cache key').catch(
        (error: unknown) => {
            console.error('Warm cache key missed its boot deadline, painting cold:', error);
        },
    );

    // Unlike the disposable warm cache, drafts cannot degrade to an empty snapshot on failure.
    // Attach this await immediately so a rejected storage open reaches the boot recovery owner.
    await start(sequence.prepareSessionDrafts);

    let gatedCredentials: CredentialOutcome | null = null;
    try {
        gatedCredentials = await credentialGate;
        await sodiumReady;
    } catch (error) {
        console.error('Error initializing:', error);
    }

    const initialCredentials = gatedCredentials?.credentials ?? null;
    if (initialCredentials) {
        // Restore reads the warm cache synchronously, so the key has to be settled first.
        await warmCacheGate;
        await restoreSyncWithoutBlockingBoot(sequence, initialCredentials);
    }
    await fontGate;
    sequence.onReady({ credentials: initialCredentials, authGeneration: 0 });

    if (gatedCredentials) return;

    // The keychain missed its deadline. The app is already interactive, so keep waiting on the same
    // read: a slow keychain must become a late sign-in, never a silent sign-out.
    const deferredCredentials = (await credentialsResolved)?.credentials ?? null;
    if (!deferredCredentials) return;
    await restoreSyncWithoutBlockingBoot(sequence, deferredCredentials);
    sequence.onReady({ credentials: deferredCredentials, authGeneration: 1 });
}
