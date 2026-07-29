export type BoardTab = {
  id: string;
  name: string;
  position: number;
};

export type Column = {
  id: string;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  board_id: string;
  review_of: string | null;
};

export type Priority = 'high' | 'medium' | 'low' | null;

export type Card = {
  sessionId: string;
  project: string;
  cwd: string | null;
  gitBranch?: string | null;
  label: string | null;
  /** How the label was arrived at, weakest last. */
  labelSource?: 'manual' | 'cwd' | 'files' | 'prompt' | null;
  /** A name-strength guess waiting on a yes or no. */
  labelSuggested?: string | null;
  priority?: Priority;
  labelUrl?: string | null;
  labelFolder?: string | null;
  client?: string | null;
  model?: string | null;
  entrypoint: string;
  columnId: string;
  position: number;
  title: string;
  customTitle: boolean;
  notes: string;
  archived: boolean;
  pinned: boolean;
  manual: boolean;
  live: boolean;
  pid: number | null;
  exitCode: number | null;
  lastPrompt: string;
  lastAssistant: string;
  userTurns: number;
  summary: string[];
  nextEvent?: CalendarEvent | null;
  lastActivity: string;
  pending?: boolean;
  /** False when no transcript exists yet — there is nothing to resume. */
  hasTranscript?: boolean;
};

export type BoardState = {
  caffeinated: boolean;
  boards: BoardTab[];
  boardId: string;
  columns: Column[];
  cards: Card[];
  prefs: { sinceDays: number; interactiveOnly: boolean; includeArchived: boolean };
};

export type SessionFile = {
  path: string;
  name: string;
  dir: string;
  ext: string;
  source: 'tool' | 'window';
  exists: boolean;
  sizeBytes: number | null;
  mtime: string | null;
};

export type SessionFiles = {
  files: SessionFile[];
  window: { from: number | null; to: number | null };
};

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: string; verb: string | null; target: string | null }
  | { type: 'tool_result'; text: string; isError: boolean };

export type Message = {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string | null;
  model: string | null;
  blocks: Block[];
};

export type Transcript = {
  session: { sessionId: string; cwd: string | null; project: string };
  messages: Message[];
  truncated: boolean;
};

export type Routine = {
  id: string;
  name: string;
  command: string;
  cwd: string | null;
  time_of_day: string;
  enabled: boolean;
  last_run_at: string | null;
  last_session_id: string | null;
  due: boolean;
};

export type TimeLogEntry = {
  date: string;
  label: string | null;
  client: string | null;
  labelSource: 'manual' | 'cwd' | 'files' | 'prompt' | null;
  labelUrl?: string | null;
  labelFolder?: string | null;
  project: string;
  cwd: string | null;
  seconds: number;
  hours: number;
  postedHours: number;
  unbilledHours: number;
  sessions: { sessionId: string; title: string; seconds: number }[];
};

export type TimeLog = {
  entries: TimeLogEntry[];
  totals: {
    hours: number;
    labelHours: number;
    postedHours: number;
    unbilledHours: number;
    days: number;
  };
  posted: { from: string; to: string; error: string | null; configured: boolean };
};

export type AgentNode = {
  id: string;
  name: string;
  role: string;
  kind: 'person' | 'coordinator' | 'agent';
  parent?: string;
};

export type Agent = AgentNode & {
  description: string;
  tools: string[];
  model: string | null;
  parent: string;
};

export type Agents = { nodes: AgentNode[]; agents: Agent[] };

export type Brief = {
  date: string;
  file: string;
  sizeBytes: number;
  mtime: string;
};

export type BrowseResult = {
  path: string;
  display: string;
  name: string;
  parent: string | null;
  parentDisplay: string | null;
  dirs: { name: string; path: string }[];
  places: { label: string; path: string }[];
};

export type LabelFolder = {
  label: string;
  client: string;
  path: string;
};

export type ColumnChoice = {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
};

export type CwdSuggestion = {
  cwd: string;
  /** The work label, when one was detected. */
  label: string | null;
  /** What to show when there is no label — the folder's own name. */
  display: string;
  lastActivity: string;
};

export type ArchivedCard = {
  sessionId: string;
  title: string;
  notes: string;
  manual: boolean;
  label: string | null;
  labelUrl?: string | null;
  labelFolder?: string | null;
  project: string | null;
  cwd: string | null;
  lastActivity: string | null;
  userTurns: number;
  hasTranscript: boolean;
  archivedAt: string;
  columnName: string | null;
  boardName: string | null;
  columnMissing: boolean;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  calendar: string;
  location?: string;
  notes?: string;
  label: string | null;
  labelConfidence: 'number' | 'name' | null;
  labelUrl?: string | null;
  labelFolder?: string | null;
};

export type LiveSession = {
  sessionId: string;
  title: string;
  label: string | null;
  labelUrl?: string | null;
  project: string;
  cwd: string;
  pid: number;
  startedAt: string;
  lastOutputAt: string;
  quietMs: number;
  idleMs: number;
  working: boolean;
  reactivated?: boolean;
};

export type RecentSession = {
  sessionId: string;
  title: string;
  label: string | null;
  labelUrl?: string | null;
  labelFolder?: string | null;
  project: string;
  cwd: string | null;
  userTurns: number;
  lastActivity: string;
  live: boolean;
  reactivated?: boolean;
  archived: boolean;
  columnName: string | null;
  boardName: string | null;
};

/**
 * What this install calls things, and which optional panels have anything
 * behind them. Fetched once at startup — a board with no label index should
 * never render a chip it cannot fill.
 */
export type AppConfig = {
  appName: string;
  labels: { enabled: boolean; noun: string };
  reports: { enabled: boolean; label: string };
  /** Whether the `claude` command could be found. Nothing works without it. */
  claude: { found: boolean; path: string | null };
};
