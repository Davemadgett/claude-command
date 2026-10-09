import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { TerminalView } from './TerminalView';
import type { BillingRun, BillingSummary } from '../types';

const RUN_POLL_MS = 3000;
const SUMMARY_POLL_MS = 60_000;

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function hours(n: number): string {
  return `${(Math.round(n * 10) / 10).toLocaleString()}h`;
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function age(days: number | null): string {
  if (days == null) return '—';
  if (days === 0) return 'today';
  return `${days}d`;
}

const FLAG_LABEL: Record<string, string> = {
  over_budget: 'over budget',
  approved_undrawn: 'approved, never billed',
  no_member_id: 'no member id',
  no_cap: 'no cap recorded',
};

type Mode = 'session' | 'dashboard';

/**
 * The billing tab: the firm's billing brain, read whole.
 *
 * The shape follows what the MetLife project proved about this data
 * (docs/BILLING.md): the money is in two ledgers that disagree, so the
 * disagreements — bills drafted but never issued, portal cases nothing in the
 * brain can name, budgets approved and never drawn — get equal billing with
 * the balances. The one thing the panel can *do* is post approved time
 * entries, behind a confirm that is the human approval; everything else that
 * needs judgment goes through the billing agent's session, which this tab
 * owns the same way the Morning Brief tab owns its run.
 */
type Props = {
  canRun: boolean;
  canApprove: boolean;
  label: string;
  onOpenSession?: (sessionId: string) => void;
};

export function BillingPanel({ canRun, canApprove, label, onOpenSession }: Props) {
  const [data, setData] = useState<BillingSummary | null>(null);
  const [run, setRun] = useState<BillingRun | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode | null>(null); // null = follow the run
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [approveNote, setApproveNote] = useState<string | null>(null);
  const wasLive = useRef<boolean | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await api.billingSummary());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, []);

  const loadRun = useCallback(() => api.billingRun().then(setRun).catch(() => {}), []);

  useEffect(() => {
    load();
    const id = setInterval(load, SUMMARY_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    loadRun();
    const id = setInterval(loadRun, RUN_POLL_MS);
    return () => clearInterval(id);
  }, [loadRun]);

  /*
   * Follow the run, as the brief tab does: while the session is live it is
   * the thing that matters; when it ends the sweep has usually just changed
   * the numbers, so re-read them. A deliberate click on the switch overrides.
   */
  useEffect(() => {
    if (run === undefined) return;
    const live = Boolean(run?.live);
    if (wasLive.current !== null && wasLive.current !== live) {
      setMode(null);
      if (!live) load();
    }
    wasLive.current = live;
  }, [run, load]);

  /*
   * New drafts arrive pre-checked — the common case is approving the batch —
   * while a deliberate un-check survives every refresh until the draft goes.
   */
  const seenDrafts = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!data) return;
    setPicked((old) => {
      const next = new Set<number>();
      for (const d of data.drafts.rows) {
        if (!seenDrafts.current.has(d.id)) {
          seenDrafts.current.add(d.id);
          next.add(d.id);
        } else if (old.has(d.id)) {
          next.add(d.id);
        }
      }
      return next;
    });
  }, [data]);

  const start = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const started = await api.runBilling(force);
      setRun(started);
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await api.startSession(run.sessionId, { mode: 'resume', cwd: run.cwd });
      await loadRun();
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!data) return;
    const rows = data.drafts.rows.filter((d) => picked.has(d.id));
    if (!rows.length) return;
    const total = rows.reduce((n, d) => n + d.amount, 0);
    const hrs = rows.reduce((n, d) => n + (d.hours ?? 0), 0);
    const ok = confirm(
      `Post ${rows.length} time ${rows.length === 1 ? 'entry' : 'entries'} to Clio?\n\n` +
        `${hours(hrs)} · ${money(total)} across ${new Set(rows.map((d) => d.matter)).size} matter(s).\n` +
        `This is the approval — they post immediately.`
    );
    if (!ok) return;
    setBusy(true);
    setApproveNote(null);
    setError(null);
    try {
      const out = await api.billingApprove(rows.map((d) => d.id));
      const failed = out.results.filter((r) => r.error);
      setApproveNote(
        failed.length
          ? `Posted ${out.posted}; ${failed.length} failed — ${failed
              .map((f) => `#${f.draft_id}: ${f.error}`)
              .join('; ')}`
          : `Posted ${out.posted} ${out.posted === 1 ? 'entry' : 'entries'} to Clio.`
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const live = Boolean(run?.live);
  const shown: Mode = mode ?? (live ? 'session' : 'dashboard');

  const runButton = !canRun ? null : live ? (
    <button
      className="ghost"
      disabled={busy}
      title="The billing session is already running — start a second one only if this one is stuck"
      onClick={() => {
        if (confirm('The billing session is still running. Start a fresh one anyway?')) start(true);
      }}
    >
      Start over
    </button>
  ) : (
    <button className="primary" disabled={busy} onClick={() => start(false)}>
      {busy ? 'Starting…' : `Run ${label.toLowerCase()} sweep`}
    </button>
  );

  return (
    <div className="brief">
      <div className="pane-bar">
        {runButton}

        {run && (
          <div className="seg">
            <button className={shown === 'session' ? 'on' : ''} onClick={() => setMode('session')}>
              Session
            </button>
            <button className={shown === 'dashboard' ? 'on' : ''} onClick={() => setMode('dashboard')}>
              Dashboard
            </button>
          </div>
        )}

        {live && run && (
          <span className={`badge ${run.working ? 'live' : 'wait'}`}>
            <span className="pulse" />
            {run.working ? 'running' : 'waiting for your answer'}
          </span>
        )}
        {!live && run && shown === 'session' && <span className="badge exited">session ended</span>}
        {!live && run && shown === 'session' && (
          <button className="ghost" disabled={busy} onClick={resume} title="Pick the same conversation up where it left off">
            Resume
          </button>
        )}
        {run && onOpenSession && shown === 'session' && (
          <button className="ghost" onClick={() => onOpenSession(run.sessionId)} title="Open this run's card on the board">
            Show on board
          </button>
        )}

        <div className="spacer" />

        {shown === 'dashboard' && data && (
          <>
            <span title="When the brain last synced bill balances">
              synced {data.syncedAt ? clock(data.syncedAt) : '—'}
              {data.lastSweep?.started_at && ` · swept ${shortDate(data.lastSweep.started_at)}`}
            </span>
            <button className="ghost" onClick={load}>
              Refresh
            </button>
          </>
        )}
      </div>

      {error && <div className="notice">{error}</div>}

      <div className="pane-content">
        {shown === 'session' && run && live ? (
          <TerminalView key={run.sessionId} sessionId={run.sessionId} onExit={loadRun} />
        ) : shown === 'session' && run ? (
          <div className="pane-empty">
            <div>The billing session isn’t running</div>
            <div className="hint">
              Started {new Date(run.startedAt).toLocaleString()}. “Resume” reopens the same
              conversation; “Run” starts a fresh sweep.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" disabled={busy} onClick={resume}>
                Resume
              </button>
              {canRun && (
                <button disabled={busy} onClick={() => start(false)}>
                  Run again
                </button>
              )}
            </div>
          </div>
        ) : !data ? (
          <div className="pane-empty">
            {error ? (
              <>
                <div>Couldn’t read the billing brain</div>
                <div className="hint">{error}</div>
                <button onClick={load}>Try again</button>
              </>
            ) : (
              <div>Reading the billing brain…</div>
            )}
          </div>
        ) : (
          <div className="usage-body">
            {/* ------------------------------------------------ headline --- */}
            <div className="u-section" style={{ marginTop: 6 }}>
              <div className="tl-totals">
                <div className="tl-stat">
                  <div className="n">{money(data.ar.total)}</div>
                  <div className="l">outstanding</div>
                </div>
                <div className="tl-stat bl-bad">
                  <div className="n">{money(data.ar.draft)}</div>
                  <div className="l">draft — never issued</div>
                </div>
                <div className="tl-stat">
                  <div className="n">{money(data.ar.awaiting)}</div>
                  <div className="l">awaiting payment</div>
                </div>
                <div className="tl-stat bl-bad">
                  <div className="n">{money(data.ar.overdue)}</div>
                  <div className="l">overdue</div>
                </div>
              </div>
              <div className="bl-chips">
                {Object.entries(data.ar.byProgram)
                  .sort((a, b) => b[1] - a[1])
                  .map(([p, n]) => (
                    <span key={p} className="badge">
                      {p} {money(n)}
                    </span>
                  ))}
              </div>
            </div>

            {/* ----------------------------------------------- approvals --- */}
            <div className="u-section">
              <h3>
                Time entries awaiting approval
                {data.drafts.rows.length > 0 && <span className="u-count">{data.drafts.rows.length}</span>}
              </h3>
              <p className="u-note">
                Drafted by the billing agent from the work it watched. Nothing posts until you
                approve it here or in a walkthrough — the button below is that approval.
              </p>
              {approveNote && <div className="notice" style={{ margin: '0 0 10px' }}>{approveNote}</div>}
              {data.drafts.rows.length === 0 ? (
                <div className="u-quiet">Nothing waiting.</div>
              ) : (
                <>
                  <table className="tl">
                    <thead>
                      <tr>
                        <th style={{ width: 26 }}>
                          <input
                            type="checkbox"
                            checked={data.drafts.rows.every((d) => picked.has(d.id))}
                            onChange={(e) =>
                              setPicked(e.target.checked ? new Set(data.drafts.rows.map((d) => d.id)) : new Set())
                            }
                          />
                        </th>
                        <th style={{ width: 80 }}>Date</th>
                        <th style={{ width: 140 }}>Matter</th>
                        <th>Description</th>
                        <th style={{ width: 60, textAlign: 'right' }}>Hours</th>
                        <th style={{ width: 80, textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.drafts.rows.map((d) => (
                        <tr key={d.id} className={picked.has(d.id) ? '' : 'bl-dim'}>
                          <td>
                            <input
                              type="checkbox"
                              checked={picked.has(d.id)}
                              onChange={(e) => {
                                const next = new Set(picked);
                                if (e.target.checked) next.add(d.id);
                                else next.delete(d.id);
                                setPicked(next);
                              }}
                            />
                          </td>
                          <td className="day">{shortDate(d.date)}</td>
                          <td style={{ fontWeight: 550 }}>{d.matter ?? '—'}</td>
                          <td>
                            {d.description}
                            {d.billable === 0 && <span className="bl-flag">non-billable</span>}
                            {d.capFlag && (
                              <span className="bl-flag warn" title={d.capFlagDetail ?? undefined}>
                                {d.capFlag}
                              </span>
                            )}
                          </td>
                          <td className="h">{(d.hours ?? 0).toFixed(1)}</td>
                          <td className="h">{d.billable === 0 ? '—' : money(d.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="bl-actions">
                    <span className="u-quiet" style={{ padding: 0 }}>
                      {picked.size} of {data.drafts.rows.length} selected ·{' '}
                      {hours(data.drafts.rows.filter((d) => picked.has(d.id)).reduce((n, d) => n + (d.hours ?? 0), 0))} ·{' '}
                      {money(data.drafts.rows.filter((d) => picked.has(d.id)).reduce((n, d) => n + d.amount, 0))}
                    </span>
                    <div className="spacer" />
                    {canApprove ? (
                      <button className="primary" disabled={busy || picked.size === 0} onClick={approve}>
                        {busy ? 'Posting…' : `Approve & post ${picked.size} to Clio`}
                      </button>
                    ) : (
                      <span className="u-quiet" style={{ padding: 0 }}>
                        Set <code>billing.approveCommand</code> to post from here.
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ------------------------------------------ answer required --- */}
            <div className="u-section">
              <h3>
                Waiting on you
                {data.pings.open > 0 && <span className="u-count">{data.pings.open}</span>}
              </h3>
              <p className="u-note">
                The billing agent's open questions, most urgent first. These are the items that rot
                if ignored — the MetLife lesson is that an unanswered billing inquiry becomes a
                rejected claim. Answer them in the {label.toLowerCase()} session.
              </p>
              {data.pings.rows.length === 0 ? (
                <div className="u-quiet">No open questions.</div>
              ) : (
                <div className="bl-pings">
                  {data.pings.rows.map((p) => (
                    <div key={p.id} className="bl-ping">
                      <span className={`bl-sev ${p.severity}`}>{p.severity}</span>
                      <span className="bl-ping-matter">{p.matter ?? '—'}</span>
                      <span className="bl-ping-body">{p.body}</span>
                      <span className="bl-ping-age" title={p.createdAt}>
                        {age(p.ageDays)}
                      </span>
                    </div>
                  ))}
                  {data.pings.open > data.pings.shown && (
                    <div className="u-quiet">
                      …and {data.pings.open - data.pings.shown} more — ask the {label.toLowerCase()}{' '}
                      session for the full list.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ---------------------------------------- outstanding bills --- */}
            <div className="u-section">
              <h3>
                Outstanding bills
                {data.ar.bills.length > 0 && <span className="u-count">{data.ar.bills.length}</span>}
              </h3>
              <p className="u-note">
                Every unpaid bill the brain knows, largest balance first. “Draft” means it was never
                issued at all — invisible AR. “Overdue” is a passed due date, or {data.ar.overdueDays}{' '}
                days without one.
              </p>
              <table className="tl">
                <thead>
                  <tr>
                    <th>Matter</th>
                    <th style={{ width: 90 }}>Program</th>
                    <th style={{ width: 60 }}>Bill</th>
                    <th style={{ width: 80 }}>Issued</th>
                    <th style={{ width: 120 }}>State</th>
                    <th style={{ width: 85, textAlign: 'right' }}>Total</th>
                    <th style={{ width: 85, textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ar.bills.map((b) => (
                    <tr key={b.billId}>
                      <td style={{ fontWeight: 550 }}>{b.matter}</td>
                      <td className="day">{b.program ?? '—'}</td>
                      <td className="day">{b.number}</td>
                      <td className="day">
                        {shortDate(b.issued)}
                        {b.ageDays != null && b.ageDays > 0 && ` · ${age(b.ageDays)}`}
                      </td>
                      <td>
                        {b.state === 'draft' ? (
                          <span className="bl-flag bad">draft — never issued</span>
                        ) : b.overdue ? (
                          <span className="bl-flag bad">overdue</span>
                        ) : (
                          <span className="day">{b.state === 'partial' ? 'partly paid' : 'awaiting payment'}</span>
                        )}
                      </td>
                      <td className="h dim">{money(b.total)}</td>
                      <td className="h">{money(b.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* -------------------------------------------- budget health --- */}
            <div className="u-section">
              <h3>Budget health</h3>
              <p className="u-note">
                Every matter with a billing profile: the program's cap, extra budget approved on top,
                and what has actually been billed and paid. Flags mark both leaks — billed past the
                budget without approval, and approved budget nobody ever billed against.
              </p>
              <table className="tl">
                <thead>
                  <tr>
                    <th>Matter</th>
                    <th style={{ width: 90 }}>Program</th>
                    <th style={{ width: 80, textAlign: 'right' }}>Cap</th>
                    <th style={{ width: 90, textAlign: 'right' }}>+Approved</th>
                    <th style={{ width: 85, textAlign: 'right' }}>Billed</th>
                    <th style={{ width: 85, textAlign: 'right' }}>Paid</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.budgets
                    .filter((b) => b.flags.length || b.cap != null || b.rteApproved > 0)
                    .map((b) => (
                      <tr key={b.matterId}>
                        <td style={{ fontWeight: 550 }}>{b.matter}</td>
                        <td className="day">{b.program ?? '—'}</td>
                        <td className="h dim">{b.cap != null ? money(b.cap) : '—'}</td>
                        <td className="h dim">{b.rteApproved > 0 ? money(b.rteApproved) : '—'}</td>
                        <td className="h">{money(b.billed)}</td>
                        <td className="h dim">{money(b.paid)}</td>
                        <td>
                          {b.flags.map((f) => (
                            <span key={f} className={`bl-flag ${f === 'over_budget' ? 'bad' : 'warn'}`}>
                              {FLAG_LABEL[f] ?? f}
                            </span>
                          ))}
                          {b.rteOpen > 0 && <span className="bl-flag">RTE pending</span>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* ------------------------------------------- reconciliation --- */}
            {data.reconciliation && (
              <div className="u-section">
                <h3>
                  Carrier portal vs. the brain
                  {data.reconciliation.unmatched.length > 0 && (
                    <span className="u-count">{data.reconciliation.unmatched.length}</span>
                  )}
                </h3>
                <p className="u-note">
                  The newest portal snapshot ({data.reconciliation.snapshotDate ?? data.reconciliation.snapshot}
                  ): {data.reconciliation.openCases} open cases, {data.reconciliation.matched} matched to a
                  billing profile by member id. The rest are open carrier cases the brain can't name — each
                  is either work with no billing profile, or a profile missing its member id.
                </p>
                {data.reconciliation.unmatched.length === 0 ? (
                  <div className="u-quiet">Every open portal case matches a billing profile.</div>
                ) : (
                  <table className="tl">
                    <thead>
                      <tr>
                        <th style={{ width: 90 }}>Service ID</th>
                        <th>Client</th>
                        <th style={{ width: 110 }}>EID</th>
                        <th>Case type</th>
                        <th style={{ width: 80 }}>Opened</th>
                        <th style={{ width: 80, textAlign: 'right' }}>Paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.reconciliation.unmatched.map((c) => (
                        <tr key={c.serviceId}>
                          <td className="day">{c.serviceId}</td>
                          <td style={{ fontWeight: 550 }}>{c.client}</td>
                          <td className="day">{c.eids}</td>
                          <td>{c.caseType}</td>
                          <td className="day">{shortDate(c.started)}</td>
                          <td className="h dim">{c.paid ? money(c.paid) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* ------------------------------------------------- unbilled --- */}
            <div className="u-section">
              <h3>
                Work not yet billed
                {data.unbilled.rows.length > 0 && <span className="u-count">{data.unbilled.rows.length}</span>}
              </h3>
              <p className="u-note">
                Work the billing agent saw happen that never became a time entry — the other kind of
                invisible AR{data.unbilled.hours > 0 && <> ({hours(data.unbilled.hours)} estimated)</>}.
              </p>
              {data.unbilled.rows.length === 0 ? (
                <div className="u-quiet">Nothing flagged.</div>
              ) : (
                <table className="tl">
                  <thead>
                    <tr>
                      <th style={{ width: 140 }}>Matter</th>
                      <th>Description</th>
                      <th style={{ width: 70, textAlign: 'right' }}>~Hours</th>
                      <th style={{ width: 90 }}>Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unbilled.rows.map((w) => (
                      <tr key={w.id}>
                        <td style={{ fontWeight: 550 }}>{w.matter ?? '—'}</td>
                        <td>{w.description}</td>
                        <td className="h dim">{w.hours != null ? w.hours.toFixed(1) : '—'}</td>
                        <td className="day">{shortDate(w.observed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <p className="u-fine">
              Read from the billing brain — the SQLite file the billing agent maintains — plus the
              newest carrier-portal snapshot. Balances are as of the brain's last sync with the
              practice-management system, shown in the bar above; the sweep that fills the questions
              and flags runs on its own schedule. Posting a time entry goes through the brain's own
              approval script, so the rule that nothing posts without your explicit approval holds no
              matter which door the approval comes through.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
