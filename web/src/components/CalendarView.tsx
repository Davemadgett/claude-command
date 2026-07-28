import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CalendarEvent, Card } from '../types';

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const diff = Math.round((date.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (diff === 0) return `Today · ${weekday}`;
  if (diff === 1) return `Tomorrow · ${weekday}`;
  if (diff < 0) return `${weekday} (past)`;
  return weekday;
}

function timeLabel(e: CalendarEvent) {
  if (e.allDay) return 'All day';
  return new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function CalendarView({
  cards,
  onOpenCard,
  onCreated,
  onError,
}: {
  cards: Card[];
  onOpenCard: (sessionId: string) => void;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [days, setDays] = useState(21);
  const [labelOnly, setLabelOnly] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** Only offer to create work for something still ahead of you. */
  const isUpcoming = (e: CalendarEvent) => Date.parse(e.end ?? e.start) >= Date.now();

  const make = async (e: CalendarEvent, startSession: boolean) => {
    setBusy(e.id);
    try {
      const when = new Date(e.start).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        ...(e.allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
      });
      const notes = [
        `From the calendar: ${when}${e.allDay ? ' (all day)' : ''}`,
        `Calendar: ${e.calendar}`,
        e.location ? `Location: ${e.location}` : null,
      ].filter(Boolean).join('\n');

      const res = await api.createCardFromEvent({
        title: e.title,
        notes,
        label: e.label ?? undefined,
        startSession,
      });
      onCreated();
      setNonce((n) => n + 1);
      if (startSession) onOpenCard(res.sessionId);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askAgain = async () => {
    setAsking(true);
    try {
      const r = await api.requestCalendarAccess();
      if (r.granted) {
        setDenied(false);
        setError(null);
        setNonce((n) => n + 1);
      } else {
        setDenied(r.denied);
        setError(r.error);
        if (!r.denied && r.error) onError(r.error);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    setEvents(null);
    api
      .calendar(days)
      .then((d) => {
        setEvents(d.events);
        setError(d.error);
        setDenied(d.denied);
      })
      .catch((e) => onError((e as Error).message));
  }, [days, onError, nonce]);

  // Cards are grouped by label so an event can show the work sitting behind it.
  const cardsByLabel = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const c of cards) {
      if (!c.label) continue;
      if (!map.has(c.label)) map.set(c.label, []);
      map.get(c.label)!.push(c);
    }
    return map;
  }, [cards]);

  const shown = (events ?? []).filter((e) => !labelOnly || e.label);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of shown) {
      const key = dayKey(e.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  return (
    <div className="view">
      <h2>Calendar</h2>
      <p className="sub">
        What is coming up, and the work on your board attached to it. An event is tied to a label
        when its title carries the file number — the way your firm calendar already writes them.
        Events that don’t name a number stay unattached rather than being guessed at.
      </p>

      {denied ? (
        /**
         * A denial is final as far as macOS is concerned — it stops asking and
         * answers no from then on — so the only way back is to clear the recorded
         * decision and read again, which is what this button does.
         */
        <div className="notice permission">
          <div>
            <strong>This app can’t see your calendars.</strong> Permission was declined, and
            macOS won’t ask again on its own.
          </div>
          <div className="permission-actions">
            <button className="primary" disabled={asking} onClick={askAgain}>
              {asking ? 'Asking…' : 'Ask me again'}
            </button>
            {/* The app hands unknown schemes to NSWorkspace, which is what opens
                the Privacy pane; /api/open deliberately refuses non-home paths. */}
            <a
              className="button-link"
              href="x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
            >
              Open System Settings
            </a>
          </div>
          <div className="hint">
            “Ask me again” clears the answer and re-reads, so macOS puts the permission dialog back
            up. Choose <em>Allow Full Access</em> this time.
          </div>
        </div>
      ) : (
        error && <div className="notice">Couldn’t read the calendar: <code>{error}</code></div>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <label className="switch">
          Next
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={21}>21 days</option>
            <option value={60}>60 days</option>
          </select>
        </label>
        <label className="switch">
          <input type="checkbox" checked={labelOnly} onChange={(e) => setLabelOnly(e.target.checked)} />
          Label events only
        </label>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {events ? `${shown.length} shown` : ''}
        </span>
      </div>

      {!events ? (
        <div className="pane-empty">Reading your calendars…</div>
      ) : byDay.length === 0 ? (
        <div className="pane-empty">
          <div>Nothing scheduled</div>
          <div className="hint">
            {labelOnly ? 'No label-linked events in this window — untick the filter to see everything.' : 'No events in this window.'}
          </div>
        </div>
      ) : (
        byDay.map(([key, dayEvents]) => (
          <div className="cal-day" key={key}>
            <div className="cal-day-head">{dayLabel(key)}</div>
            {dayEvents.map((e) => {
              const related = e.label ? cardsByLabel.get(e.label) ?? [] : [];
              return (
                <div className="cal-event" key={e.id}>
                  <div className="cal-time">{timeLabel(e)}</div>
                  <div className="cal-body">
                    <div className="cal-title">{e.title}</div>
                    <div className="cal-meta">
                      <span className="cal-cal">{e.calendar}</span>
                      {e.location && <span> · {e.location}</span>}
                    </div>

                    {e.label && (
                      <div className="cal-links">
                        {e.labelUrl ? (
                          <a className="badge label" href={e.labelUrl} target="_blank" rel="noreferrer">
                            {e.label}
                          </a>
                        ) : (
                          <span className="badge label">{e.label}</span>
                        )}
                        {e.labelFolder && (
                          <button
                            className="label-link as-link"
                            onClick={() => api.openFile(e.labelFolder!).catch(() => {})}
                          >
                            Folder
                          </button>
                        )}
                        {related.map((c) => (
                          <button
                            key={c.sessionId}
                            className="cal-card"
                            onClick={() => onOpenCard(c.sessionId)}
                            title="Open this session"
                          >
                            {c.live && <span className="pulse" />}
                            {c.title}
                          </button>
                        ))}
                        {related.length === 0 &&
                          (isUpcoming(e) ? (
                            <>
                              <span className="cal-nocard">no card yet</span>
                              <button
                                className="cal-make"
                                disabled={busy === e.id}
                                onClick={() => make(e, false)}
                                title="Add a card for this deadline"
                              >
                                + Card
                              </button>
                              <button
                                className="cal-make primary"
                                disabled={busy === e.id}
                                onClick={() => make(e, true)}
                                title={`Add a card and start a session in ${e.labelFolder ?? 'your home folder'}`}
                              >
                                {busy === e.id ? 'Starting…' : '+ Card & session'}
                              </button>
                            </>
                          ) : (
                            <span className="cal-nocard">no card on the board</span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
