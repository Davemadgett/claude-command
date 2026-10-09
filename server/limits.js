import { execFileSync } from 'node:child_process';

/**
 * Plan limits — the meter Claude Code shows under /status → Usage.
 *
 * Everything else in this board's Usage tab is derived from transcripts on
 * disk: exact token counts, but no idea how much of the plan they consumed.
 * That number lives only on Anthropic's side, and Claude Code asks for it the
 * same way this does — GET /api/oauth/usage with the OAuth token it stores in
 * the login keychain.
 *
 * Read-only, and deliberately no token refresh: the credential is Claude
 * Code's, and racing it over a refresh could log the whole machine out. When
 * the access token expires we report that and wait — any running session
 * refreshes it within the hour and writes the new one back to the keychain,
 * where the next poll picks it up.
 */

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The upstream figure moves in minutes, not seconds; the panel polls far faster than this. */
const TTL_MS = 60_000;
const FAIL_TTL_MS = 15_000; // retry sooner after a failure, but still not per-request

let cache = null; // { at, value }

/**
 * The OAuth credential Claude Code keeps in the login keychain.
 *
 * `security` inherits this process's keychain access, so the read is silent
 * for a server started by the same user — and simply fails, rather than
 * prompting, for one that isn't.
 */
function readCredential() {
  const raw = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('no Claude Code credential in the keychain');
  return oauth;
}

/**
 * One limit row, shaped for display.
 *
 * The API returns a `limits` array rather than fixed keys, so new limits (a
 * per-model cap, a promo window) appear on the wall without a code change —
 * which is why this maps whatever comes back instead of naming the ones we
 * know about today.
 */
function row(l) {
  const model = l.scope?.model?.display_name ?? null;
  const surface = l.scope?.surface?.display_name ?? null;
  const scope = [model, surface].filter(Boolean).join(' · ') || null;

  return {
    kind: l.kind ?? 'unknown',
    group: l.group ?? 'other',
    // `percent` is what /status renders; `utilization` is the same number with
    // decimals, kept for the ones that report it.
    percent: typeof l.percent === 'number' ? l.percent : null,
    severity: l.severity ?? 'normal',
    resetsAt: l.resets_at ?? null,
    scope,
    // True on the limit currently being drawn down. More than one can be
    // inactive and still worth showing — an untouched weekly cap is news.
    isActive: Boolean(l.is_active),
    label:
      l.kind === 'session'
        ? 'Current session'
        : l.kind === 'weekly_all'
          ? 'Current week (all models)'
          : scope
            ? `Current week (${scope})`
            : 'Current week',
  };
}

async function fetchLimits() {
  const cred = readCredential();

  if (cred.expiresAt && Date.now() >= cred.expiresAt) {
    return {
      ok: false,
      reason: 'The stored Claude Code login has expired. Any running session will renew it.',
      limits: [],
      extra: null,
      plan: cred.subscriptionType ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason: 'Anthropic rejected the stored login. Run `claude` once to sign in again.',
      limits: [],
      extra: null,
      plan: cred.subscriptionType ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);

  const d = await res.json();
  const limits = Array.isArray(d.limits) ? d.limits.map(row) : [];

  // Pay-as-you-go credits past the plan. Only interesting once it is switched
  // on — otherwise it is a row that says nothing every time you look at it.
  const eu = d.extra_usage;
  const extra =
    eu?.is_enabled
      ? {
          usedCredits: eu.used_credits ?? 0,
          monthlyLimit: eu.monthly_limit ?? null,
          utilization: eu.utilization ?? 0,
          currency: eu.currency ?? 'USD',
          decimalPlaces: eu.decimal_places ?? 2,
          spendLimitReached: Boolean(eu.spend_limit_reached),
        }
      : null;

  return {
    ok: true,
    reason: null,
    limits,
    extra,
    plan: cred.subscriptionType ?? null,
    tier: cred.rateLimitTier ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Cached read. A failure is cached too, briefly — a machine that is offline
 * should not spend a keychain read and an 8-second timeout on every poll.
 */
export async function getLimits() {
  const ttl = cache?.value?.ok === false ? FAIL_TTL_MS : TTL_MS;
  if (cache && Date.now() - cache.at < ttl) return cache.value;

  let value;
  try {
    value = await fetchLimits();
  } catch (e) {
    value = {
      ok: false,
      reason: `Could not read the plan meter: ${e.message}`,
      limits: [],
      extra: null,
      plan: null,
      fetchedAt: new Date().toISOString(),
    };
  }
  cache = { at: Date.now(), value };
  return value;
}
