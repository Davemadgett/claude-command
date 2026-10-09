# The Billing tab — foundation

*Drafted 2026-08-23; built the same day per DJSM's scope call (full powers —
approve-all posts to Clio from the tab — and all programs from day one). Part 1 is
the consolidated record of what the MetLife project taught us about how the firm's
billing actually works; Part 2 is what those lessons require of a billing tab;
Part 3 is the data it reads. Part 4 describes what was built: `server/billing.js`,
`web/src/components/BillingPanel.tsx`, the ⇧⌘B menu item, and
`~/code/clio-assistant/billing/approve_cli.py` (the posting bridge — a thin argv
wrapper over Bea's `apply_approval`, so posting policy stays in one place).
Configuration reference: SETUP.md §11. Expected brain tables: invoices,
time_entry_drafts, billing_pings, matter_billing_config, requests_to_exceed,
work_unbilled, sweep_runs.*

---

## Part 1 — What the MetLife project taught us

The MetLife work (July–August 2026: the AR tracker, the 243-case Service-ID harvest,
the rejected-claims diagnosis, the EFA audit) is the deepest look the firm has taken
at any billing program. Almost every lesson generalizes beyond MetLife.

### 1. Billing lives in TWO ledgers, and they disagree

Clio knows about bills; the carrier's portal knows about claims. Neither is complete:

- A Clio bill with `last_sent_at = null` is **normal** for MetLife — submission
  happens in the portal (ePSR), so Clio literally cannot see whether a bill was
  submitted. The portal Claim ID is the only submission proof.
- The 2026-08-20 portal harvest found **243 all-time cases ($323,910 paid)** — but
  only **6 of the 24 open portal cases** matched an EID in Bea's brain. One EID was
  a typo (`jhdyno0z` vs portal `jhdynvo0z`); matters were missing `member_id` or a
  billing-config row entirely.
- **$4,725 of AR was invisible** because it sat in Clio *draft* bills that were never
  issued at all (Twedt $2,900 since Feb, Loewen $1,750 since May, Nachtsheim $75).

**Lesson: a billing view is only trustworthy if it reconciles both sides and makes
the disagreements — drafts never issued, claims never submitted, EIDs that don't
join — its loudest signal.**

### 2. The tracking keys matter, and they're not Clio's keys

- **Service ID** = the case (firm rule, DJSM 2026-08-20). **EID** = the person,
  persists across cases (Riske: closed SID 4466848 + new SID 5617028, same EID).
  **Claim ID** = one submission; many claims can tie to one service (interim
  billings, corrected resubmits).
- One Clio matter ↔ portal case is **not** 1:1 (02090/02122-Juarez share SID 5469527;
  Serrano had CT-750 and CT-500 services in parallel).
- Every payment communication, PSR, and chase is logged against the Service ID
  (wiki: `organizations/carriers/metlife.md` communications log).

**Lesson: the tab must display and join on program-native keys (Service ID / EID /
Claim ID), not pretend Clio matter numbers are the universe.**

### 3. "Rejected" usually means "you didn't answer a question"

The 2026-08-21 diagnosis of the 5 portal "Claim Rejected" services: **4 of 5 were
Billing Inquiries** (PLF Manual §VII.H — a request for missing info, not a denial)
that *aged into rejections* because nobody resubmitted within MetLife's window.
Roughly **$5,475 was recoverable** (Handlen $3,500, Brummer $2,000 likely already
superseded, Deroubaix $1,050, Hammill $925); only Serrano was a true coverage denial.

Shared defect: **total hours worked not stated** on the invoice or in comments.
Standing fixes adopted: a "Total hours worked: X.X" line in every MetLife PSR
comment, always attach the timesheet + any EFA letter, and a tickler so inquiries
get answered before they rot.

**Lesson: the tab needs an "answer required" lane with ages/deadlines — inquiries,
chases, and resubmits are time-fused work items, not passive statuses.**

### 4. Budgets are approved, then leak

- EFA/RTE life-cycle: request BEFORE the work (late requests "reduced or denied"),
  approval letter sets a cap + hourly rate, letter must be attached to the final PSR.
  Tracked in `requests_to_exceed` (requested vs approved vs status).
- The follow-on audit found **approved EFAs with no corresponding hours or payments**
  (exemplar: 02066-Riske EFA approved 5/13 vs portal case closed 1/7 with $0 paid) —
  approved money nobody billed.
- Flat caps are real: contested divorce $2,400 max, CT-750 $2,000 max, etc. Bea pings
  when time entries approach a cap so the EFA goes in *before* the overage.

**Lesson: the tab must show, per flat-fee/carrier matter: cap, approved budget,
billed-to-date, paid-to-date — and flag both directions of leak (over cap without
EFA; approved EFA never drawn).**

### 5. Timing gates and cycles decide when money moves

- Services may only be billed after their trigger (divorce → final decree; Ch. 7 →
  first meeting; criminal → sentencing…). Early bills are simply not paid.
- MLP pays on a **twice-monthly cycle** via Tipalti — so "submitted, awaiting
  payment" has an expected-payment window, and a claim outside it is *late*, not
  merely pending.
- New portal rule (banner, 8/20): **all potential services must be entered within
  5 days** of eligibility check or work start.

**Lesson: statuses need clocks. The tab should compute "expected by" and "overdue
by," not just show a state string.**

### 6. Program rules are learnable and must be encoded, not remembered

The metlife.md profile (in `billing_programs/`) now carries carrier case-law:
Debt Defense CT-320 controls in *any* court (Nodzak 2026-01-20); criminal-complaint
matters are never CT-750 (four Serrano denials); consultation fees absorb into
standard fees; no client billing on covered matters (panel-removal risk); routine
costs never billable. Each rule was paid for with a rejection or a near-miss.

**Lesson: the tab's job is surfacing *violations* of the encoded rules (Bea's
observations/pings), not re-deriving the rules. Bea's brain is the rules engine;
the tab is the instrument panel.**

### 7. The harvest pattern works

`attorneys.legalplans.com/api/v1/cases` gave us the full case roster in one pull →
snapshot to `raw/metlife-snapshots/cases-YYYY-MM-DD.psv` → registry page joins
portal EIDs against Bea's `matter_billing_config`. The same pattern (pull → raw
snapshot → join → surface the mismatches) is how every carrier view should refresh.
*Gap: the pull was done ad hoc; no reusable authenticated script exists yet.*

### 8. Approval is a human gate, batched

Nothing posts to Clio without DJSM's explicit approval; >5 pending drafts are
presented as **one table with a single approve-all** (his standing preference).
Contingency matters still capture time — as non-billable — and Clio rounds UP to
0.1h, so staged entries sit on 0.1 multiples.

**Lesson: the tab's interactive core is the approval queue, and it must batch.**

---

## Part 2 — What the tab therefore must show

Derived directly from the lessons above, in priority order:

1. **Money out / money stuck (AR)** — outstanding by matter and program, split into
   *draft never issued* / *submitted awaiting* / *overdue vs expected-payment
   window*. (Lessons 1, 5.)
2. **Answer-required queue** — Billing Inquiries, chases, resubmits, pings awaiting
   DJSM, each with age and $-at-stake. (Lessons 3, 6.)
3. **Approval queue** — pending `time_entry_drafts`, batched, one approve-all.
   (Lesson 8.)
4. **Budget health per carrier matter** — cap / EFA approved / billed / paid, with
   approach-cap and undrawn-EFA flags. (Lesson 4.)
5. **Reconciliation deltas** — portal cases with no Clio join, missing member_id /
   Service ID / billing config, EID mismatches. (Lessons 1, 2, 7.)
6. **Unbilled work** — `work_unbilled` open items. (Lesson 1's cousin: work that
   never became a bill is the other invisible AR.)

## Part 3 — Data we already have

| Source | What it holds | Access |
|---|---|---|
| `~/code/clio-assistant/billing/billing.sqlite` | matter_billing_config, invoices, payments, requests_to_exceed, billing_pings, billing_observations, work_unbilled, time_entry_drafts/queue, sweep_runs | read-only SQLite; WAL mode; live (updated by Bea's sweeps) |
| Clio API (`clio_client.py`) | live bill states/balances per matter | `metlife_ar.py` is the working exemplar (matter list from brain → `/bills.json`) |
| `~/MadgettLawWiki/organizations/carriers/metlife-service-registry.md` + `raw/metlife-snapshots/*.psv` | all-time portal case roster (Service ID, EID, CT, status, paid) | file read; refreshed by future harvests |
| `billing_programs/*.md` (metlife, legalease, direct, contingency) | program rules, contacts, fee schedules | file read |
| Bea (agent) | the sweeps, the walkthrough, drafting entries | on demand — the tab's "Run" session, like Morning Brief's |

## Part 4 — Proposed shape (pending DJSM)

Mirror the Morning Brief tab exactly where the pattern fits: a board-level tab
(`Billing`, ⌘⇧B or picked from tabs row), server routes under `/api/billing/*`
reading billing.sqlite + a cached Clio AR pull, and a remembered **Bea run session**
(Run button → PTY session, same plumbing as the brief run) for sweeps and the
approval walkthrough. Sections in the order of Part 2: headline AR bar → answer-
required → approvals (batched table, approve-all) → budget health → reconciliation
→ unbilled. All writes stay in Bea's existing approval flow — the tab itself never
posts to Clio.
