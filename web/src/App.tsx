import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';

import { api } from './api';
import { BoardTab } from './components/BoardTab';
import { CardContent } from './components/CardView';
import { CardMenu } from './components/CardMenu';
import { ColumnView } from './components/ColumnView';
import { SessionPanel } from './components/SessionPanel';
import { BillingPanel } from './components/BillingPanel';
import { BriefPanel } from './components/BriefPanel';
import { UsagePanel } from './components/UsagePanel';
import { NewSessionDialog } from './components/NewSessionDialog';
import { SkillsView } from './components/SkillsView';
import { ScheduledView } from './components/ScheduledView';
import { TimeLogView } from './components/TimeLogView';
import { AgentsView } from './components/AgentsView';
import { ArchiveView } from './components/ArchiveView';
import { Logo } from './components/Logo';
import { EngineToggle } from './components/EngineToggle';
import { CalendarView } from './components/CalendarView';
import { LiveView } from './components/LiveView';
import { perWindow } from './windowId';
import { hasNative } from './native';
import type { AppConfig, BoardState, BriefRun, Card } from './types';

const POLL_MS = 4000;
/** Kept in step with the server's own id for the board new sessions land on. */
const UNSORTED_BOARD = 'unsorted';
type View = 'board' | 'live' | 'calendar' | 'time' | 'archive' | 'skills' | 'scheduled' | 'agents';

/**
 * Two groups, because they answer different questions. "Work" is what your
 * labels are doing right now and what they've done; "Setup" is what the system
 * itself is configured to do. Mixing them in one flat row read as arbitrary.
 */
const VIEWS: { id: View; label: string; group: 'work' | 'setup' }[] = [
  { id: 'board', label: 'Board', group: 'work' },
  { id: 'live', label: 'Live', group: 'work' },
  { id: 'calendar', label: 'Calendar', group: 'work' },
  { id: 'time', label: 'Time', group: 'work' },
  { id: 'archive', label: 'Archive', group: 'work' },
  { id: 'skills', label: 'Skills', group: 'setup' },
  { id: 'scheduled', label: 'Scheduled', group: 'setup' },
  { id: 'agents', label: 'Team', group: 'setup' },
];

function midpoint(prev: Card | undefined, next: Card | undefined): number {
  if (!prev && !next) return 1000;
  if (!prev) return next!.position - 1000;
  if (!next) return prev.position + 1000;
  return (prev.position + next.position) / 2;
}

export default function App() {
  // What this install calls itself. Read once — it cannot change without a
  // restart, since it comes from config.json on the server's disk.
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    api.config().then(setAppConfig).catch(() => {});
  }, []);

  const [board, setBoard] = useState<BoardState | null>(null);
  const [boardId, setBoardId] = useState<string | null>(() => localStorage.getItem(perWindow('boardId')));
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(perWindow('view')) as View) || 'board'
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The second row selects what fills the screen: one of the boards, or one of
   * the panels pinned to its right. They are mutually exclusive, so this is one
   * value rather than a flag per panel — adding a third panel shouldn't mean
   * remembering to turn the other two off.
   */
  const [overlay, setOverlay] = useState<'brief' | 'usage' | 'billing' | null>(null);
  /**
   * Where the morning-brief run stands, polled so the tab itself can say so.
   * The brief asks questions as it goes, and a question nobody sees is a brief
   * that gets abandoned and run again — the pulse on the tab is what makes the
   * wait visible from anywhere in the app.
   */
  const [briefRun, setBriefRun] = useState<BriefRun | null>(null);
  useEffect(() => {
    const tick = () => api.briefRun().then(setBriefRun).catch(() => {});
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);
  /** Same watch for the billing run — its questions deserve the same pulse. */
  const [billingRun, setBillingRun] = useState<BriefRun | null>(null);
  useEffect(() => {
    const tick = () => api.billingRun().then(setBillingRun).catch(() => {});
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);
  const includeArchived = false; // archived cards live in the Archive tab
  const [dragging, setDragging] = useState<Card | null>(null);
  const [menu, setMenu] = useState<{ card: Card; x: number; y: number } | null>(null);
  const [showNew, setShowNew] = useState(false);
  /**
   * Find a card by name. A board with forty cards is scanned, not read, and
   * ⌘F is the scan. It filters rather than jumps — the matches stay in their
   * columns, so where a card is stays as legible as which one it is.
   */
  const [query, setQuery] = useState('');
  const [searchNonce, setSearchNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  );

  const draggingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api.board({ interactiveOnly: true, includeArchived, boardId });
      if (!draggingRef.current) {
        setBoard(b);
        if (b.boardId !== boardId) setBoardId(b.boardId);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [includeArchived, boardId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  /**
   * The Mac app's View ▸ Appearance menu drives the theme through this, since
   * the menu bar is a better home for a setting you touch twice a year than the
   * top of the board. Every window is told, so they don't drift apart.
   */
  useEffect(() => {
    const w = window as unknown as {
      __theme?: { get: () => string; set: (t: 'dark' | 'light') => void };
    };
    w.__theme = { get: () => theme, set: (t) => setTheme(t === 'light' ? 'light' : 'dark') };
    return () => {
      delete w.__theme;
    };
  }, [theme]);

  useEffect(() => localStorage.setItem(perWindow('view'), view), [view]);
  useEffect(() => {
    if (boardId) localStorage.setItem(perWindow('boardId'), boardId);
  }, [boardId]);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

  const selected = useMemo(
    () => board?.cards.find((c) => c.sessionId === selectedId) ?? null,
    [board, selectedId]
  );

  const cardsIn = useCallback(
    (columnId: string) =>
      (board?.cards ?? [])
        .filter((c) => c.columnId === columnId)
        .sort((a, b) => a.position - b.position),
    [board]
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Switching sections or boards should put you at the top of what you chose. */
  const scrollToTop = useCallback(() => window.scrollTo({ top: 0 }), []);

  /*
   * The four things worth a key. Each is a plain "go there" rather than a
   * toggle, so a second press — or the same press arriving twice, once from the
   * menu and once from the page — lands in the same place.
   */
  const newSession = useCallback(() => setShowNew(true), []);
  const showBrief = useCallback(() => {
    setView('board');
    setOverlay('brief');
    scrollToTop();
  }, [scrollToTop]);
  const showUsage = useCallback(() => {
    setView('board');
    setOverlay('usage');
    scrollToTop();
  }, [scrollToTop]);
  const showBilling = useCallback(() => {
    setView('board');
    setOverlay('billing');
    scrollToTop();
  }, [scrollToTop]);
  const findCard = useCallback(() => {
    setView('board');
    setOverlay(null);
    setSearchNonce((n) => n + 1);
  }, []);

  // The box mounts with the board, so focus it after that render, not before.
  useEffect(() => {
    if (!searchNonce) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchNonce]);

  /**
   * The Mac app binds ⌘N / ⌘F / ⌘B / ⌘U as menu items, which is what makes them
   * work while a terminal has the keyboard — a menu key equivalent is taken
   * before the web view sees it. The menu calls in through this. (⌘T, a new
   * board tab, is the app's alone — tabs are windows, and the page has none.)
   * In a plain browser there is no menu, so the same keys are caught on the
   * page; ⌘N is the browser's own there and can't be claimed, the other three
   * can.
   */
  useEffect(() => {
    const w = window as unknown as {
      __app?: {
        newSession: () => void;
        findCard: () => void;
        showBrief: () => void;
        showUsage: () => void;
        showBilling: () => void;
      };
    };
    w.__app = { newSession, findCard, showBrief, showUsage, showBilling };
    const onKey = (e: KeyboardEvent) => {
      // ⌘ only. Control is the terminal's: ^B ^F ^T ^U all mean something at a shell.
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      // The one shifted key: ⇧⌘B, billing — ⌘B alone stays the brief.
      if (e.shiftKey) {
        if (e.key.toLowerCase() !== 'b') return;
        e.preventDefault();
        e.stopPropagation();
        showBilling();
        return;
      }
      const go = { n: newSession, f: findCard, b: showBrief, u: showUsage }[e.key.toLowerCase()];
      if (!go) return;
      e.preventDefault();
      e.stopPropagation();
      go();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      delete w.__app;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [newSession, findCard, showBrief, showUsage, showBilling]);

  /** Select a card. Deliberately does not scroll — the board stays put. */
  const selectCard = useCallback((sessionId: string) => {
    setSelectedId(sessionId);
  }, []);

  /** Open a session: show it in the panel below and go there. */
  const openSession = useCallback((sessionId: string) => {
    setView('board');
    setOverlay(null);
    setSelectedId(sessionId);

    // Not requestAnimationFrame: a scroll issued from inside the frame callback
    // is discarded here. And not a single timeout either — coming from another
    // tab, the panel needs a moment to mount before it can be scrolled to.
    let tries = 0;
    const go = () => {
      const el = panelRef.current;
      if (el) {
        const top = window.scrollY + el.getBoundingClientRect().top;
        if (top > 4) {
          window.scrollTo({ top, behavior: 'smooth' });
          // Smooth scrolling is itself a no-op in some embedders, so confirm.
          setTimeout(() => {
            if (Math.abs(window.scrollY - top) > 8) window.scrollTo(0, top);
          }, 320);
          return;
        }
      }
      if (++tries < 8) setTimeout(go, 60);
    };
    setTimeout(go, 0);
  }, []);

  const onDragStart = (e: DragStartEvent) => {
    draggingRef.current = true;
    const data = e.active.data.current;
    if (data?.type === 'card') setDragging(data.card as Card);
  };

  /**
   * Tabs are dragged where they are clicked, so a tab only starts moving after
   * the pointer has travelled far enough to mean it. Below that it is a click,
   * and clicking a tab switches board.
   */
  const tabSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onTabDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!board || !over || active.id === over.id) return;

    const ids = board.boards.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;

    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // Moved locally first: the row is the thing being dragged, and waiting for
    // a round trip to redraw it makes the tab snap back before it moves.
    setBoard({ ...board, boards: ids.map((id) => board.boards.find((b) => b.id === id)!) });
    try {
      await api.reorderBoards(ids);
    } catch (err) {
      setError((err as Error).message);
    }
    return refresh();
  };

  const onDragEnd = async (e: DragEndEvent) => {
    draggingRef.current = false;
    setDragging(null);
    const { active, over } = e;
    if (!over || !board) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type === 'column-handle') {
      if (overData?.type !== 'column-handle' && overData?.type !== 'column') return;
      const ids = board.columns.map((c) => c.id);
      const from = ids.indexOf(activeData.columnId as string);
      const to = ids.indexOf(overData.columnId as string);
      if (from === -1 || to === -1 || from === to) return;

      ids.splice(to, 0, ids.splice(from, 1)[0]);
      setBoard({
        ...board,
        columns: ids.map((id, i) => ({
          ...board.columns.find((c) => c.id === id)!,
          position: (i + 1) * 1000,
        })),
      });
      try {
        await api.reorderColumns(ids);
      } catch (err) {
        setError((err as Error).message);
      }
      return refresh();
    }

    if (activeData?.type !== 'card') return;
    const card = activeData.card as Card;

    let targetColumn: string;
    let index: number;

    if (overData?.type === 'column') {
      targetColumn = overData.columnId as string;
      index = cardsIn(targetColumn).filter((c) => c.sessionId !== card.sessionId).length;
    } else if (overData?.type === 'card') {
      const overCard = overData.card as Card;
      targetColumn = overCard.columnId;
      const list = cardsIn(targetColumn).filter((c) => c.sessionId !== card.sessionId);
      const at = list.findIndex((c) => c.sessionId === overCard.sessionId);
      index = at === -1 ? list.length : at;
    } else {
      return;
    }

    const list = cardsIn(targetColumn).filter((c) => c.sessionId !== card.sessionId);
    const position = midpoint(list[index - 1], list[index]);
    if (card.columnId === targetColumn && card.position === position) return;

    setBoard({
      ...board,
      cards: board.cards.map((c) =>
        c.sessionId === card.sessionId ? { ...c, columnId: targetColumn, position } : c
      ),
    });

    try {
      await api.moveCard(card.sessionId, targetColumn, position);
    } catch (err) {
      setError((err as Error).message);
    }
    refresh();
  };

  if (!board) return <div className="pane-empty">Loading board…</div>;

  const liveCount = board.cards.filter((c) => c.live).length;
  const matches = (c: Card) => {
    const q = query.trim().toLowerCase();
    return !q || c.title.toLowerCase().includes(q) || (c.label ?? '').toLowerCase().includes(q);
  };
  const matchCount = board.cards.filter(matches).length;
  const onBoard = view === 'board';

  return (
    <div className="app">
      <div className="header">
        <div className="topbar">
          <h1>
            <Logo appName={appConfig?.appName ?? 'Claude Command'} />
          </h1>

          <div className="nav">
            {VIEWS.map((v, i) => (
              <span key={v.id} style={{ display: 'contents' }}>
                {i > 0 && VIEWS[i - 1].group !== v.group && <span className="nav-divider" />}
                <button
                  className={view === v.id ? 'on' : ''}
                  onClick={() => {
                    setView(v.id);
                    scrollToTop();
                  }}
                >
                  {v.label}
                </button>
              </span>
            ))}
          </div>

          <div className="spacer" />

          {onBoard && (
            <>
              <span className="count-pill">{board.cards.length} sessions</span>
              {liveCount > 0 && (
                <span className="badge live">
                  <span className="pulse" />
                  {liveCount} live
                </span>
              )}
            </>
          )}
          <button
            className={`ghost caffeine${board.caffeinated ? ' on' : ''}`}
            title={
              board.caffeinated
                ? 'Keeping the display awake (caffeinate -d) — click to stop'
                : 'Keep the display awake while long work runs (caffeinate -d)'
            }
            onClick={() => act(() => api.setCaffeinate(!board.caffeinated))}
          >
            {board.caffeinated ? '☕' : '☕'}
          </button>
          {/* In the app this lives in View ▸ Appearance. A browser has no menu
              bar to put it in, so there it stays a button. */}
          {!hasNative() && (
            <button
              className="ghost theme-toggle"
              title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          )}
          {appConfig && (
            <EngineToggle
              config={appConfig}
              onChange={async (engine) => {
                // Optimistic: the switch should move under the pointer, not a
                // round trip later. The server's answer is authoritative and
                // replaces it either way.
                setAppConfig({ ...appConfig, engine });
                try {
                  const next = await api.setEngine(engine);
                  setAppConfig((c) => (c ? { ...c, ...next } : c));
                } catch (e) {
                  setAppConfig(appConfig);
                  setError((e as Error).message);
                }
              }}
            />
          )}
          <button className="primary" title="⌘N" onClick={newSession}>
            + New session
          </button>
        </div>

        {onBoard && (
          <div className="board-tabs">
            {/* Its own drag context: the board below has one of its own for
                cards and columns, and a tab has nothing to do with either. */}
            <DndContext sensors={tabSensors} onDragEnd={onTabDragEnd}>
              <SortableContext
                items={board.boards.map((b) => b.id)}
                strategy={horizontalListSortingStrategy}
              >
                {board.boards.map((b) => (
                  <BoardTab
                    key={b.id}
                    id={b.id}
                    active={b.id === board.boardId && !overlay}
                    onClick={() => {
                      setBoardId(b.id);
                      setOverlay(null);
                      scrollToTop();
                    }}
                    onDoubleClick={() => {
                      const name = prompt('Board name', b.name);
                      if (name?.trim()) act(() => api.renameBoard(b.id, name.trim()));
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const noun = appConfig?.labels.noun ?? 'label';
                      const raw = prompt(
                        `Default ${noun} for “${b.name}” — applied to cards here that have no ` +
                          `${noun} of their own. Stronger evidence (your choice, a folder, a file ` +
                          `number in the session) replaces it. Leave blank for no default.`,
                        b.default_label ?? ''
                      );
                      if (raw === null) return;
                      act(() => api.setBoardDefaultLabel(b.id, raw.trim() || null));
                    }}
                    title={
                      'Drag to reorder · double-click to rename · right-click to set a default ' +
                      (appConfig?.labels.noun ?? 'label') +
                      (b.default_label ? ` (now ${b.default_label})` : '')
                    }
                  >
                    {b.name}
                    {/* The count is the whole reason this tab exists: sessions
                        arrive on their own, and you need to see that from a
                        board you are already on. */}
                    {b.id === UNSORTED_BOARD && board.unsorted > 0 && (
                      <span className="tab-count">{board.unsorted}</span>
                    )}
                    {b.id === board.boardId &&
                      b.id !== UNSORTED_BOARD &&
                      board.boards.length > 1 && (
                        <span
                          className="x"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              confirm(`Delete the “${b.name}” board? Its cards move to another board.`)
                            ) {
                              setBoardId(null);
                              act(() => api.deleteBoard(b.id));
                            }
                          }}
                        >
                          ✕
                        </span>
                      )}
                  </BoardTab>
                ))}
              </SortableContext>
            </DndContext>
            <button
              className="board-tab"
              title="New board"
              onClick={async () => {
                const name = prompt('Name the new board');
                if (!name?.trim()) return;
                try {
                  const created = await api.addBoard(name.trim());
                  setBoardId(created.id);
                  setOverlay(null);
                  scrollToTop();
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              +
            </button>

            <span className="tab-divider" />
            <button
              className={`board-tab ${overlay === 'brief' ? 'on' : ''}`}
              title="⌘B"
              onClick={showBrief}
            >
              Morning Brief
              {briefRun?.live && (
                <span
                  className={`tab-pulse ${briefRun.working ? '' : 'wait'}`}
                  title={briefRun.working ? 'Morning brief is running' : 'Morning brief is waiting for your answer'}
                />
              )}
            </button>
            {appConfig?.billing.enabled && (
              <button
                className={`board-tab ${overlay === 'billing' ? 'on' : ''}`}
                title="⇧⌘B"
                onClick={showBilling}
              >
                {appConfig.billing.label}
                {billingRun?.live && (
                  <span
                    className={`tab-pulse ${billingRun.working ? '' : 'wait'}`}
                    title={billingRun.working ? 'Billing session is running' : 'Billing session is waiting for your answer'}
                  />
                )}
              </button>
            )}
            <button
              className={`board-tab ${overlay === 'usage' ? 'on' : ''}`}
              title="⌘U"
              onClick={showUsage}
            >
              Usage
              {liveCount > 0 && <span className="tab-pulse" />}
            </button>

            <div className="spacer" />
            {!overlay && (
              <div className={`card-search ${query ? 'on' : ''}`}>
                <input
                  ref={searchRef}
                  type="search"
                  placeholder="Find card…  ⌘F"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('');
                      e.currentTarget.blur();
                    }
                  }}
                  spellCheck={false}
                />
                {query && (
                  <span className="count" title="Cards whose name or matter matches">
                    {matchCount} of {board.cards.length}
                  </span>
                )}
              </div>
            )}
            {!overlay && (
              <button
                className="ghost"
                onClick={() => act(() => api.addColumn('New column', '#64748b', board.boardId))}
              >
                + Column
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        Every session on this board is a real agent process, so without the one
        the board is set to the board loads, shows nothing, and fails on the
        first click with a spawn error. Saying so up front is the difference
        between a five-minute setup and concluding the thing is broken. Only the
        engine actually selected is worth a banner — an uninstalled second engine
        is a greyed-out switch, not a problem.
      */}
      {(() => {
        const active = appConfig?.engines?.find((e) => e.id === appConfig.engine);
        if (!appConfig || !active || active.found) return null;
        const cmd = active.id === 'codex' ? 'codex' : 'claude';
        return (
          <div className="notice setup">
            <strong>{active.name} isn’t installed yet.</strong> New sessions are set to start in{' '}
            {active.name}, and the board can’t find its <code>{cmd}</code> command. Install it, then
            run <code>{cmd}</code> once in a terminal to sign in — the board picks it up on the next
            reload. Or switch the toggle back.
          </div>
        );
      })()}

      {view === 'live' && <LiveView onOpenSession={openSession} onError={setError} />}
      {view === 'calendar' && (
        <CalendarView
          cards={board.cards}
          labelsEnabled={appConfig?.labels.enabled ?? false}
          labelNoun={appConfig?.labels.noun ?? 'label'}
          onOpenCard={openSession}
          onCreated={refresh}
          onError={setError}
        />
      )}
      {view === 'skills' && <SkillsView onRan={openSession} onError={setError} />}
      {view === 'scheduled' && <ScheduledView onRan={openSession} onError={setError} />}
      {view === 'time' && (
        <TimeLogView
          labelsEnabled={appConfig?.labels.enabled ?? false}
          labelNoun={appConfig?.labels.noun ?? 'label'}
          onError={setError}
        />
      )}
      {view === 'agents' && <AgentsView onError={setError} />}
      {view === 'archive' && <ArchiveView onRestored={refresh} onError={setError} />}

      {onBoard && overlay && (
        <div className="board-scroll" style={{ overflow: 'hidden', position: 'relative' }}>
          {overlay === 'brief' ? (
            <BriefPanel canRun={appConfig?.reports.canRun ?? false} onOpenSession={openSession} />
          ) : overlay === 'billing' ? (
            <BillingPanel
              canRun={appConfig?.billing.canRun ?? false}
              canApprove={appConfig?.billing.canApprove ?? false}
              label={appConfig?.billing.label ?? 'Billing'}
              onOpenSession={openSession}
            />
          ) : (
            <UsagePanel />
          )}
        </div>
      )}

      {onBoard && !overlay && (
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              draggingRef.current = false;
              setDragging(null);
            }}
          >
            <div className="board-scroll">
              <div className="board">
                <SortableContext
                  items={board.columns.map((c) => `col-sort:${c.id}`)}
                  strategy={horizontalListSortingStrategy}
                >
                  {board.columns.map((col) => (
                    <ColumnView
                      key={col.id}
                      column={col}
                      cards={cardsIn(col.id).filter(matches)}
                      selectedId={selectedId}
                      onSelect={(c) => selectCard(c.sessionId)}
                      onOpen={(c) => openSession(c.sessionId)}
                      onArchive={(c) => act(() => api.archiveCard(c.sessionId))}
                      onMenu={(c, x, y) => setMenu({ card: c, x, y })}
                      onConfirmLabel={(c, label) => act(() => api.setLabel(c.sessionId, label))}
                      onDismissLabel={(c) => act(() => api.dismissLabel(c.sessionId))}
                      onCyclePriority={(c, priority) =>
                        act(() => api.setPriority(c.sessionId, priority))
                      }
                      onAddCard={(columnId, title) =>
                        act(() => api.addCard({ columnId, title }))
                      }
                      hasReviewLane={board.columns.some((c) => c.review_of === col.id)}
                      onToggleReviewLane={(id, enabled) =>
                        act(() => api.setReviewLane(id, enabled))
                      }
                      onRenameColumn={(id, name) => act(() => api.updateColumn(id, { name }))}
                      onRecolorColumn={(id, color) => act(() => api.updateColumn(id, { color }))}
                      onDeleteColumn={(id) => {
                        const column = board.columns.find((c) => c.id === id);
                        const n = cardsIn(id).length;
                        const msg = n
                          ? `Delete “${column?.name}”? Its ${n} card${n === 1 ? '' : 's'} move to the first column.`
                          : `Delete “${column?.name}”?`;
                        if (confirm(msg)) act(() => api.deleteColumn(id));
                      }}
                    />
                  ))}
                </SortableContext>
              </div>
            </div>

            <DragOverlay>
              {dragging && (
                <div
                  className={`card overlay ${dragging.live ? 'live' : ''}${
                    dragging.priority ? ` prio-${dragging.priority}` : ''
                  }`}
                  style={{ width: 278 }}
                >
                  <CardContent card={dragging} />
                </div>
              )}
            </DragOverlay>
          </DndContext>

          <div className="panel" ref={panelRef}>
            <div className="panel-tabs">
              <button className="tab active">
                Session
                {selected && (
                  <span style={{ color: 'var(--text-faint)' }}>
                    {' '}
                    · {selected.label ?? selected.project}
                  </span>
                )}
              </button>
            </div>

            <div className="panel-body">
              <SessionPanel
                card={selected}
                onChanged={refresh}
                onError={setError}
                onOpenSession={openSession}
              />
            </div>
          </div>
        </>
      )}

      {menu && (
        <CardMenu
          labelsEnabled={appConfig?.labels.enabled ?? false}
          labelNoun={appConfig?.labels.noun ?? 'label'}
          card={menu.card}
          boards={board.boards}
          currentBoardId={board.boardId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={(c) => {
            const name = prompt('Card title', c.title);
            if (name !== null) act(() => api.updateCard(c.sessionId, { title: name.trim() || null }));
          }}
          onArchive={(c) => act(() => api.archiveCard(c.sessionId))}
          onSnooze={(c, wakeAt) => act(() => api.snoozeCard(c.sessionId, wakeAt))}
          onDelete={(c) => {
            if (confirm(`Delete “${c.title}”?`)) act(() => api.deleteCard(c.sessionId));
          }}
          onMoveToBoard={(c, target) => act(() => api.moveCardToBoard(c.sessionId, target))}
          onSetPriority={(c, priority) => act(() => api.setPriority(c.sessionId, priority))}
          onSetLabel={(c) => {
            const noun = appConfig?.labels.noun ?? 'label';
            const raw = prompt(
              `Which ${noun} is this card for? Anything that names one will do. ` +
                'Leave blank to clear.',
              c.label ?? ''
            );
            if (raw === null) return;
            act(() => api.setLabel(c.sessionId, raw.trim() || null));
          }}
        />
      )}

      {showNew && (
        <NewSessionDialog
          defaultColumnId={board.columns.find((c) => !c.review_of)?.id}
          labelsEnabled={appConfig?.labels.enabled ?? false}
          labelNoun={appConfig?.labels.noun ?? 'label'}
          engine={appConfig?.engines?.find((e) => e.id === appConfig.engine) ?? null}
          onClose={() => setShowNew(false)}
          onCreated={(sessionId) => {
            setShowNew(false);
            openSession(sessionId);
            refresh();
          }}
          onError={setError}
        />
      )}

      {error && <div className="toast">{error}</div>}
    </div>
  );
}
