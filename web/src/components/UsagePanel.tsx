import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PlanLimit, PlanLimits, Usage, UsageHistory, UsageSession } from '../types';

/** Fast enough to watch a session work, slow enough to be free. */
const POLL_MS = 5000;

/** The plan meter is a network round-trip and moves in minutes, not seconds. */
const LIMITS_POLL_MS = 60_000;

/** History moves by the week. The server caches it for a minute anyway. */
const HISTORY_POLL_MS = 60_000;

/** As far back as the transcripts go, plus room for them to go further. */
const HISTORY_WEEKS = 9;

const SOURCE_LABEL: Record<string, string> = {
  manual: 'you set this',
  cwd: 'from folder',
  files: 'from files',
  prompt: 'from a prompt',
  board: 'board default',
};

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function money(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return n > 0 ? `$${n.toFixed(2)}` : '$0';
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * When a limit comes back.
 *
 * A reset later today only needs the time; one four days out needs the date,
 * and at that distance the minutes are noise.
 */
function resetLabel(iso: string): string {
  // Weekly resets land on :59:59, which truncates to the hour before and reads
  // as an hour early. Round to the nearest minute first, as /status does.
  const at = new Date(Math.round(new Date(iso).getTime() / 60_000) * 60_000);
  if (at.getTime() - Date.now() < 20 * 3600_000) {
    return `Resets ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const day = at.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = at
    .toLocaleTimeString([], at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
    .toLowerCase()
    .replace(' ', '');
  return `Resets ${day} at ${time}`;
}

/**
 * The plan meter: how much of the 5-hour and weekly allowance is gone.
 *
 * This is the one number in here that is not derived from the transcripts —
 * it comes back from Anthropic, and it is the same figure Claude Code prints
 * under /status. Everything below is tokens; this is headroom.
 */
function PlanRow({ l }: { l: PlanLimit }) {
  const pct = l.percent ?? 0;
  return (
    <div className={`u-plan-row${l.isActive ? ' active' : ''}`}>
      <div className="u-plan-label">
        {l.label}
        {l.isActive && <span className="u-plan-now">now</span>}
      </div>
      <div className={`u-plan-bar sev-${l.severity}`}>
        <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <div className="u-plan-pct">{Math.round(pct)}%</div>
      <div className="u-plan-reset">{l.resetsAt ? resetLabel(l.resetsAt) : '—'}</div>
    </div>
  );
}

function PlanMeter({ plan }: { plan: PlanLimits | null }) {
  if (!plan) return <div className="u-plan loading">Checking plan limits…</div>;

  if (!plan.ok || plan.limits.length === 0) {
    return (
      <div className="u-plan">
        <div className="u-quiet">{plan.reason ?? 'Anthropic did not report any plan limits.'}</div>
      </div>
    );
  }

  return (
    <div className="u-plan">
      {plan.limits.map((l) => (
        <PlanRow key={`${l.kind}-${l.scope ?? ''}`} l={l} />
      ))}
      {plan.extra && (
        <div className="u-plan-extra">
          Extra usage on: {plan.extra.currency}{' '}
          {plan.extra.usedCredits.toFixed(plan.extra.decimalPlaces)} used
          {plan.extra.spendLimitReached && ' — spend limit reached'}
        </div>
      )}
    </div>
  );
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** "Fridays at 6pm" — the boundary every bar in the chart is cut on. */
function boundaryLabel(iso: string): string {
  const at = new Date(iso);
  const time = at
    .toLocaleTimeString([], at.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' })
    .toLowerCase()
    .replace(' ', '');
  return `${WEEKDAY[at.getDay()]}s at ${time}`;
}

/**
 * Spend by the plan's week, as far back as the transcripts reach.
 *
 * The bars are cut on the subscription's reset, not on Sunday midnight, because
 * a plan week is the thing you actually run out of. The current week is drawn
 * short — it hasn't finished — with a hollow cap showing where this pace lands
 * by Friday and a tick marking where last week stood at this same hour. Without
 * those two marks a Monday bar looks like a quiet week every single Monday.
 */
function WeeklyChart({ history }: { history: UsageHistory | null }) {
  if (!history) return <div className="u-weeks loading">Reading the full history…</div>;

  // A week before you had any transcripts is not a quiet week, it is no data.
  // Drop the empty run at the front rather than drawing zeroes.
  const first = history.weeks.findIndex((w) => w.tokens > 0);
  const weeks = first === -1 ? [] : history.weeks.slice(first);
  if (weeks.length === 0) {
    return <div className="u-quiet">No transcripts to chart yet.</div>;
  }

  const { pace } = history;
  const current = weeks[weeks.length - 1];
  const prior = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const projected = pace.projectedTokens ?? 0;
  const scale = Math.max(1, ...weeks.map((w) => w.tokens), projected);
  const height = (n: number) => `${Math.max(1, (n / scale) * 100)}%`;

  return (
    <>
      <div className="u-weeks">
        {weeks.map((w) => {
          const range = `${shortDate(w.start)} – ${shortDate(w.end)}`;
          return (
            <div className={`u-week${w.current ? ' current' : ''}`} key={w.start}>
              <div className="u-week-n">{w.tokens > 0 ? tokens(w.tokens) : '—'}</div>
              <div
                className="u-week-bar"
                title={
                  `${range}\n${tokens(w.tokens)} · ${money(w.cost)} · ` +
                  `${w.requests.toLocaleString()} requests` +
                  (w.current ? '\nthis week, still running' : `\nby this hour: ${tokens(w.toDate.tokens)}`)
                }
              >
                {w.current && projected > w.tokens && (
                  <span className="proj" style={{ height: height(projected) }} />
                )}
                <span className="fill" style={{ height: height(w.tokens) }} />
                {w.current && prior && prior.toDate.tokens > 0 && (
                  <span
                    className="mark"
                    style={{ bottom: height(prior.toDate.tokens) }}
                    title={`Last week by this hour: ${tokens(prior.toDate.tokens)}`}
                  />
                )}
              </div>
              <div className="u-week-l">{shortDate(w.start)}</div>
            </div>
          );
        })}
      </div>

      <div className="u-weeks-legend">
        <span>
          <b>{tokens(current.tokens)}</b> ({money(current.cost)}) so far this week,{' '}
          {Math.round(pace.elapsed * 100)}% through it
        </span>
        {pace.vsPrior != null && (
          <span className={pace.vsPrior > 0 ? 'up' : 'down'}>
            {pace.vsPrior > 0 ? '▲' : '▼'} {Math.abs(pace.vsPrior)}% vs. last week at this hour
          </span>
        )}
        {pace.projectedTokens != null && (
          <span className="dim">
            on pace for {tokens(pace.projectedTokens)} by {shortDate(current.end)}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * A bar with an honest scale.
 *
 * These are token bars, and tokens have no ceiling to draw against — the plan
 * meter above is a percentage of an allowance, not of a token count, and the
 * two do not convert. So every bar here is drawn against the heaviest
 * equivalent stretch of the last week instead. It answers "is this a lot, for
 * me", which is a question this data can actually answer.
 */
function Meter({ value, peak }: { value: number; peak: number }) {
  const pct = peak > 0 ? Math.min(100, (value / peak) * 100) : 0;
  return (
    <div className="u-meter">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="u-spark" title="Tokens per 5 minutes, last hour">
      {values.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function LiveRow({ s }: { s: UsageSession }) {
  return (
    <div className="u-live-row">
      <span className={`u-dot${s.live ? ' on' : ''}`} title={s.live ? 'Running on this board' : 'Not started from this board'} />
      {s.label ? (
        s.labelUrl ? (
          <a className="badge label" href={s.labelUrl} target="_blank" rel="noreferrer">
            {s.label}
          </a>
        ) : (
          <span className="badge label">{s.label}</span>
        )
      ) : (
        <span className="badge">{s.project}</span>
      )}
      <span className="u-live-title" title={s.title}>
        {s.title}
      </span>
      <Spark values={s.spark} />
      <span className="u-rate">{tokens(s.tokensPerMin)}/min</span>
      <span className="u-rate dim">{money(s.costPerHour)}/hr</span>
    </div>
  );
}

/**
 * What the sessions are spending, live.
 *
 * Deliberately two halves. The top is the question you open this for — how hard
 * is the machine working right now, and which session is doing it — and it
 * moves on its own every few seconds. The bottom is the question you ask once a
 * week: where did it all go. Same numbers, different clocks.
 */
export function UsagePanel() {
  const [data, setData] = useState<Usage | null>(null);
  const [plan, setPlan] = useState<PlanLimits | null>(null);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [paused, setPaused] = useState(false);
  // Kept out of state: a refresh in flight must not queue another one behind it.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await api.usage(days));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [days]);

  /**
   * Never throws into the panel: the plan meter failing is its own small
   * problem, and the token counts below it are still perfectly good.
   */
  const loadPlan = useCallback(async () => {
    try {
      setPlan(await api.limits());
    } catch (e) {
      setPlan({
        ok: false,
        reason: (e as Error).message,
        limits: [],
        extra: null,
        plan: null,
        fetchedAt: new Date().toISOString(),
      });
    }
  }, []);

  /**
   * Also never throws. The first call reads every transcript on the machine and
   * takes a few seconds; the chart says so until it lands.
   */
  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.history(HISTORY_WEEKS));
    } catch {
      // Leave whatever was drawn last. A missing week chart is not worth an
      // error banner over a panel whose live half is working.
    }
  }, []);

  const refresh = useCallback(() => {
    load();
    loadPlan();
    loadHistory();
  }, [load, loadPlan, loadHistory]);

  useEffect(() => {
    load();
    if (paused) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, paused]);

  useEffect(() => {
    loadPlan();
    if (paused) return;
    const id = setInterval(loadPlan, LIMITS_POLL_MS);
    return () => clearInterval(id);
  }, [loadPlan, paused]);

  useEffect(() => {
    loadHistory();
    if (paused) return;
    const id = setInterval(loadHistory, HISTORY_POLL_MS);
    return () => clearInterval(id);
  }, [loadHistory, paused]);

  // The plan meter is one round-trip and the transcript scan is hundreds of
  // megabytes, so it lands first — and it is the number most worth waiting for.
  if (!data) {
    return (
      <div className="usage">
        <div className="usage-body">
          <div className="u-section">
            <h3>Plan limits</h3>
            <PlanMeter plan={plan} />
          </div>
          <div className="pane-empty">
            {error ? (
              <>
                <div>Couldn’t read usage</div>
                <div className="hint">{error}</div>
                <button onClick={refresh}>Try again</button>
              </>
            ) : (
              <div>Reading transcripts…</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const { windows, active, byLabel, byModel, daily } = data;
  const peakDay = Math.max(1, ...daily.map((d) => d.tokens));
  const labelled = byLabel.filter((r) => r.label);
  const unattributed = byLabel.find((r) => !r.label);

  return (
    <div className="usage">
      <div className="pane-bar">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          <option value={1}>Today</option>
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
          <option value={8}>8 days</option>
        </select>
        <span>updated {clock(data.generatedAt)}</span>
        <div className="spacer" />
        {error && <span style={{ color: 'var(--danger)' }}>stale — {error}</span>}
        <label className="switch">
          <input type="checkbox" checked={!paused} onChange={(e) => setPaused(!e.target.checked)} />
          Live
        </label>
        <button className="ghost" onClick={refresh}>
          Refresh
        </button>
      </div>

      <div className="usage-body">
        <div className="u-section">
          <h3>Plan limits</h3>
          <p className="u-note">
            How much of the subscription is gone, straight from Anthropic — the same figures{' '}
            <code>/status</code> shows. This is the only part of this tab that is about headroom
            rather than tokens.
          </p>
          <PlanMeter plan={plan} />
        </div>

        <div className="u-section">
          <h3>Week over week</h3>
          <p className="u-note">
            {history?.anchorSource === 'assumed' ? (
              <>
                Seven-day blocks ending now — Anthropic has not told us when your week resets, so
                these are not aligned to it yet.
              </>
            ) : (
              <>
                Cut on your plan’s reset, {boundaryLabel(history?.anchor ?? new Date().toISOString())}
                , so each bar is one full allowance rather than a calendar week.
              </>
            )}
            {history?.coverage.from && <> Transcripts reach back to {shortDate(history.coverage.from)}.</>}
          </p>
          <WeeklyChart history={history} />
        </div>

        <div className="u-heads">
          <div className="u-head">
            <div className="l">Last 5 hours</div>
            <div className="n">{tokens(windows.fiveHour.tokens)}</div>
            <div className="c">{money(windows.fiveHour.cost)}</div>
            <Meter value={windows.fiveHour.tokens} peak={windows.fiveHour.peak} />
            <div className="s">
              {windows.fiveHour.peak > 0
                ? `${Math.round((windows.fiveHour.tokens / windows.fiveHour.peak) * 100)}% of your busiest 5 hours this week`
                : 'nothing yet'}
            </div>
          </div>

          <div className="u-head">
            <div className="l">Today</div>
            <div className="n">{tokens(windows.today.tokens)}</div>
            <div className="c">{money(windows.today.cost)}</div>
            <Meter value={windows.today.tokens} peak={windows.today.peak} />
            <div className="s">
              {windows.today.requests.toLocaleString()} requests
            </div>
          </div>

          <div className="u-head">
            <div className="l">Last {windows.week.days} days</div>
            <div className="n">{tokens(windows.week.tokens)}</div>
            <div className="c">{money(windows.week.cost)}</div>
            <div className="u-days">
              {daily.map((d) => (
                <span
                  key={d.date}
                  title={`${d.date} · ${tokens(d.tokens)} · ${money(d.cost)}`}
                  style={{ height: `${Math.max(3, (d.tokens / peakDay) * 100)}%` }}
                />
              ))}
            </div>
            <div className="s">
              {tokens(Math.round(windows.week.tokens / windows.week.days))} a day on average
            </div>
          </div>
        </div>

        <div className="u-section">
          <h3>
            Burning now
            {active.length > 0 && <span className="u-count">{active.length}</span>}
          </h3>
          <p className="u-note">
            Sessions that billed a request in the last 15 minutes. The rate is measured over the
            last {data.params.rateMinutes} minutes, so it settles rather than flickers.
          </p>
          {active.length === 0 ? (
            <div className="u-quiet">Nothing has spent a token in the last 15 minutes.</div>
          ) : (
            <div className="u-live">
              {active.map((s) => (
                <LiveRow key={s.sessionId} s={s} />
              ))}
            </div>
          )}
        </div>

        <div className="u-section">
          <h3>Where it went</h3>
          <p className="u-note">
            Attributed the same way the Time tab attributes hours — the card you set, the folder the
            session ran in, or the folder its files landed in. A session with no answer stays
            unattributed rather than being guessed at.
          </p>
          <table className="tl">
            <thead>
              <tr>
                <th>Matter</th>
                <th style={{ width: 90, textAlign: 'right' }}>Sessions</th>
                <th style={{ width: 100, textAlign: 'right' }}>Tokens</th>
                <th style={{ width: 100, textAlign: 'right' }}>~Cost</th>
              </tr>
            </thead>
            <tbody>
              {labelled.map((r) => (
                <tr key={r.label}>
                  <td>
                    {r.labelUrl ? (
                      <a href={r.labelUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 550 }}>
                        {r.label}
                      </a>
                    ) : (
                      <span style={{ fontWeight: 550 }}>{r.label}</span>
                    )}
                    {r.labelSource && (
                      <span className={`src ${r.labelSource}`}>{SOURCE_LABEL[r.labelSource]}</span>
                    )}
                  </td>
                  <td className="h dim">{r.sessions}</td>
                  <td className="h">{tokens(r.tokens)}</td>
                  <td className="h">{money(r.cost)}</td>
                </tr>
              ))}
              {unattributed && (
                <tr>
                  <td>
                    <span style={{ color: 'var(--text-faint)' }}>(unattributed)</span>
                  </td>
                  <td className="h dim">{unattributed.sessions}</td>
                  <td className="h dim">{tokens(unattributed.tokens)}</td>
                  <td className="h dim">{money(unattributed.cost)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {byLabel.length === 0 && <div className="u-quiet">No spend in this window.</div>}
        </div>

        <div className="u-section">
          <h3>By model</h3>
          <div className="u-models">
            {byModel.map((m) => (
              <div key={m.model} className="u-model">
                <div className="n">{m.model}</div>
                <div className="v">
                  {tokens(m.tokens)} · {money(m.cost)} · {m.requests.toLocaleString()} requests
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="u-fine">
          Read from the <code>usage</code> block Claude Code writes on every assistant turn, so the
          token counts are the ones Anthropic billed rather than an estimate of them. The dollar
          figures are what those tokens would cost at list API prices — cache reads at{' '}
          {data.pricing.cacheRead}×, cache writes at {data.pricing.cacheWrite5m}× and{' '}
          {data.pricing.cacheWrite1h}× the input rate — and on a subscription you did not pay them.
          They are here to compare matters against each other, not to reconcile a bill. The plan
          limits at the top are the only figures here that come from Anthropic rather than from your
          own transcripts, and they are percentages of an allowance — they do not line up with the
          token counts below, and are not meant to.
        </p>
      </div>
    </div>
  );
}
