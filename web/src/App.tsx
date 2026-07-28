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
import { CardContent } from './components/CardView';
import { CardMenu } from './components/CardMenu';
import { ColumnView } from './components/ColumnView';
import { SessionPanel } from './components/SessionPanel';
import { BriefPanel } from './components/BriefPanel';
import { NewSessionDialog } from './components/NewSessionDialog';
import { SkillsView } from './components/SkillsView';
import { ScheduledView } from './components/ScheduledView';
import { TimeLogView } from './components/TimeLogView';
import { AgentsView } from './components/AgentsView';
import { ArchiveView } from './components/ArchiveView';
import { Logo } from './components/Logo';
import { CalendarView } from './components/CalendarView';
import { LiveView } from './components/LiveView';
import type { AppConfig, BoardState, Card } from './types';

const POLL_MS = 4000;
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
  const [boardId, setBoardId] = useState<string | null>(() => localStorage.getItem('boardId'));
  const [view, setView] = useState<View>(() => (localStorage.getItem('view') as View) || 'board');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The second row selects what fills the screen: one of the boards, or the brief.
  const [showBrief, setShowBrief] = useState(false);
  const [sinceDays, setSinceDays] = useState(() => Number(localStorage.getItem('sinceDays') ?? 7));
  const includeArchived = false; // archived cards live in the Archive tab
  const [dragging, setDragging] = useState<Card | null>(null);
  const [menu, setMenu] = useState<{ card: Card; x: number; y: number } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  );

  const draggingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api.board({ sinceDays, interactiveOnly: true, includeArchived, boardId });
      if (!draggingRef.current) {
        setBoard(b);
        if (b.boardId !== boardId) setBoardId(b.boardId);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sinceDays, includeArchived, boardId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => localStorage.setItem('view', view), [view]);
  useEffect(() => localStorage.setItem('sinceDays', String(sinceDays)), [sinceDays]);
  useEffect(() => {
    if (boardId) localStorage.setItem('boardId', boardId);
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

  /** Select a card. Deliberately does not scroll — the board stays put. */
  const selectCard = useCallback((sessionId: string) => {
    setSelectedId(sessionId);
  }, []);

  /** Open a session: show it in the panel below and go there. */
  const openSession = useCallback((sessionId: string) => {
    setView('board');
    setShowBrief(false);
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
              <label>
                Window
                <select value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))}>
                  <option value={1}>Today</option>
                  <option value={3}>3 days</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={0}>All time</option>
                </select>
              </label>
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
          <button
            className="ghost theme-toggle"
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button className="primary" onClick={() => setShowNew(true)}>
            + New session
          </button>
        </div>

        {onBoard && (
          <div className="board-tabs">
            {board.boards.map((b) => (
              <button
                key={b.id}
                className={`board-tab ${b.id === board.boardId && !showBrief ? 'on' : ''}`}
                onClick={() => {
                  setBoardId(b.id);
                  setShowBrief(false);
                  scrollToTop();
                }}
                onDoubleClick={() => {
                  const name = prompt('Board name', b.name);
                  if (name?.trim()) act(() => api.renameBoard(b.id, name.trim()));
                }}
                title="Double-click to rename"
              >
                {b.name}
                {b.id === board.boardId && board.boards.length > 1 && (
                  <span
                    className="x"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete the “${b.name}” board? Its cards move to another board.`)) {
                        setBoardId(null);
                        act(() => api.deleteBoard(b.id));
                      }
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            ))}
            <button
              className="board-tab"
              title="New board"
              onClick={async () => {
                const name = prompt('Name the new board');
                if (!name?.trim()) return;
                try {
                  const created = await api.addBoard(name.trim());
                  setBoardId(created.id);
                  setShowBrief(false);
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
              className={`board-tab ${showBrief ? 'on' : ''}`}
              onClick={() => {
                setShowBrief(true);
                scrollToTop();
              }}
            >
              Morning Brief
            </button>

            <div className="spacer" />
            {!showBrief && (
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

      {view === 'live' && <LiveView onOpenSession={openSession} onError={setError} />}
      {view === 'calendar' && (
        <CalendarView
          cards={board.cards}
          onOpenCard={openSession}
          onCreated={refresh}
          onError={setError}
        />
      )}
      {view === 'skills' && <SkillsView onRan={openSession} onError={setError} />}
      {view === 'scheduled' && <ScheduledView onRan={openSession} onError={setError} />}
      {view === 'time' && <TimeLogView onError={setError} />}
      {view === 'agents' && <AgentsView onError={setError} />}
      {view === 'archive' && <ArchiveView onRestored={refresh} onError={setError} />}

      {onBoard && showBrief && (
        <div className="board-scroll" style={{ overflow: 'hidden', position: 'relative' }}>
          <BriefPanel />
        </div>
      )}

      {onBoard && !showBrief && (
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
                      cards={cardsIn(col.id)}
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
          onDelete={(c) => {
            if (confirm(`Delete “${c.title}”?`)) act(() => api.deleteCard(c.sessionId));
          }}
          onMoveToBoard={(c, target) => act(() => api.moveCardToBoard(c.sessionId, target))}
          onSetPriority={(c, priority) => act(() => api.setPriority(c.sessionId, priority))}
          onSetLabel={(c) => {
            const raw = prompt(
              'Label number for this card — a file number or “01953-Acme”. Leave blank to clear.',
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
