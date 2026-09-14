# Strategy coach

Status: **accepted product direction (D58).** Implementation is AGENT-16. Do not treat
this as Jobs V2 cutover work. Do not silently amend frozen `SPEC-*` / `EXEC-*` IDs;
extend them only via the COACH-* requirements below.

Normative for AGENT-16. A cheaper model implementing a ticket MUST cite requirement IDs
and MUST NOT invent architecture. If a requirement is ambiguous, stop and escalate.

Release order (tick as work lands): [`docs/release-roadmap.md`](release-roadmap.md) R1
(interactive `/coach`, Magpie Execute auto-invoke, then T06 closed loop) then R3
(job-invoked). Do not treat T04 as R1. T05 invocation is not R1.E2. T06 is R1.

Related:

- `docs/decisions.md` D12, D25, D26, D28, D29, D44, D52, D58
- `docs/autonomous-agent.md` — environment diagnosis; this is the missing strategy layer
- `docs/jobs-v2-spec.md` — EXEC-04 context, QUALITY-04 review op, OBS-04 phase routing
- `docs/example-prompts/party.txt` — motivating task
- Live evidence: `goal_mtrvevpq001`, operator-guided Instagram rerun,
  `goal_mtumeewm001` (Execute did not invoke `/coach`; AGENT-16-T05), and
  `goal_mtvqt1a6001` (host `/coach` fired, harvest ignored; AGENT-16-T06) in
  `docs/live-run-evidence-log.md`

---

## 1. The idea

Browser harvest tasks are usually a **high-level algorithm over fuzzy data, looped**.
Coding tasks usually are not. A coding agent can grep; a browser agent must discover a
repeatable acquisition route on a site it has not seen, then apply a fuzzy qualifier to
each entity.

Four layers, not three:

| Layer | Who | What |
| --- | --- | --- |
| 1. Goal / spec | Operator + planner | What counts as success. Immutable while executing. |
| 2. **Coach strategy** | Coach (expensive, read-only) | How to acquire and filter without wandering, while still meeting qualification quality. A guideline, not a program. |
| 3. Page plan | Executor | Bounded actions on the current page (D18). |
| 4. Harness | Runtime | Execute and verify one action (D17). |

The product already has 1, 3, and 4. Layer 2 is the gap.

### Evidence that settled the shape

Same prompt (`docs/example-prompts/party.txt`): find popular Minsk party-goers to invite
in exchange for free passes.

1. **Plan with an expensive model, execute with GLM.** The planner did not know what the
   site actually offered. Execution wandered.
2. **All GLM.** Same wandering.
3. **All GLM, with an operator-written route:** search venues → open tagged posts → treat
   taggers as party-goer proxies → peek each profile and qualify. Much less wandering.

The expensive planner failed because it planned *before* the browser taught it anything.
The operator guide worked because it was a **task-specific acquisition strategy** written
after knowing Instagram's affordances. `/coach` is that guide, produced from a real scout
instead of from the operator's head.

### What the coach is

A **strategy critic**. It reads a compressed trajectory since the last coaching
checkpoint and writes a bounded guideline the cheap executor can loop.

It is not:

- a second initial planner guessing approaches with no site evidence
- a program / page-plan / Playwright script
- a spec revision (criteria, sources, outreach, effects)
- a no-progress breaker (AGENT-15 already stops loops; coach diagnoses *route*)
- a memory store that authorizes actions (D25)

### Planner-owned policy, job-invoked

Auto-coach is not a host heuristic on a wall-clock. The **planner puts coaching in the
plan when the efficient loop is unknown.** The job (or `/plan` execution) then invokes
it as a scheduled step.

The planner can decide this without knowing Instagram tagged pages:

> This is a harvest over fuzzy data. I cannot name a high-confidence acquisition loop.
> Do not scale. Scout under a tight budget, call the coach, then harvest on the
> resulting guideline.

That is **scout → coach → rest**, not **try search, then hashtags, then explore, then
coach**. Inventing approaches to burn before coaching is the failure mode of run (1).

---

## 2. Product behavior

### 2.1 When the planner includes coaching

The planner classifies the objective:

| Class | Include coach? | Typical shape |
| --- | --- | --- |
| `calibration_required` | Yes | Many similar entities, fuzzy qualification, unknown route |
| `known_flow` | No | Short reversible flow the model already scripts (D26) |
| `criteria_unsettled` | No — ask the operator | Success, sources, or outreach still undefined |

Soft “include if it might help” is forbidden. Cargo-cult coach steps and missing coach
steps both come from optionality.

### 2.2 Planned steps

For `calibration_required`:

1. **Scout** — small budget (candidates, site actions, or one completed sample of the
   suspected loop). Record yield. Stop even if the list is incomplete.
2. **Coach** — read-only, expensive model, digest in, strategy artifact out. Browser
   mutations off. In Magpie chat, `/plan` Execute SHALL invoke the same `/coach`
   handler after pre-coach plan steps complete (AGENT-16-T05). The executor MUST NOT
   be given the coach-role todo as remaining work.
3. **Harvest** — blocked on a valid strategy artifact. Cheap model. Repeated loop.
   Same qualification criteria as the spec. The first artifact is a **trial**: harvest
   MUST try it until `falsify` or a yield breaker, record `candidate_*`, and MUST NOT
   invent a second plan. Magpie Execute then leases `/coach` again (rescue).

Optional later **rescue** coach: the spec names yield breakers (actions without a new
qualified candidate, navigation cycles, repeated observation hashes). Wall-clock alone
MUST NOT fire a coach. In Magpie chat, Execute is the scheduler analogue (AGENT-16-T06):
`MAGPIE_RESCUE_ACTIONS_WITHOUT_YIELD` (12) site actions without a new `candidate_*`,
or `MAGPIE_RESCUE_NAVIGATION_CYCLES` (2), or `lost_place`. A second empty rescue
halts for the operator. Jobs rescue stays AGENT-16-T04.

### 2.3 Manual `/coach`

The operator may invoke `/coach` at any time during a goal or job. That is the same
review operation, not a second mechanism. It still receives a digest, not the
transcript, and still cannot rewrite the spec.

### 2.4 What the operator sees

- Plan approval shows scout / coach / harvest as distinct steps.
- `/coach` (and a scheduled coach) shows: waste found, recommended loop, stop rules,
  confidence, what the executor must record.
- Harvest continues only after a valid artifact exists (or the operator skips with an
  explicit “continue without coaching” choice, which is recorded).

---

## 3. Requirements (COACH-*)

RFC 2119. Cite these IDs in tickets. Do not invent sibling IDs.

### Vocabulary

| Term | Meaning | Not |
| --- | --- | --- |
| Scout | Bounded first attempt to learn a route | The harvest |
| Coach | Read-only strategy critic | Planner, executor, spec author |
| Strategy artifact | Bounded guideline + decision tree | Page plan, Playwright, transcript |
| Trajectory digest | Compressed evidence since last checkpoint | Snapshots, tool schemas, chat |
| Yield event | Semantic progress: candidate/fact accepted, rejected, duplicate | A click that returned `ok` |
| Calibration | First coach, after scout | Periodic timer |
| Rescue | Later coach, after a spec yield breaker | Guessed fallback list |
| Checkpoint | Last coach (or goal start) | Compaction of every turn (D52) |

### Digest (COACH-01 … COACH-04)

**COACH-01.** A trajectory digest SHALL be compiled from durable evidence (ledger,
metrics, yield events, current facts, current page identity) since the last coaching
checkpoint. Full transcripts, raw snapshots, and tool-schema bytes MUST NOT be coach
prompt state.
- Rationale: the Instagram run peaked at 1.6MB context; the coach should learn the
  *route*, not re-read every profile snapshot
- Owner: `src/runtime/coach/digest.ts`
- Invariant: digest byte length ≤ `COACH_DIGEST_MAX_BYTES` (32_768)
- Evidence: L0 fixtures (wandering vs guided)
- Ticket: AGENT-16-T01

**COACH-02.** The digest SHALL include, when known:

- goal text and immutable qualification criteria
- declared scout/harvest strategy (if any)
- counts: accepted / rejected / duplicate / visited URLs
- rejection reason histogram (capped)
- action sequence as `{turn, tool, intent, pageIdentity, summary, ok, elapsedMs, costUsd?}`
- repeated observation hashes, zero-change reads, navigation cycles
  (list → entity → back → lost place)
- failed / no-op / refused actions
- turns, site actions (real `act`, not all tool calls), wall time, cost since checkpoint
- current page summary (url, title, control count — not the control list)
- previous strategy artifact and whether harvest followed it
- remaining scout/harvest budgets

A snapshot excerpt MAY appear only as a short quote attached to a specific failure,
capped at 500 characters, and only when the summary cannot explain that failure.
- Owner: `src/runtime/coach/digest.ts`
- Ticket: AGENT-16-T01

**COACH-03.** Executors SHALL record yield events, not only tool `ok`. Minimum kinds:
`candidate_accepted`, `candidate_rejected`, `candidate_duplicate`, `fact_established`,
`route_affordance` (e.g. “tagged posts exist”), `lost_place`. Clicks without a yield
event are not semantic progress.
- Rationale: AGENT-15 no-progress is about failed actions; coaching is about wasted
  *successful* wandering
- Owner: `src/core/ledger.ts` (event type) + harvest card/tools
- Ticket: AGENT-16-T01

**COACH-04.** Digest compilation SHALL be pure and host-neutral. Pi transcripts,
Playwright, and job SQLite MUST NOT be required to unit-test a digest.
- Owner: `src/runtime/coach/digest.ts`
- Ticket: AGENT-16-T01

### Strategy artifact (COACH-05 … COACH-08, COACH-20)

**COACH-05.** Coach output SHALL validate against a closed schema before it can block or
unblock harvest. Unknown keys dropped. Lists and strings hard-capped (same spirit as
`src/runtime/site-skill.ts`).
- Owner: `src/runtime/coach/strategy.ts`
- Ticket: AGENT-16-T02

Required fields:

```typescript
interface StrategyArtifact {
  schemaVersion: 1;
  summary: string;                 // ≤ 400 chars
  loop: string[];                  // ordered acquisition steps, ≤ 8 × 200 chars
  qualify: string[];               // how to apply existing criteria, ≤ 8 × 200
  exceptions: string[];            // decision-tree branches, ≤ 8 × 200
  record: string[];                // what to write so the next digest works, ≤ 8 × 200
  stop: string[];                  // when to stop or call rescue, ≤ 8 × 200
  doNot: string[];                 // wasted routes to avoid, ≤ 8 × 200
  confidence: "low" | "medium" | "high";
  falsify: string;                 // what observation would kill this guideline, ≤ 200
  assumptions: string[];           // ≤ 6 × 160
}
```

Prose MAY be shown to the operator. Only the parsed artifact is prompt state for harvest.

**COACH-06.** A strategy artifact MUST NOT change qualification criteria, in-scope /
out-of-scope sources, effect envelope, or approval policy. A validator SHALL reject
output that tries (explicit `criteria:`, `grant:`, `send:`, `follow:`, or rewritten
success predicates). Route changes only. Mentioning an existing follower threshold
without lowering it is not a rewrite (AGENT-16-T06).
- Rationale: QUALITY-01 / D20 / D23 — coach is not the spec author
- Owner: `src/runtime/coach/strategy.ts`
- Ticket: AGENT-16-T02, AGENT-16-T06

**COACH-07.** The artifact is untrusted guidance (D25). It MAY seed peek/survey/order of
reads. It MUST NOT skip postconditions, authorize commits, or be used as a selector.
Harvest still obeys D17 / D44 (`peek` for list items, do not navigate away and lose
place). Magpie harvest copy requires trying the trial loop until falsify, then stopping
for host `/coach` — not treating STRATEGY as authority that bypasses the live page.
- Ticket: AGENT-16-T02, AGENT-16-T06

**COACH-08.** Rendering onto the harvest card SHALL be short and once-per-task (D29),
in the same consume-only style as site skill. Do not paste the digest into harvest
context.
- Owner: `src/runtime/card.ts` (render helper) + ContextCompiler for jobs
- Ticket: AGENT-16-T02, AGENT-16-T04

**COACH-20.** Coach SHALL name a repeatable acquisition loop that still meets the spec's
qualification quality. Efficiency is waste-reduction (peek vs losing the list, D44), not
substituting Magpie Chrome with curl or a coder fetch script. If scout evidence includes
empty JS shells, fetch-only HTML, or required fields left unknown, the artifact MUST
include an `exceptions` branch that escalates those rows to `observe` (rendered page).
A guideline that scales “mark unknown and move on” for fields the spec required verifying
on the product is incomplete. Rescue coach SHALL treat a harvest that only produced
thin/unknown cells on JS-heavy pages as a falsified cheap route, not a finished matrix.
- Rationale: `goal_mtz1c1ar001` scaled pricing-page fetch; SPA trust portals stayed unknown
- Owner: `src/host/pi-coach.ts` instructions, `STRATEGY_JSON_EXAMPLE`, harvest Execute hint
- Ticket: none yet (prompt/schema example change; not a new scheduler)

### Planner policy (COACH-09 … COACH-11)

**COACH-09.** Plan-mode context SHALL tell the planner:

- If you cannot name a high-confidence acquisition loop, you MUST NOT author a long
  harvest.
- You MUST author scout (tight budget) → coach → harvest blocked on the coach artifact.
- You MUST NOT invent a list of site tactics to exhaust before coaching.
- Coach is a guideline generator, not a second planner.
- The guideline MUST preserve qualification quality (when to peek vs observe), not
  replace Magpie Chrome with cheaper fetch.

`/plan` numbered steps for `calibration_required` MUST be recognizable as those three
roles (scout / coach / harvest), even if the wording differs.
- Owner: `src/host/pi-plan-mode.ts` (`PLAN_MODE_CONTEXT`)
- Ticket: AGENT-16-T03

**COACH-10.** Job drafts MAY include an optional `coaching` policy. Omitted means no
automatic coach (known_flow). Present and `mode: "calibration"` means the compiler /
materializer SHALL seed scout, coach, and harvest work items with harvest depending on
coach. The planner chooses the mode; the operator approves the spec.
- Owner: `src/durable/domain/spec-types.ts` + spec-compiler + materialize
- Ticket: AGENT-16-T04

```typescript
interface CoachingPolicy {
  mode: "off" | "calibration";
  scout: {
    maxSiteActions: number;
    maxCandidates?: number;
    maxElapsedMs?: number;
  };
  rescue?: {
    actionsWithoutYield: number;
    navigationCycles?: number;
    repeatedObservationHashes?: number;
  };
}
```

**COACH-11.** Rescue triggers, when configured, SHALL enqueue a coach work item and
pause harvest on that stream. They MUST NOT fire on elapsed wall-clock alone. They MUST
NOT rewrite the spec. A second rescue without new yield or a new artifact MUST halt for
the operator (same spirit as AGENT-15 / EXEC-07).
- Owner: scheduler + yield counters (jobs); Magpie Execute analogue in `src/runtime/coach/rescue.ts` + `src/host/pi-coach.ts`
- Ticket: AGENT-16-T04 (jobs), AGENT-16-T06 (Magpie)

### Invocation (COACH-12 … COACH-16)

**COACH-12.** `/coach` SHALL compile a digest, run a review-phase model (no `act`, no
`save`, no side-tab mutations, no `subagent` coder), validate the artifact, persist it
as a checkpoint, and inject only the rendered artifact into the executing session.
Switching model class uses Pi’s session APIs (D12); the host MUST NOT invent a second
router or mid-session `@ultra` prompt prefix (pi-model-auto only honors floors on the
first user turn, and extension `sendUserMessage` skips that hook). Magpie SHALL request
Pi thinking level `high` for the review turn and restore the previous level after accept
or abort. Magpie model pins live in `{coreRoot}/models.json` (`default` / `plan` /
`coach`). Empty / `session` / omitted = this session’s model. `plan` and `coach` may be
`default` or a concrete `provider/id` from the Pi registry; `/models` sets them.
`enter`/`leave` stack so `/plan` → Execute restores the operate model and `/coach`
during plan restores the plan model. If the host cannot switch models (no `setModel` /
registry), Magpie SHALL still run review at thinking `high` and warn. An unknown id,
auth failure, or a floor like `@ultra` SHALL fail closed. Do not use `BSA_COACH_MODEL`.
- Owner: `src/host/pi-models.ts`, `src/host/pi-coach.ts`, Magpie Execute trigger in `src/host/pi-plan-mode.ts`
- Ticket: AGENT-16-T03, AGENT-16-T05, AGENT-16-T06

**COACH-13.** Coach is a compaction boundary (D52). After a successful coach, harvest
context is: spec slice / criteria, facts, strategy artifact, budgets, current page —
not the scout transcript. Dropping snapshots at this boundary is required; dropping the
artifact is forbidden. Magpie reuses `compactFinishedWork`: keepLatest 0 on messages
before the last `[COACH REVIEW]` / STRATEGY user message (AGENT-16-T06).
- Ticket: AGENT-16-T03, AGENT-16-T06, AGENT-16-T04

**COACH-14.** Jobs invoke coach as a work item in phase `review` (OBS-01 / OBS-04).
Capabilities: digest read, strategy write, job_read. Not `act`. ContextCompiler SHALL
put the digest (not transcripts) into the coach CompiledAttempt, and the artifact ref
into later harvest CompiledAttempts (EXEC-04).
- Owner: `src/durable/application/context-compiler.ts`, telemetry phase
- Ticket: AGENT-16-T04

**COACH-15.** The executor MUST NOT call the coach model from inside an execution
attempt. Scout stops, commits digest inputs + yield, then the scheduler (or `/coach`)
leases the review. Mid-turn “maybe I should think harder” is not a coach invocation.
In Magpie chat, `/plan` Execute is the scheduler analogue: the host leases review
when every pre-coach plan todo is complete. Remaining-steps injected for Execute
MUST omit the coach-role todo. While awaiting that review, `subagent` MUST be absent
from the active set (not only `agent=coach` refused). Scout `route_affordance` /
`fact_established` plus `agent_end` MAY start review without `[DONE:n]`.
- Ticket: AGENT-16-T03, AGENT-16-T05, AGENT-16-T06, AGENT-16-T04

**COACH-16.** Manual `/coach` during harvest is allowed. It creates a new checkpoint.
In-flight harvest SHOULD finish the current entity, then reload the artifact — do not
interleave two guidelines on one profile.
- Ticket: AGENT-16-T03

### Safety and cost (COACH-17 … COACH-19)

**COACH-17.** Coach MUST NOT send, follow, like, pay, or otherwise effect. Review phase
tool set enforces this (OBS-04). A coach artifact that tells harvest to skip approval
is invalid (COACH-06).
- Ticket: AGENT-16-T02, AGENT-16-T03

**COACH-18.** Cost of a coach turn SHALL be attributed `phase: "review"` (OBS-01).
Digest size and artifact size SHALL be metered. A coach that exceeds digest max MUST
truncate oldest actions first, never criteria or yield counts.
- Ticket: AGENT-16-T01, AGENT-16-T03

**COACH-19.** Fixture tests MUST NOT call a provider (D37). Interactive `/coach` tests
use FakePi. Jobs tests use mock kernel + fixture digest. Live Instagram is L7 evidence,
not the merge gate.
- Ticket: all AGENT-16

---

## 4. Implementation guideline

Implement tickets in order. T01 and T02 have no host. T03 is the slash command.
T05 is Magpie Execute invoking that command. T04 is the durable-job wiring. Do not
start T04 by rewriting Jobs V2 cutover tickets.

### 4.1 Shared module layout

```text
src/runtime/coach/
  digest.ts       # COACH-01..04 — pure
  strategy.ts     # COACH-05..08 — parse/validate/render
  yield.ts        # yield event helpers used by tools + digest
src/host/pi-coach.ts                  # /coach command, checkpoint, startReview
src/host/pi-models.ts                 # /models pins + enter/leave (not a router)
src/host/pi-plan-mode.ts              # Execute remaining-steps; auto-invoke startReview
src/durable/domain/spec-types.ts      # optional CoachingPolicy
src/durable/domain/spec-compiler.ts   # accept/reject policy
src/durable/application/materialize.ts
src/durable/application/context-compiler.ts
```

Do not put Playwright, Pi, or `node:fs` in `src/runtime/coach/`. File persistence stays
in host/evidence/jobs the same way `summarizeToolResult` stays data and the host draws.

Reuse, do not duplicate:

- `src/runtime/summary.ts` — one-line tool results
- `src/runtime/metrics.ts` — turn/cost/observation hashes
- `src/optimize/rollup.ts` — duplicate-work ideas; digest may share helpers but MUST
  NOT make production code import `src/optimize` (D49: emit stays in runtime)
- `src/runtime/site-skill.ts` — cap/parse/render pattern for the artifact
- `src/host/pi-plan-mode.ts` — command + tool restriction pattern
- `src/durable/application/telemetry.ts` — `review` phase already exists
- QUALITY-04 review template — coach is that operation with a specific schema, not a
  new engine

### 4.2 Ticket order and definition of done

See `work-items/stories/agent-16-strategy-coach.md` and the task files. Summary:

| Ticket | Builds | Merge gate |
| --- | --- | --- |
| AGENT-16-T01 | Digest + yield events | Unit tests: wandering Instagram-like fixture vs guided fixture; digest has no snapshot dump; size cap |
| AGENT-16-T02 | Artifact schema | Accept a venue→tagged→peek guideline; reject criteria rewrite; render ≤ card budget |
| AGENT-16-T03 | `/coach` + plan-mode policy text | FakePi: `/coach` disables act; plan context mentions scout/coach/harvest; checkpoint restores |
| AGENT-16-T05 | Magpie Execute invokes `/coach` | FakePi: Execute omits coach from remaining steps; pre-coach `[DONE:n]` runs T03 handler; harvest sees artifact |
| AGENT-16-T06 | Magpie closed-loop coach | FakePi: one Execute message; no subagent while awaiting coach; stronger class for review; yield-breaker rescue; harvest context has artifact not scout dump. Live R1.E2 |
| AGENT-16-T04 | Job policy + scheduler | Spec with `coaching.mode=calibration` materializes three items; harvest context has artifact not transcript; rescue does not fire on time alone |

### 4.3 Hard rules for the coding agent

1. Cite COACH-* IDs. Do not add features from the idea section that are not in a cited
   ID (no auto-coach every N minutes, no coach-authored Playwright, no site-specific
   Instagram skill shipped as product code).
2. Do not reopen Jobs V2 cutover (`CAMPAIGN-04-T04`) or weaken EXEC-04.
3. Do not teach the planner Instagram tactics. Teach it to schedule calibration.
4. Do not send transcripts to the coach. If a test does, it fails COACH-01.
5. Do not let the executor `subagent` a “coach” coder. Coach is review-phase Magpie,
   not a coding child. Magpie Execute MUST NOT inject the coach-role todo as remaining
   work (AGENT-16-T05). While awaiting the first artifact, `subagent` MUST be absent
   (AGENT-16-T06).
6. Do not store DOM refs in the artifact or digest (EXEC checkpoint rule).
7. Prefer extending `PLAN_MODE_CONTEXT` over adding a second plan-mode.
8. If plan-mode and jobs disagree, the spec/job policy is authority for jobs; plan-mode
   is the one-shot analogue. Same three roles.

### 4.4 Suggested tests (names)

- `tests/unit/coach-digest.test.ts`
- `tests/unit/coach-strategy.test.ts`
- `tests/unit/pi-coach.test.ts` (follow `tests/unit/pi-subagent.test.ts` plan-mode cases;
  T05: Execute omits coach todo, pre-coach `[DONE:n]` starts review; T06: one Execute
  message, Magpie rescue, stronger class restore)
- `tests/unit/durable-coaching.test.ts` (compiler + materialize + context compiler)

Fixture sketch for T01: a synthetic ledger of list → profile navigate → back → lost
place, zero yield, rising cost; digest must flag the cycle and recommend (in later T02
fixture) peek/side-tab. Second fixture: venue → tagged → peek → accept; digest shows
yield per action.

### 4.5 Out of scope

- Caching the guideline across goals / accounts (D28 memory still gated)
- Teaching cost models (D44 still stands: make peek the cheap route; coach *names* it)
- QUAL/PERF behavioral package from `docs/live-run-investigation-plan.md`
- CAPTCHA, stealth, Instagram-specific product code
- Coach that mutates the page to “try the better route itself”
- Replacing AGENT-15 breakers

---

## 5. Example

Planner output (roles, not tactics):

```text
Plan:
1. Scout: find a small sample of likely party-goers (budget: 2 venues or 8 profiles).
   Record how you found them and who you rejected.
2. Coach: pause and synthesize the acquisition loop from the scout. Do not continue
   the harvest until the strategy artifact exists.
3. Harvest: repeat the coached loop until N qualified candidates. Peek profiles; do
   not abandon the list. Same qualification criteria as the goal.
```

Coach artifact (after a scout that stumbled into tagged posts):

```text
loop:
  - Search local venues / events, not generic "party goers"
  - Open the venue's tagged posts
  - Deduplicate handles before opening anyone
  - Peek each profile in a side tab; keep the tagged list
qualify:
  - Apply the goal's popularity and nightlife criteria; do not loosen them
stop:
  - After N accepts, or after 3 venues with fewer than X new handles
doNot:
  - Navigate to a profile and Back; you lose the tagged list
  - Generic Instagram people-search as the primary seed
exceptions:
  - If a peek is an empty JS shell or a required field stays unknown, observe the live page
falsify:
  - Tagged posts are empty or private on the next two venues
```

Harvest then loops that guideline on GLM. Criteria never moved.
