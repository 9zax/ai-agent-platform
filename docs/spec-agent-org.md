# Spec — Agent Org: competitor-inspired features

> Status: approved scope (2026-10-23). Implementation follows this document.
> Reference: Paperclip (paperclip.ing / paperclipai/paperclip) — strengths adapted to
> this platform's identity: **single user, real host tmux sessions, real git/PR, no Docker.**

## 1. Goal

Turn the platform from "a team that can run one mission" into "an organization you can
operate": money is visible and bounded, work can start on a schedule, nothing is pushed
without review, any CLI agent can be hired, every agent knows the goal and its boss, and
artifacts are discussable.

## 2. Decisions (locked with the user)

1. Scope: **all six features** — cost ledger/budgets, routines, review gate, BYO harness,
   goal ancestry/org-lite, artifact comments + skill test bench.
2. Budget limit: **pause** the run as `waiting_human` and ask the user to raise the budget.
   Never silently continue and never hard-kill work.
3. Review gate: runs **before push/PR**. Reject sends the Dev back for one revision, then
   re-reviews. A second reject (or a timeout) skips the PR with an honest reason.

## 3. Non-goals

- Multi-organization, RBAC, hiring approvals, "company" metaphor.
- Mobile-first redesign.
- A real database. All state stays in `./data/*.json` (atomic tmp+rename).
- Exact provider billing. Costs are token-based estimates from a configurable price table.

## 4. Data model

All new fields are `#[serde(default)]` so existing `runs.json` / `projects.json` still load.

### 4.1 `Persona` (persisted: `personas.json`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reports_to` | `String` | `""` | role id of the manager (`""` = top of the org) |
| `harness` | `String` | `"native"` | `native` = built-in provider loop; `claude`, `codex`, `custom` = external CLI |
| `harness_command` | `String` | `""` | command template for `custom` (and optional override for presets) |

### 4.2 `Project` (persisted: `projects.json`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `goal` | `String` | `""` | the standing "why" injected into every step |
| `budget_usd` | `Option<f64>` | `None` | per-run budget snapshot; `None`/`0` = unlimited |
| `budget_alert_pct` | `u8` | `80` | warn once when spend crosses this % |

### 4.3 `Run` (persisted: `runs.json`)

| Field | Type | Meaning |
|---|---|---|
| `trigger` | `String` | `manual` \| `scheduled` \| `loop` \| `retry` |
| `routine_id` | `Option<String>` | set for scheduled runs |
| `budget_usd` | `Option<f64>` | snapshot at spawn (routine/manual) |
| `cost_usd` | `f64` | sum of step costs |
| `input_tokens` / `output_tokens` | `u64` | sum of step usage |
| `cost_alerted` | `bool` | threshold notice already emitted |
| `review` | `Option<RunReview>` | pre-push review state |
| `goal` | `String` | project goal snapshot (run history survives project edits) |

`RunReview { status: pending|approved|rejected|timed_out, diff, files, comment, requested_at, decided_at }`

### 4.4 `RunStep`

Add: `harness: Option<String>`, `input_tokens: u64`, `output_tokens: u64`,
`cost_usd: f64`, `metered: bool` (false for external harnesses).

### 4.5 New entities

```rust
Routine { id, project_id, name, task, cron, enabled, loop_mode,
          last_run_at, last_run_id, last_result, created_at }

DocComment { id, project_id, doc_id, author, quote, body,
             status: open|resolved, created_at, resolved_at }

Skill { id, name, description, enabled,
        version: u32,
        test_inputs: Vec<String>,
        test_runs: Vec<SkillTestRun>,      // cap 20
        history: Vec<SkillSnapshot> }      // cap 20, previous versions

SkillTestRun { id, input, output, model, at, cost_usd }
SkillSnapshot { version, name, description, enabled, at }
```

### 4.6 Persistence layout

| File | Contents | Mode |
|---|---|---|
| `runs.json` | runs (+ review/cost) | 0644 |
| `projects.json` | projects (+ goal/budget) | 0644 |
| `docs.json` | docs + comments | 0644 |
| `personas.json` | personas | 0644 |
| `skills.json` | skills + test bench | 0644 |
| `tasks.json` | board tasks | 0644 |
| `routines.json` | routines + counter | 0644 |
| `config.json` | provider config incl. keys | **0600** |

`config.json` holds API keys / Git token; it is written 0600 and never returned raw
(`GET /config` keeps masking). Environment variables still win when the file has no value.

## 5. Feature specifications

### 5.1 Cost ledger + budget guardrail

**Capture.** Every provider call returns `{ input_tokens, output_tokens }`:
- Anthropic: `usage.input_tokens` + cache tokens, `usage.output_tokens`.
- OpenAI-compatible: `usage.prompt_tokens`, `usage.completion_tokens`.

`llm_max` keeps its signature; a new `llm_max_usage` returns `(text, LlmUsage)`.
`llm_retry_usage` mirrors `llm_retry`. Call sites that know their step record usage via
`record_usage(run_id, role, kind, usage)`; calls without a step (meeting answers, PR text,
demo, PO summary, loop decision) record to the run totals only.

**Price.** `AiConfig.pricing: HashMap<String, ModelPrice>` plus
`default_input_per_mtok` / `default_output_per_mtok` (default `0.0`).
`ModelPrice { input_per_mtok, output_per_mtok }`. Unknown model → default price and the
step is marked `priced: false` (UI shows "estimate unavailable"). Prices are editable in
Settings → AI Config; seeded values are documented as approximate.

**Totals.** After each step: recompute `Run.cost_usd`, token sums; persist. Threshold alert
(`budget_alert_pct`, once per run) sets `cost_alerted` and shows an amber badge in Mission
Control; it does not interrupt work.

**Guard.** `guard_budget(run_id)` is called before every provider/harness call in a run:
- `budget_usd` unset/0 or `cost_usd < budget` → continue.
- `cost_usd >= budget` → create `Discussion{kind:"budget", from:"orchestrator", to:["human"],
  status:"need_human"}`, set run `waiting_human`, post totals, then wait.
- User raises budget via `POST /runs/{run_id}/budget {budget_usd}`; the endpoint appends a
  human message ("budget raised to $X") so the wait resumes. A plain reply does not raise it.
- Timeout (1 h, existing `HUMAN_TIMEOUT_SECS`) → **stop** the run (unlike a normal meeting,
  continuing would keep spending).

**API**
- `POST /runs/{run_id}/budget` → update `Run.budget_usd` (must be > current cost).
- `GET /config` / `PUT /config` → expose and edit pricing + defaults (keys stay masked).

**UI**
- Mission Control: cost chip (`$0.042 / $5.00`, tokens), progress bar, amber alert badge.
- Timeline step rows show tokens + cost; external-harness steps show "unmetered".
- Project form: `budget_usd`, `budget_alert_pct`; Settings → AI Config: price table.
- Budget pause renders as a need-human card with "Raise budget" input + "Stop run".

### 5.2 Scheduled routines

**Model.** 5-field cron (`minute hour dom month dow`), local time. Support `*`, numbers,
lists `1,15`, ranges `9-17`, steps `*/5`. Validate at create; reject invalid with a clear
message. `next_run_at` is computed on read, not stored.

**Scheduler.** Tokio task, tick every 30 s:
- for each enabled routine whose next occurrence ≤ now:
  - if the project already has a `running`/`waiting_human` run → skip; set
    `last_result = "skipped: project busy"`, advance `last_run_at = now`.
  - else spawn a run with `trigger:"scheduled"`, `routine_id`, project budget snapshot,
    `loop_mode` from the routine; set `last_run_at`, `last_run_id`, `last_result = "started"`.
- Restart-safe: state lives in `routines.json`; missed occurrences while the orchestrator
  was down are not replayed (only the next future occurrence runs).

**API**
- `GET /projects/{id}/routines` (includes computed `next_run_at`)
- `POST /projects/{id}/routines`
- `PUT /routines/{rid}`, `DELETE /routines/{rid}`
- `POST /routines/{rid}/run` (manual trigger regardless of schedule)

**UI**
- New "Routines" tab on the project page: list (name, cron, next run, last result, enabled
  toggle), create/edit dialog, "Run now".
- Run history marks scheduled runs with a clock badge and links back to the routine.

### 5.3 Diff review gate (before push/PR)

**When.** After the meeting loop and QA are done, before `run_pr_stage`.

**Diff.** In the project repo on the dev agent:
`git status --porcelain` (files), `git diff --stat`, and `git diff` capped at 16 000 chars
(binary files listed only). If the repo is missing / has no changes, the gate is skipped
(PR stage will report the same honest reason).

**Flow.**
1. Persist `Run.review { status:"pending", diff, files, requested_at }`.
2. Create `Discussion{kind:"review", from:"orchestrator", to:["human"], status:"need_human"}`
   with the stat and a diff excerpt; set run `waiting_human`.
3. `POST /runs/{run_id}/review { decision: "approve"|"reject", comment }`:
   - approve → `review.status="approved"`, human message "APPROVE", resume.
   - reject → `review.status="rejected"`, human message "REJECT: <comment>", resume.
   - generic `reply_discussion` also accepts a message starting with `APPROVE` / `REJECT`.
4. Approve → run the PR stage as today.
5. Reject (first time) → re-prompt the Dev with the diff + comment, apply changed FILES,
   recompute the diff, and open a second review. Second reject → PR step `skipped` with
   "rejected by reviewer", no push.
6. Timeout → `review.status="timed_out"`, PR `skipped`; nothing is pushed.

**UI**
- Review card in Mission Control: file list, diff viewer (monospace, scroll), comment box,
  Approve / Reject buttons. Reject wires the comment into the Dev revision.
- The need-human inbox already routes to Mission Control; the card is the action surface.

### 5.4 BYO harness per persona

**Model.** `harness` selects how a persona "thinks":
- `native` (default): today's provider loop.
- `claude` / `codex`: presets that shell out to the installed CLI.
- `custom`: user command template.

Template placeholders: `{prompt_file}`, `{model}`, `{role}`. Presets:
`claude` → `claude -p "$(cat {prompt_file})"`; `codex` → `codex exec "$(cat {prompt_file})"`.
A user override (`harness_command`) wins when non-empty.

**Execution.** In relay and meeting-revision steps only (tail stages stay native):
1. `guard_budget` (external harness is unmetered, so it is blocked only by prior spend).
2. Build `system + user` prompt, write to `<data>/tmp/harness-<n>.md` (0600).
3. Check `command -v <binary>` inside the agent session; if missing → step `error` with
   "install X or switch this persona to native" (never silently fall back).
4. Run via `hostexec::run` with a 30-minute timeout; capture stdout+stderr as the
   deliverable. External harnesses edit the repo directly, so **no FILES application** is
   performed for them.
5. Parse `## ASK` from the output as usual; mark `step.harness`, `step.metered=false`.
6. Delete the prompt file.

**API**
- `GET /agents/harnesses` → presets + `available` (`command -v` on the host) + template.
- Persona create/update accepts `harness`, `harness_command`; validate ids.

**UI**
- Persona editor: harness select with availability badge; command field for `custom`;
  helper text explaining that external harnesses work in the repo directly and are unmetered.
- Team card: small harness badge when not native.

### 5.5 Goal ancestry + org-lite

**Model.** `Project.goal`; `Persona.reports_to`. Run snapshots the goal.
Defaults:
`po: ""`, `ba: po`, `sa: ba`, `ux-ui: sa`, `ux-ui-2: ux-ui`, `dev-fe: sa`,
`dev-be: sa`, `dev-be-2: dev-be`, `qa: sa`.

**Prompt.** `work_system` gains a goal section:
```
## Goal ancestry
Project goal: <goal>
Your role: <title>, reporting to <manager name/title>.
Every deliverable must move the project goal forward; say how in one line.
```
Also included in meeting answers, PR text, demo prompts, and the PO summary.

**UI**
- Project create/edit: Goal field (textarea) + budget fields.
- Team page: "Org" toggle showing a lightweight nested list (manager → reports), with
  click-to-edit; no new canvas.
- Project header shows the goal as a subtitle when present.

### 5.6 Artifact comments + skill test bench

**Doc comments.**
- Any project doc can carry threaded comments anchored to a quoted passage.
- `POST /projects/{id}/docs/{doc_id}/comments { quote, body }`
- `PUT /projects/{id}/docs/{doc_id}/comments/{cid} { body?, status? }`
- `DELETE .../comments/{cid}`
- Open comments are injected into the team's docs section for that project, so the next
  mission sees "review comments still open" and can address them.
- UI: selecting text in the doc viewer pre-fills the quote; comment list under the doc with
  resolve/reopen; count badge on the Docs tab.

**Skill test bench.**
- `POST /skills/{id}/test { input }` runs the active provider's default model with a system
  prompt built from the skill, stores a `SkillTestRun` (cap 20), returns it. If no model/key
  is configured → 400 with a clear message. Cost is recorded on the test run only.
- `PUT /skills/{id}` accepts `name`, `description`, `enabled`; each change pushes the previous
  snapshot to `history` (cap 20, `version` increments).
- `POST /skills/{id}/restore/{version}` restores a snapshot (and snapshots the current one).
- UI: "Test" opens a dialog (saved inputs as chips, output pane, run history); "History"
  lists versions with a Restore action.

## 6. Security notes

- `config.json` is 0600; keys remain server-side and masked in `GET /config`.
- Harness templates are user-controlled and run as the user — documented as a single-user
  feature. Prompt files are 0600 and deleted after the run.
- Diff content can contain secrets from the repo; it is stored in `runs.json` and shown only
  behind the login gate. Diff is capped; binary content is never inlined.

## 7. Compatibility / migration

- Old `runs.json`, `projects.json`, `docs.json` load unchanged thanks to serde defaults.
- Old `paused.json` / `agents.json` untouched.
- First boot with this build seeds `personas.json`, `skills.json`, `config.json`,
  `tasks.json`, `routines.json` from current in-memory seeds, then persists changes.
- No Docker paths are introduced.

## 8. Test plan

- `cargo check` + `cargo test` (new unit tests: cron parsing/next-run, pricing math,
  review decision parsing, budget threshold).
- Playwright e2e (mocked API):
  - budget: runs list shows cost; budget pause card raises budget and resumes.
  - routines: create/edit/toggle, next-run renders, run-now triggers.
  - review: pending diff card approve → PR step; reject → Dev revision + second review.
  - comments: create from selection, resolve, badge count.
  - skill bench: test run renders output, history restore.
- Manual: one real mission on a repo to confirm diff/review/PR and harness detection.

## 9. Rollout order

1. Persistence foundation (personas/config/skills/tasks + new files).
2. Cost ledger + budgets (needed before autonomy).
3. Routines (uses budget snapshot).
4. Review gate.
5. BYO harness.
6. Goal/org (small, can land alongside 2–3).
7. Comments + skill bench.
8. Tests + docs/screenshots.
