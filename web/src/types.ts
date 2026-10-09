export type BoardTab = {
  id: string;
  name: string;
  position: number;
  /** Label presumed for cards here that have none of their own. */
  default_label: string | null;
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

/** Which coding agent a session is. */
export type EngineId = 'claude' | 'codex';

export type EngineStatus = {
  id: EngineId;
  name: string;
  /** False when the command isn't installed — sessions can't start in it. */
  found: boolean;
  path: string | null;
};

export type Card = {
  sessionId: string;
  /** Null on a card whose session hasn't started, so nothing knows yet. */
  engine?: EngineId | null;
  project: string;
  cwd: string | null;
  gitBranch?: string | null;
  label: string | null;
  /** How the label was arrived at, weakest last. */
  labelSource?: 'manual' | 'cwd' | 'files' | 'prompt' | 'board' | null;
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
  /** When this card is due to come back, ISO, or null. */
  wakeAt?: string | null;
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
  /** Cards waiting on the Unsorted board, whichever board you are looking at. */
  unsorted: number;
};

export type SessionFile = {
  path: string;
  name: string;
  dir: string;
  ext: string;
  /** doc = .pdf/.doc/.docx; md = markdown; other = scripts, data, everything else. */
  kind: 'doc' | 'md' | 'other';
  /** tool = a Write/Edit call; mention = a document path named in the transcript that changed during the session; received = named in the transcript, already on disk when named but arrived after the session began (a Court Watch download it handled); window = changed in the cwd while it ran. */
  source: 'tool' | 'mention' | 'received' | 'window';
  /** In a _Superseded folder, or moved into one after the session wrote it (path then points at the shelved copy). */
  superseded: boolean;
  /** A working copy in the session scratchpad, not a deliverable. */
  scratch: boolean;
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
  labelSource: 'manual' | 'cwd' | 'files' | 'prompt' | 'board' | null;
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

/** The one session the Morning Brief tab runs /morningbrief in. */
export type BriefRun = {
  sessionId: string;
  cwd: string;
  startedAt: string;
  live: boolean;
  /** Claude owes a reply. When live and not working, it is waiting on you. */
  working: boolean;
  idleMs: number | null;
  /** POST only: the run was already live, so nothing new was started. */
  reused?: boolean;
};

/** One session the Billing tab runs the billing agent in — same shape as BriefRun. */
export type BillingRun = BriefRun;

export type BillingBill = {
  billId: number;
  matter: string;
  program: string | null;
  number: string;
  issued: string | null;
  due: string | null;
  total: number;
  paid: number;
  balance: number;
  state: string;
  submission: string | null;
  ageDays: number | null;
  overdue: boolean;
};

export type BillingDraft = {
  id: number;
  matterId: number | null;
  matter: string | null;
  program: string | null;
  date: string;
  hours: number;
  activity: string | null;
  description: string;
  rate: number | null;
  capFlag: string | null;
  capFlagDetail: string | null;
  billable: number | null;
  createdAt: string;
  amount: number;
};

export type BillingPing = {
  id: number;
  matter: string | null;
  severity: string;
  body: string;
  context: string | null;
  createdAt: string;
  ageDays: number | null;
};

export type BillingBudget = {
  matterId: number;
  matter: string;
  program: string | null;
  memberId: string | null;
  cap: number | null;
  authorized: number | null;
  rate: number | null;
  billed: number;
  paid: number;
  rteApproved: number;
  rteOpen: number;
  budget: number | null;
  flags: string[];
};

export type BillingUnbilled = {
  id: number;
  matter: string | null;
  description: string;
  hours: number | null;
  observed: string | null;
  source: string | null;
};

export type BillingPortalCase = {
  serviceId: string;
  client: string;
  eids: string;
  caseType: string;
  started: string;
  paid: number;
};

/** Everything the Billing tab shows, in one server read of the billing brain. */
export type BillingSummary = {
  generatedAt: string;
  syncedAt: string | null;
  lastSweep: { started_at: string; finished_at: string | null; mode: string | null } | null;
  ar: {
    total: number;
    draft: number;
    awaiting: number;
    overdue: number;
    overdueDays: number;
    byProgram: Record<string, number>;
    bills: BillingBill[];
  };
  drafts: { rows: BillingDraft[]; hours: number; amount: number };
  pings: { open: number; urgent: number; rows: BillingPing[]; shown: number };
  budgets: BillingBudget[];
  unbilled: { rows: BillingUnbilled[]; hours: number };
  reconciliation: {
    snapshot: string;
    snapshotDate: string | null;
    openCases: number;
    matched: number;
    unmatched: BillingPortalCase[];
  } | null;
};

export type BillingApproveResult = {
  results: { draft_id: number; status: string | null; clio_time_entry_id: number | null; error: string | null }[];
  posted: number;
  failed: number;
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
  /** When this card is due to come back, ISO, or null. */
  wakeAt: string | null;
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
  /** Resident memory of the session process, or null if `ps` had nothing. */
  rssBytes: number | null;
  reactivated?: boolean;
};

/** Tokens and their list-price equivalent, however they were grouped. */
export type UsageTotals = {
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
};

export type UsageSession = UsageTotals & {
  sessionId: string;
  title: string;
  project: string;
  label: string | null;
  labelUrl?: string | null;
  model: string | null;
  /** Whether the board is the thing running it, or it just spent recently. */
  live: boolean;
  lastAt: string;
  tokensPerMin: number;
  costPerHour: number;
  /** Twelve 5-minute buckets — the last hour, oldest first. */
  spark: number[];
};

export type Usage = {
  generatedAt: string;
  windows: {
    /** `peak` is the busiest equivalent stretch in the window — the bar's scale. */
    fiveHour: UsageTotals & { peak: number; hours: number };
    today: UsageTotals & { peak: number; date: string };
    week: UsageTotals & { days: number };
  };
  active: UsageSession[];
  daily: (UsageTotals & { date: string })[];
  byLabel: (UsageTotals & {
    label: string | null;
    client: string | null;
    labelSource: 'manual' | 'cwd' | 'files' | 'prompt' | 'board' | null;
    labelUrl?: string | null;
    labelFolder?: string | null;
    sessions: number;
  })[];
  byModel: (UsageTotals & { model: string })[];
  pricing: {
    basis: string;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    models: { match: string; input: number; output: number }[];
  };
  params: { days: number; retainDays: number; rateMinutes: number };
};

/**
 * One plan week — Friday evening to Friday evening, not Monday to Sunday.
 *
 * `toDate` is what that week had spent by the same hour the current week has
 * reached, which is the only figure a half-finished week can honestly be
 * compared against.
 */
export type UsageWeek = UsageTotals & {
  start: string;
  end: string;
  current: boolean;
  /** False when the transcripts do not reach back this far. */
  covered: boolean;
  toDate: { tokens: number; cost: number };
};

export type UsageHistory = {
  /** The reset instant the weeks are aligned to. */
  anchor: string;
  anchorSource: 'plan' | 'remembered' | 'assumed';
  weeks: UsageWeek[];
  pace: {
    /** How far through the current week we are, 0 to 1. */
    elapsed: number;
    projectedTokens: number | null;
    projectedCost: number | null;
    /** Percent above or below last week at the same hour. */
    vsPrior: number | null;
  };
  coverage: { from: string | null; to: string | null; files: number };
  generatedAt: string;
};

/** One row of the plan meter — the same rows Claude Code lists under /status. */
export type PlanLimit = {
  kind: string;
  group: string;
  percent: number | null;
  severity: string;
  resetsAt: string | null;
  scope: string | null;
  isActive: boolean;
  label: string;
};

export type PlanLimits = {
  ok: boolean;
  /** Why the meter is unavailable, when it is. */
  reason: string | null;
  limits: PlanLimit[];
  extra: {
    usedCredits: number;
    monthlyLimit: number | null;
    utilization: number;
    currency: string;
    decimalPlaces: number;
    spendLimitReached: boolean;
  } | null;
  plan: string | null;
  tier?: string | null;
  fetchedAt: string;
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
  reports: { enabled: boolean; label: string; canRun: boolean };
  billing: { enabled: boolean; label: string; canRun: boolean; canApprove: boolean };
  /** Which engine new sessions start as. */
  engine: EngineId;
  /** Every engine the board knows about, and whether it is installed. */
  engines: EngineStatus[];
  /** Whether the `claude` command could be found. */
  claude: { found: boolean; path: string | null };
};
