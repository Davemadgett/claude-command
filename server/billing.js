/**
 * The billing tab's data: one read of the firm's billing brain, shaped for
 * a dashboard.
 *
 * Everything the MetLife project taught us is structural here (docs/BILLING.md
 * has the full account). Billing truth lives in two ledgers — the practice-
 * management system and each carrier's portal — and the brain (a SQLite file
 * another program maintains) is where they are reconciled. So this module
 * *reads*: it opens the brain read-only per request, joins in the newest
 * carrier-portal snapshot, and reports the disagreements as loudly as the
 * balances. The one write — posting approved time entries — is delegated to
 * the brain's own approval script, so the posting policy stays in one place.
 *
 * Off until `billing.db` points at a brain, in which case the panel hides the
 * tab rather than showing an empty one.
 */

import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSetting, setSetting } from './db.js';
import * as term from './pty.js';
import { runRoutine } from './routines.js';
import { config, expandHome } from './config.js';

export function billingEnabled() {
  const db = expandHome(config.billing.db);
  return Boolean(db && existsSync(db));
}

export function approveEnabled() {
  return Array.isArray(config.billing.approveCommand) && config.billing.approveCommand.length > 0;
}

/**
 * Opened fresh per request, read-only. The brain is written by another
 * process (WAL mode), and a connection held open here would pin an old
 * snapshot of it; a per-request open always reads what was just swept, and
 * closing immediately means this server never holds a lock anyone else
 * could trip on.
 */
function open() {
  return new Database(expandHome(config.billing.db), { readonly: true, fileMustExist: true });
}

const DAY_MS = 24 * 3600 * 1000;

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

/**
 * When an unpaid bill counts as overdue. A real due date decides; without
 * one, the carrier payment cycles we know run twice-monthly, so anything
 * still open this long after issue is late by any of them.
 */
const OVERDUE_DAYS = 45;

function arRows(db) {
  const rows = db
    .prepare(
      `SELECT clio_bill_id, clio_matter_id, display_matter_number, billing_program,
              invoice_number, issued_date, due_date, amount_total, amount_paid,
              status, submission_state
         FROM invoices
        WHERE status NOT IN ('paid', 'void', 'deleted')
          AND amount_total - amount_paid > 0.005`
    )
    .all();

  return rows
    .map((r) => {
      const balance = Math.round((r.amount_total - r.amount_paid) * 100) / 100;
      const age = daysSince(r.issued_date);
      // "Due on receipt" bills carry a due date equal to the issue date, which
      // would mark every bill overdue the day it goes out. Real terms — a due
      // date actually after issue — are honored; otherwise age decides.
      const hasTerms = r.due_date && r.issued_date && r.due_date > r.issued_date;
      const overdue =
        r.status !== 'draft' &&
        (hasTerms ? (daysSince(r.due_date) ?? 0) > 0 : (age ?? 0) > OVERDUE_DAYS);
      return {
        billId: r.clio_bill_id,
        matter: r.display_matter_number,
        program: r.billing_program,
        number: r.invoice_number,
        issued: r.issued_date,
        due: r.due_date,
        total: r.amount_total,
        paid: r.amount_paid,
        balance,
        state: r.status,
        submission: r.submission_state,
        ageDays: age,
        overdue,
      };
    })
    .sort((a, b) => b.balance - a.balance);
}

function sum(rows, pick) {
  return Math.round(rows.reduce((n, r) => n + pick(r), 0) * 100) / 100;
}

/**
 * Budget health for every matter the brain has a billing profile on: what the
 * program caps it at, what extra was authorized, what has been billed and
 * paid — and the two leaks the MetLife audit taught us to watch for, in both
 * directions: billed past the budget without approval, and approval nobody
 * ever billed against.
 */
function budgetRows(db) {
  return db
    .prepare(
      `SELECT c.clio_matter_id      AS matterId,
              c.display_number      AS matter,
              c.billing_program     AS program,
              c.member_id           AS memberId,
              c.flat_rate_cap       AS cap,
              c.authorized_budget   AS authorized,
              c.hourly_rate         AS rate,
              (SELECT COALESCE(SUM(amount_total), 0) FROM invoices i
                WHERE i.clio_matter_id = c.clio_matter_id
                  AND i.status NOT IN ('void', 'deleted'))         AS billed,
              (SELECT COALESCE(SUM(amount_paid), 0) FROM invoices i
                WHERE i.clio_matter_id = c.clio_matter_id
                  AND i.status NOT IN ('void', 'deleted'))         AS paid,
              (SELECT COALESCE(SUM(approved_amount), 0) FROM requests_to_exceed r
                WHERE r.clio_matter_id = c.clio_matter_id
                  AND r.status = 'approved')                       AS rteApproved,
              (SELECT COUNT(*) FROM requests_to_exceed r
                WHERE r.clio_matter_id = c.clio_matter_id
                  AND r.status NOT IN ('approved', 'denied', 'withdrawn')) AS rteOpen
         FROM matter_billing_config c
        ORDER BY c.display_number`
    )
    .all()
    .map((r) => {
      const budget = r.cap != null || r.rteApproved > 0 ? (r.cap ?? 0) + r.rteApproved : null;
      const flags = [];
      if (budget != null && r.billed > budget + 0.005) flags.push('over_budget');
      if (r.rteApproved > 0 && r.paid <= 0.005) flags.push('approved_undrawn');
      if (r.program === 'metlife' && !r.memberId) flags.push('no_member_id');
      if (r.program === 'metlife' && r.cap == null) flags.push('no_cap');
      return { ...r, budget, flags };
    });
}

/**
 * The newest carrier-portal snapshot, if a folder of them is configured.
 * Pipe-separated, one case per line — the format the portal harvest writes.
 * Only open cases matter here: the join against the brain's member ids is
 * what surfaces portal cases no billing profile knows about.
 */
function portalReconciliation(db) {
  const dir = expandHome(config.billing.snapshots);
  if (!dir || !existsSync(dir)) return null;

  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.psv'))
      .sort();
  } catch {
    return null;
  }
  const file = files[files.length - 1];
  if (!file) return null;

  let lines;
  try {
    lines = readFileSync(join(dir, file), 'utf8').trim().split('\n');
  } catch {
    return null;
  }
  const header = lines[0].split('|');
  const col = (name) => header.indexOf(name);
  const [iStatus, iSid, iClient, iEids, iType, iStarted, iPaid] = [
    col('status'),
    col('service_id'),
    col('client'),
    col('eligibility_ids'),
    col('case_type'),
    col('started'),
    col('paid'),
  ];
  if (iStatus < 0 || iSid < 0 || iEids < 0) return null;

  const known = new Set(
    db
      .prepare("SELECT member_id FROM matter_billing_config WHERE member_id IS NOT NULL AND member_id != ''")
      .all()
      .map((r) => String(r.member_id).toLowerCase())
  );

  const open = lines
    .slice(1)
    .map((l) => l.split('|'))
    .filter((c) => c[iStatus] === 'O');

  const unmatched = open
    .filter((c) => !c[iEids].split('/').some((e) => known.has(e.trim().toLowerCase())))
    .map((c) => ({
      serviceId: c[iSid],
      client: c[iClient] ?? '',
      eids: c[iEids],
      caseType: c[iType] ?? '',
      started: c[iStarted] ?? '',
      paid: Number(c[iPaid] || 0),
    }));

  return {
    snapshot: file,
    snapshotDate: (file.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] ?? null,
    openCases: open.length,
    matched: open.length - unmatched.length,
    unmatched,
  };
}

/** Everything the panel shows, in one read. */
export function billingSummary() {
  const db = open();
  try {
    const ar = arRows(db);
    const draftBills = ar.filter((r) => r.state === 'draft');
    const overdueBills = ar.filter((r) => r.overdue);
    const awaiting = ar.filter((r) => r.state !== 'draft' && !r.overdue);

    const byProgram = {};
    for (const r of ar) {
      const key = r.program || 'unassigned';
      byProgram[key] = Math.round(((byProgram[key] ?? 0) + r.balance) * 100) / 100;
    }

    const drafts = db
      .prepare(
        `SELECT id, clio_matter_id AS matterId, display_number AS matter,
                billing_program AS program, date, hours_estimated AS hours,
                activity_code AS activity, description, rate_applied AS rate,
                cap_flag AS capFlag, cap_flag_detail AS capFlagDetail,
                billable, created_at AS createdAt
           FROM time_entry_drafts
          WHERE status = 'pending_approval'
          ORDER BY date, display_number`
      )
      .all()
      .map((d) => ({
        ...d,
        amount: d.billable === 0 ? 0 : Math.round((d.hours ?? 0) * (d.rate ?? 0) * 100) / 100,
      }));

    const PINGS_SHOWN = 40;
    const pings = db
      .prepare(
        `SELECT id, display_matter_number AS matter, severity, body, context,
                created_at AS createdAt
           FROM billing_pings
          WHERE status = 'open'
          ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                   created_at`
      )
      .all()
      .map((p) => ({ ...p, ageDays: daysSince(p.createdAt) }));

    const unbilled = db
      .prepare(
        `SELECT id, display_matter_number AS matter, description,
                estimated_hours AS hours, observed_date AS observed, source
           FROM work_unbilled
          WHERE status = 'open'
          ORDER BY observed_date`
      )
      .all();

    const sweep = db
      .prepare('SELECT started_at, finished_at, mode FROM sweep_runs ORDER BY id DESC LIMIT 1')
      .get();

    const syncedAt = db.prepare('SELECT MAX(last_synced_at) AS at FROM invoices').get()?.at ?? null;

    return {
      generatedAt: new Date().toISOString(),
      syncedAt,
      lastSweep: sweep ?? null,
      ar: {
        total: sum(ar, (r) => r.balance),
        draft: sum(draftBills, (r) => r.balance),
        awaiting: sum(awaiting, (r) => r.balance),
        overdue: sum(overdueBills, (r) => r.balance),
        overdueDays: OVERDUE_DAYS,
        byProgram,
        bills: ar,
      },
      drafts: {
        rows: drafts,
        hours: sum(drafts, (d) => d.hours ?? 0),
        amount: sum(drafts, (d) => d.amount),
      },
      pings: {
        open: pings.length,
        urgent: pings.filter((p) => p.severity === 'urgent').length,
        rows: pings.slice(0, PINGS_SHOWN),
        shown: Math.min(pings.length, PINGS_SHOWN),
      },
      budgets: budgetRows(db),
      unbilled: {
        rows: unbilled,
        hours: sum(unbilled, (r) => r.hours ?? 0),
      },
      reconciliation: portalReconciliation(db),
    };
  } finally {
    db.close();
  }
}

/**
 * Post approved drafts, through the brain's own approval script.
 *
 * The script owns the posting policy — status transitions, the practice-
 * management POST, per-program rules like contingency time going up
 * non-billable — so this function is a subprocess call and a JSON parse.
 * The caller (the panel) holds the human approval; nothing here re-asks.
 */
export function approveDrafts(ids) {
  return new Promise((resolve, reject) => {
    if (!approveEnabled()) return reject(new Error('No billing.approveCommand is configured'));
    const clean = (ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!clean.length) return reject(new Error('No draft ids to approve'));

    const [cmd, ...args] = config.billing.approveCommand.map(expandHome);
    execFile(
      cmd,
      [...args, ...clean.map(String)],
      // Each draft is a network POST; a batch of a dozen needs room.
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // The script reports per-draft failures in its JSON and exits 0; a
        // non-zero exit means it never got that far.
        let parsed = null;
        try {
          parsed = JSON.parse(String(stdout).trim().split('\n').pop());
        } catch {
          /* fall through to the error below */
        }
        if (parsed?.results) return resolve(parsed);
        if (parsed?.error) return reject(new Error(parsed.error));
        reject(new Error(err ? `Approval script failed: ${err.message}` : 'Approval script returned nothing readable'));
      }
    );
  });
}

/* ----------------------------------------------------------- the run --- */

/**
 * The one billing session the tab owns — same shape as the morning-brief run,
 * for the same reason: the billing agent asks questions (which ping, which
 * matter, approve or hold), and questions need a fixed place to be answered.
 */
const RUN_KEY = 'billingRun';

export function billingRunEnabled() {
  return /^\/[\w-]+( [\w-]+)*$/.test(String(config.billing.runCommand || ''));
}

export function billingRun() {
  const run = getSetting(RUN_KEY, null);
  if (!run?.sessionId) return null;
  return { ...run, live: term.isLive(run.sessionId) };
}

export function startBillingRun({ force = false } = {}) {
  if (!billingRunEnabled()) throw new Error('No billing.runCommand is configured');
  const current = billingRun();
  if (current?.live && !force) return { ...current, reused: true };

  const command = config.billing.runCommand;
  const { sessionId, cwd } = runRoutine({
    id: `billing_${command.slice(1).replace(/\s+/g, '_')}`,
    name: config.billing.label || command,
    command,
    cwd: homedir(),
  });
  const run = { sessionId, cwd, startedAt: new Date().toISOString() };
  setSetting(RUN_KEY, run);
  return { ...run, live: true, reused: false };
}
