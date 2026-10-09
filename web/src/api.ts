import type {
  Agents, ArchivedCard, BillingApproveResult, BillingRun, BillingSummary,
  BoardState, BoardTab, Brief, BriefRun, BrowseResult, CalendarEvent,
  AppConfig, ColumnChoice, CwdSuggestion, EngineId, EngineStatus, LabelFolder,
  LiveSession, Priority, RecentSession, Routine,
  SessionFiles, TimeLog, Transcript, Usage, UsageHistory, PlanLimits,
} from './types';

type Skill = {
  name: string;
  command: string;
  description: string;
  summary: string;
  updated: string;
};

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  /**
   * `sinceDays` — how far back to look for sessions that aren't on the board
   * yet — is deliberately not passed. The server's own setting decides it (7
   * days), because it is a discovery rule rather than a thing to look at: cards
   * already on the board, hand-written cards, and anything live are shown
   * whatever their age.
   */
  board: (opts: {
    interactiveOnly: boolean;
    includeArchived: boolean;
    boardId?: string | null;
  }) =>
    req<BoardState>(
      `/api/board?interactiveOnly=${opts.interactiveOnly}` +
        `&includeArchived=${opts.includeArchived}${opts.boardId ? `&boardId=${opts.boardId}` : ''}`
    ),

  setCaffeinate: (enabled: boolean) =>
    req<{ enabled: boolean }>('/api/caffeinate', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  addBoard: (name: string) =>
    req<BoardTab>('/api/boards', { method: 'POST', body: JSON.stringify({ name }) }),

  renameBoard: (id: string, name: string) =>
    req<{ ok: true }>(`/api/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  setBoardDefaultLabel: (id: string, defaultLabel: string | null) =>
    req<{ ok: true }>(`/api/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ defaultLabel }) }),

  deleteBoard: (id: string) => req<{ movedTo: string }>(`/api/boards/${id}`, { method: 'DELETE' }),

  createCardFromEvent: (body: {
    title: string;
    notes?: string;
    label?: string;
    startSession?: boolean;
  }) =>
    req<{ sessionId: string; started: boolean; cwd: string }>('/api/cards/from-event', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  addCard: (body: { columnId: string; title: string; notes?: string }) =>
    req<{ session_id: string }>('/api/cards', { method: 'POST', body: JSON.stringify(body) }),

  archive: (q: string) =>
    req<{ items: ArchivedCard[]; total: number }>(`/api/archive?q=${encodeURIComponent(q)}`),

  archiveCard: (sessionId: string) =>
    req<{ ok: true }>(`/api/cards/${sessionId}/archive`, { method: 'POST' }),

  restoreCard: (sessionId: string) =>
    req<{ columnId: string }>(`/api/cards/${sessionId}/restore`, { method: 'POST' }),

  /** Close a card until `wakeAt`, or pass null to cancel a scheduled return. */
  snoozeCard: (sessionId: string, wakeAt: string | null) =>
    req<{ wakeAt: string | null }>(`/api/cards/${sessionId}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ wakeAt }),
    }),

  /** Permanent. Only offered from inside the archive. */
  deleteCard: (sessionId: string) =>
    req<{ ok: true }>(`/api/cards/${sessionId}`, { method: 'DELETE' }),

  startSessionForCard: (sessionId: string, cwd?: string) =>
    req<{ sessionId: string; pid: number }>(`/api/cards/${sessionId}/session`, {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }),

  setPriority: (sessionId: string, priority: Priority) =>
    req<{ priority: Priority }>(`/api/cards/${sessionId}/priority`, {
      method: 'POST',
      body: JSON.stringify({ priority }),
    }),

  /** Attach a label by hand, or confirm the one the board guessed. */
  setLabel: (sessionId: string, label: string | null) =>
    req<{ label: string | null }>(`/api/cards/${sessionId}/label`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  dismissLabel: (sessionId: string) =>
    req<{ ok: true }>(`/api/cards/${sessionId}/label/dismiss`, { method: 'POST' }),

  moveCardToBoard: (sessionId: string, boardId: string) =>
    req<{ ok: true }>(`/api/cards/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ boardId }),
    }),

  files: (sessionId: string) => req<SessionFiles>(`/api/sessions/${sessionId}/files`),

  openFile: (path: string, reveal = false) =>
    req<{ ok: true }>('/api/open', { method: 'POST', body: JSON.stringify({ path, reveal }) }),

  moveCard: (sessionId: string, columnId: string, position: number) =>
    req<{ ok: true }>(`/api/cards/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, position }),
    }),

  updateCard: (sessionId: string, fields: Record<string, unknown>) =>
    req<{ ok: true }>(`/api/cards/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),

  addColumn: (name: string, color: string, boardId: string) =>
    req<{ id: string }>('/api/columns', {
      method: 'POST',
      body: JSON.stringify({ name, color, boardId }),
    }),

  setReviewLane: (columnId: string, enabled: boolean) =>
    req<{ laneId: string | null }>(`/api/columns/${columnId}/review-lane`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  updateColumn: (id: string, fields: Record<string, unknown>) =>
    req<{ ok: true }>(`/api/columns/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),

  deleteColumn: (id: string) => req<{ movedTo: string }>(`/api/columns/${id}`, { method: 'DELETE' }),

  reorderColumns: (ids: string[]) =>
    req<{ ok: true }>('/api/columns/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),

  reorderBoards: (ids: string[]) =>
    req<{ ok: true }>('/api/boards/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),

  transcript: (sessionId: string) =>
    req<Transcript>(`/api/sessions/${sessionId}/transcript?limit=150`),

  startSession: (sessionId: string, body: Record<string, unknown> = {}) =>
    req<{ sessionId: string; pid: number; mode: string }>(`/api/sessions/${sessionId}/start`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  stopSession: (sessionId: string) =>
    req<{ stopped: boolean }>(`/api/sessions/${sessionId}/stop`, { method: 'POST' }),

  newSession: (body: { cwd: string; title?: string; columnId?: string; engine?: EngineId }) =>
    req<{ sessionId: string; pid: number; engine: EngineId }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cwds: () => req<CwdSuggestion[]>('/api/cwds'),

  browse: (path: string) => req<BrowseResult>(`/api/browse?path=${encodeURIComponent(path)}`),

  labelFolders: () => req<LabelFolder[]>('/api/label-folders'),

  config: () => req<AppConfig>('/api/config'),

  /**
   * Choose which coding agent new sessions start as. Nothing already on the
   * board changes — a card reopens in whatever it was started in.
   */
  setEngine: (engine: EngineId) =>
    req<{ engine: EngineId; engines: EngineStatus[] }>('/api/engine', {
      method: 'POST',
      body: JSON.stringify({ engine }),
    }),

  resolveDir: (path: string) =>
    req<{ ok: boolean; path?: string; display?: string; label?: string | null; message?: string }>(
      `/api/resolve-dir?path=${encodeURIComponent(path)}`
    ),

  allColumns: () => req<ColumnChoice[]>('/api/columns'),

  briefs: () => req<Brief[]>('/api/briefs'),
  briefRun: () => req<BriefRun | null>('/api/brief/run'),
  runBrief: (force = false) =>
    req<BriefRun>('/api/brief/run', { method: 'POST', body: JSON.stringify({ force }) }),

  billingSummary: () => req<BillingSummary>('/api/billing/summary'),
  billingRun: () => req<BillingRun | null>('/api/billing/run'),
  runBilling: (force = false) =>
    req<BillingRun>('/api/billing/run', { method: 'POST', body: JSON.stringify({ force }) }),
  /** The click behind this call is the approval — the panel confirms first. */
  billingApprove: (ids: number[]) =>
    req<BillingApproveResult>('/api/billing/approve', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  live: () => req<{ sessions: LiveSession[]; rssBytes: number }>('/api/live'),

  /**
   * Close running sessions. The transcript, the card and the ability to resume
   * all survive — what ends is the process holding the conversation in memory.
   */
  stopSessions: (sessionIds: string[]) =>
    req<{ stopped: string[]; failed: string[] }>('/api/live/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionIds }),
    }),

  usage: (days: number) => req<Usage>(`/api/usage?days=${days}`),

  limits: () => req<PlanLimits>('/api/limits'),

  history: (weeks: number) => req<UsageHistory>(`/api/history?weeks=${weeks}`),

  recent: (limit: number) => req<{ sessions: RecentSession[] }>(`/api/recent?limit=${limit}`),

  calendar: (days: number) =>
    req<{ events: CalendarEvent[]; error: string | null; denied: boolean }>(
      `/api/calendar?days=${days}`
    ),

  requestCalendarAccess: () =>
    req<{ reset: string[]; granted: boolean; error: string | null; denied: boolean }>(
      '/api/calendar/permission',
      { method: 'POST' }
    ),

  skills: () => req<Skill[]>('/api/skills'),

  runSkill: (command: string, cwd?: string) =>
    req<{ sessionId: string }>('/api/skills/run', {
      method: 'POST',
      body: JSON.stringify({ command, cwd }),
    }),

  agents: () => req<Agents>('/api/agents'),

  timelog: (sinceDays: number, idleMinutes: number) =>
    req<TimeLog>(`/api/timelog?sinceDays=${sinceDays}&idleMinutes=${idleMinutes}`),

  routines: () => req<Routine[]>('/api/routines'),

  addRoutine: (body: { name: string; command: string; timeOfDay: string; cwd?: string }) =>
    req<Routine>('/api/routines', { method: 'POST', body: JSON.stringify(body) }),

  updateRoutine: (id: string, fields: Record<string, unknown>) =>
    req<{ ok: true }>(`/api/routines/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),

  deleteRoutine: (id: string) => req<{ ok: true }>(`/api/routines/${id}`, { method: 'DELETE' }),

  runRoutine: (id: string) =>
    req<{ sessionId: string }>(`/api/routines/${id}/run`, { method: 'POST' }),
};
