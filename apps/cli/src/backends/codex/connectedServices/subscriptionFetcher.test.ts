import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createOpenAiCodexSubscriptionFetcher } from './subscriptionFetcher';

const now = Date.parse('2026-09-01T12:00:00Z');
const signal = new AbortController().signal;
function credential(providerAccountId: string | null = 'selected-account') {
  return buildConnectedServiceCredentialRecord({
    now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
    oauth: { accessToken: 'test-token', refreshToken: 'test-refresh', idToken: null, scope: null,
      tokenType: null, providerAccountId, providerEmail: null },
  });
}

describe('Codex subscription reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the selected account and projects only evidenced subscription fields', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      id: 'subscription-not-account', plan_type: 'pro', active_until: '2026-09-15T12:00:00Z', will_renew: false,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await createOpenAiCodexSubscriptionFetcher({ staleAfterMs: 123_000 })
      .fetch({ record: credential('selected/account'), now, signal });
    expect(result).toEqual({ observedAtMs: now, staleAfterMs: 123_000, status: 'subscribed',
      renewal: 'off', currentPeriodEndAtMs: Date.parse('2026-09-15T12:00:00Z') });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/subscriptions?account_id=selected%2Faccount',
      expect.objectContaining({ method: 'GET', signal, redirect: 'error', headers: expect.objectContaining({
        Authorization: 'Bearer test-token', Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/',
        'User-Agent': expect.stringContaining('Mozilla/5.0'),
      }) }),
    );
  });

  it.each([true, undefined, 'false'])('does not infer renewal off from %s', async (willRenew) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ active_until: '2026-09-15T12:00:00Z', will_renew: willRenew })));
    await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(), now, signal }))
      .resolves.toMatchObject({ renewal: willRenew === true ? 'on' : 'unknown' });
  });

  it.each([{}, null, { active_until: '2026-09-15' }, { active_until: 'not-a-date' }])(
    'rejects unproven empty or malformed subscription shapes', async (body) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
      await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(), now, signal }))
        .rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
    },
  );

  it('never fetches an unspecified account or a disabled private endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(null), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'missing_auth' });
    await expect(createOpenAiCodexSubscriptionFetcher({ disablePrivateEndpoint: true })
      .fetch({ record: credential(), now, signal })).resolves.toMatchObject({ status: 'unavailable', renewal: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses configured proxy and user agent while retaining explicit account selection', async () => {
    const fetchMock = vi.fn(async () => Response.json({ active_until: '2026-09-15T12:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);
    await createOpenAiCodexSubscriptionFetcher({ subscriptionUrl: 'https://proxy.example/subscriptions?account_id=wrong',
      userAgent: 'proxy-agent', disablePrivateEndpoint: true }).fetch({ record: credential(), now, signal });
    expect(fetchMock).toHaveBeenCalledWith('https://proxy.example/subscriptions?account_id=selected-account',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'proxy-agent' }) }));
  });

  it('preserves backoff metadata without reflecting the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('sensitive-body', { status: 429, headers: { 'retry-after': '30' } })));
    await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'provider_backoff', status: 429, retryAfterMs: 30_000,
        message: 'OpenAI subscription request failed' });
  });

  it('does not expose network exception details and propagates cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sensitive-token'); }));
    await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'network', message: 'OpenAI subscription request failed' });
    const controller = new AbortController();
    controller.abort();
    await expect(createOpenAiCodexSubscriptionFetcher().fetch({ record: credential(), now, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
