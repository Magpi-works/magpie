# Live-run evidence log

Append only. Corrections get a new dated note; do not rewrite an earlier observation.
Use `docs/live-run-review-template.md` for the full review.

## 2026-09-08 — Minsk candidate collection and invitation site

Identity:

- Goal: `goal_mtrvevpq001`
- Task: collect 200 Minsk partygoer Instagram accounts with at least 200 followers,
  prepare personalized invitation drafts, and do not send.
- Host: local Pi browser chat.
- Duration: approximately 74 minutes.
- Models: 6 GPT-5.6 Sol planning turns, followed by 411 GLM-5.3 Flash execution
  turns. Session model switches are authoritative; aggregate metrics incorrectly label
  the entire run GPT.

Performance:

- 417 turns.
- 234 `act`, 150 `probe`, 4 `observe`, 0 `peek`.
- 221 successful and 12 failed recorded browser actions.
- 833,521 fresh input tokens.
- 102,681 output tokens.
- 24,724,686 cache-read tokens.
- 15,156 cache-write tokens.
- $0.534847 total recorded cost.
- 96.7% cache-read share of prompt tokens.
- Mean context 849,186.6 bytes.
- Peak/final context 1,606,784 bytes.
- Final context included approximately 905KB live content and 702KB placeholders.
- Fixed-byte attribution: tool schemas 55.7%, agent card 31.0%, `act` results 7.1%,
  `probe` results 5.6%.
- 62 of 236 measured observations had key collisions; maximum 20.
- Rollup reported 133 repeated probes, but this is not an exact-duplicate count because
  the current metric omits page URL from the key.

Outcome and quality:

- The agent reported blocked/partial after collecting 25 candidates, then later reported
  success for the website subtask.
- After operator review, one kid-focused candidate was removed.
- Canonical JSON and website ended with 24 candidates, versus the requested 200.
- The agent's own decision log estimated only 12–15 of the remaining 24 would pass a
  strict nightlife/partygoer filter.
- Candidate fit drifted toward Minsk connection plus weak lifestyle/music signals.
- Candidate JSON lacked per-claim evidence URLs, confidence, recency, and typed fit
  dimensions.
- `verified` was overloaded between platform badge status and research validation.
- The tracker and DM artifact remained at 25 while canonical JSON/site moved to 24.
- Date, venue, host account, and public domain remained placeholders.
- The local RSVP button changed its own label but persisted no response.

Positive evidence:

- Browser execution was active rather than mostly narrative: 388 direct browser calls
  over 417 turns.
- Recorded browser action failure rate was approximately 5.2%.
- No messages, follows, likes, payments, or destructive actions occurred.
- No CAPTCHA or platform block was reported.
- A coding child successfully built and regenerated the local static site.
- The agent accepted an operator correction and removed the challenged candidate.

Evidence added to tickets:

- QUAL-01: supports the need for an explicit target-population rubric.
- QUAL-02: supports typed records and per-claim provenance.
- QUAL-03: confirms top-level and subtask completion can diverge.
- QUAL-04: confirms mixed-version projections after correction.
- QUAL-05: supports calibrating personalization before bulk generation.
- QUAL-06: supports review independent of the generation context.
- PERF-01: confirms aggregate model attribution is wrong after model switches.
- PERF-02: confirms interactive chat is unbounded in production.
- PERF-03: shows repeated navigate/probe classification recipes.
- PERF-04: 150 probes make navigation/extraction fusion worth measuring.
- PERF-05: includes no-progress follower-dialog scroll failures.
- PERF-06: confirms placeholder structure grows materially in a long session.
- PERF-07: confirms fixed card/schema bytes dominate attributed bytes.
- PERF-08: cannot be decided until model-specific usage is measurable.
- PERF-09: confirms observation collisions are frequent enough to correlate with errors.
- PERF-10: confirms the current repeated-probe count conflates reuse with duplication.

Decision:

- No behavioral solution accepted.
- Preserve all proposed fixes as hypotheses.
- Collect two more live runs before the decision review.
- Instrumentation that does not alter behavior may proceed separately.

## 2026-09-08 — Berlin Raspberry Pi checkout verification

Identity:

- Goal: `goal_mtt17kx6001`
- Task: find five Raspberry Pi 5 8GB units from European sellers, verify quantity,
  Friday delivery, VAT, shipping, and a delivered total below €600 through checkout.
- Host: local Pi browser chat.
- Duration: approximately 108 minutes from the first request to the last browser result.
- Models: 4 Kimi K3 planning/transition turns, followed by 263 GLM-5.3 Flash turns.
  The aggregate metric incorrectly labels all 267 turns Kimi K3.
- This run is not behaviorally comparable with the Minsk collection run, but it is
  cross-task evidence about approvals, challenge handling, failures, and context growth.

Performance:

- 267 turns; 159 `act`, 66 `probe`, 16 `observe`, and 1 `peek` result.
- Of 159 `act` calls, 97 returned `ok:true`, 35 returned `ok:false`, 10 were refused
  before execution, and 17 returned tool errors. Only 61% returned success.
- 1,355,679 fresh input tokens, 78,987 output tokens, 10,080,000 cache-read tokens,
  and $0.314675 recorded cost.
- Mean context 636,178 bytes; peak/final context 1,342,035 bytes. The final context was
  757,700 live bytes and 580,764 placeholder bytes.
- Tool schemas and the agent card were 52.9% and 29.4% of attributed bytes.
- 79 of 153 observations had key collisions; maximum 38.
- The five actual approval prompts held their tool calls open for approximately 45m22s,
  about 42% of total wall time.

Approval evidence:

- All five prompts were unnecessary for the operator's stated boundary: submit a product
  search, decline cookies, apply a search filter, add to cart, and continue as guest.
  The request explicitly authorized cart and checkout verification and forbade placing
  the order.
- Generic `submits-form` classification caused four of the five asks. `outbound-name`
  misclassified “Apply the filter” as an outbound effect.
- The ledger contains 26 `approval` rows, but only five rows have `asked:true`; approval
  event count is not user-interruption count.
- After the operator said only payment was irreversible, no new prompt was shown.
  Existing sticky approval identity also silently covered later controls named
  `form Options[_nextpage]`; that identity is too broad because the same generic name is
  reused across checkout stages.

Challenge evidence:

- At least nine seller domains were blocked by Cloudflare, 403, or access-denied pages.
  The ledger contains 17 observations titled `Just a moment...` alone.
- A challenge navigation commonly returned `ok:true` because its URL postcondition passed.
  There was no typed challenge outcome, host breaker, session challenge budget, takeover,
  or parked continuation.
- Digi-Key was retried three times after its first challenge, including a final retry more
  than 80 minutes after the first blocked seller. The report correctly disclosed the
  blocked route, but the runtime did not stop the repeated work.

Outcome and quality:

- The final `report` status was `failed`, correctly reflecting that no option met the
  €600 hard constraint and no order was placed.
- Reichelt quantity, shipping, VAT, and total were verified to the payment/delivery step:
  five units, €1,056.45 delivered, and stated 1–2 day transit.
- The report is useful but overstates some evidence. Only Reichelt reached a live cart;
  BerryBase's “100+ Stück” remained listing evidence, and blocked distributors' supposed
  list-price range was not verified in this session.
- The final review page was not reached. The artifact clearly states that limitation but
  still describes the surveyed sources too broadly as verified.

Evidence added to tickets:

- QUAL-02: supports evidence-level and source-URL fields so listing, cart, and checkout
  claims cannot be conflated.
- QUAL-03: supports the `failed`/partial top-level oracle and explicit unmet criteria.
- PERF-01: independently confirms incorrect aggregate model attribution.
- PERF-02 and PERF-06: context reached 1.34MB in 267 turns and remained unbounded.
- PERF-07: fixed card/schema text was 82.3% of attributed bytes.
- PERF-09: 51.6% of observations had collisions, while 39% of `act` calls did not return
  success.
- PERF-11: establishes a baseline for approval precision and prompt wait.
- PERF-12: establishes a baseline for typed challenges and circuit breaking.
- PERF-13: establishes a baseline for failed-action and no-progress budgeting.

Decision:

- Treat effect-aware approval and typed challenge termination as priority experiments;
  they have direct wall-time and safety evidence.
- Do not count this as one of the two comparable result-quality baselines.
- Do not implement CAPTCHA solving or anti-bot evasion. Test detection, bounded retries,
  takeover/parking, persistent-profile continuity, and pacing instead.

## 2026-09-09 — Magpie launch research stuck in the coder loop

Identity:

- Goal: `goal_mttviohj001`
- Task: Magpi launch research (directories, newsletters, communities, pitches).
- Host: local Pi browser chat.
- Duration: approximately 60 minutes.
- Session: `2026-09-09T09-05-56-079Z_01a0856a-ad6f-7215-90e8-37b84ed7401b`

What ran:

- 13 sequential `subagent` coder calls; 7 aborted with exit 143 (~3 min wall).
- Browser peek failed early (persistent profile `SingletonLock`).
- Almost all remaining work was public-curl harvest. Pitches/submissions were never
  produced. `goal.json` froze around 09:33 while work continued to ~10:10.
- `events.jsonl` had 5 note/ask events. The plan widget collapsed distinct phases to
  "Research".

Root cause (not slow work):

- Returned `isError` is ignored by Pi 0.85.1; aborted children looked successful to the
  parent, which immediately redispatched.
- No consecutive-failure or work-stream breaker on interactive `subagent`.
- Live UI was `(running…)` plus tool names. No task, elapsed time, or timeout in the
  working line.
- Prompt rewording (`more newsletters` vs `more communities`) was treated as new work.

Fix (this change): throw on child failure; persist a semantic fingerprint; stop after two
failed slices or three stagnant harvest attempts; dedicated Pi-style renderers and
working/status/widget updates. Evaluation:
`work-items/evaluations/agent-15-operator-observability.md`.

Ticket implications:

- AGENT-15: interactive no-progress breaker, not only durable browser actions.
- Operator observability: plan-step labels and live child progress.

Decision:

- Do not treat this goal as a result-quality baseline.
- Ship the host stop before another fruitless harvest dispatch.

## 2026-09-09 — Minsk tagged-feed collection with explicit recipe

Identity:

- Goal: `goal_mtu4ujai001`
- Session: `2026-09-09T13-27-05-501Z_01a08659-c61b-75d6-925f-6bf61e8b7ccf`
- Host: local Pi browser chat.
- Duration: approximately 73 minutes wall (13:27–14:40 UTC). Collection itself was
  about 44 minutes (13:32–14:16); website build 14:22–14:25; later “give me the link”
  at 14:40.
- Models: GLM-5.3 Flash for all 259 turns. No model switch. Aggregate `run.model` is
  correct for this session (unlike the first two live runs).
- Commit: workspace was `main` with uncommitted AGENT-15 host work; session started
  before merge `8494b7f`. Do not treat this as an A/B of that merge.

Task (operator, after abandoning a Google sign-in ask):

- Find popular Minsk party-goers to invite to post in exchange for free passes.
- Exact loop: open Instagram, search for Minsk clubs in Russian, pick 5 clubs, for
  each club open Tagged, list 20 users who tagged there, check 100+ followers, keep
  a record, next venue. Do not roam. Keep the club page open; open people in a
  side tab.

This is the first additional *result-quality* collection run after
`goal_mtrvevpq001`. Berlin and Magpie still do not count. It is only partly
comparable with the Minsk baseline: same domain and host, but the operator supplied
a mechanical rubric, dropped the target from 200/200-followers to 20×5/100-followers,
and this session actually used `peek` / side tabs (the baseline used 0 `peek`).

Performance:

- 259 turns; `maxTurns: 0`.
- Tool results: 39 `act`, 62 `peek`, 56 `probe`, 46 `side_tab_open`, 45
  `side_tab_close`, 4 `observe`, 2 `report`, 1 `subagent`, 1 `ask_user`.
- Ledger: 30 successful actions, 8 failures (all in the first ~11 minutes, Instagram
  search open / no-progress search scroll). Collection after club selection was
  mechanically clean.
- 1,176,315 fresh input tokens, 55,784 output, 6,702,656 cache-read, $0.202709.
- Cache-read share 85.1%.
- Mean context 470,589 bytes; peak/final 919,400 bytes (472,603 live, 446,797
  placeholder, 48.6% placeholder).
- 248 of 259 turns rewrote history; all 248 measured rewrites were near the tail
  (compaction), not mid-prefix.
- Fixed attribution still ~55.6% tool schemas and 30.9% agent card.
- 125 of 194 observations had key collisions; maximum 40 (at the control cap).
- Rollup `repeatProbes: 45` is again mostly the same `header` text probe on different
  profile URLs, not exact duplicate work (PERF-10).
- 37 of 56 probes were `header` text; 13 were link harvests; 62 peeks sat beside them
  in the ledger as probe-shaped rows.

Outcome and quality:

- First `report` status `success` at 14:16 with 60 tagged posts → 46 tracker rows →
  44 with 100+ followers. Caveat disclosed: each Tagged grid showed 12 posts, so
  20 users per club was not met (11 / 8 / 11 / 6 / 10 rows).
- Second `report` status `success` for the invite-manager HTML: 45 unique handles,
  43 qualified (`stars.school.by` deduped). Tracker still says 46 distinct / 44
  qualified.
- Oracle: top-level cardinality failed (100 requested if 20×5 is read strictly;
  45 delivered). A useful partial artifact exists. `success` is still the wrong
  top-level status.
- Club set is karaoke-heavy (4 of 5). Search for `"ночной клуб минск"` mixed other
  cities; no-progress scrolls did not load more Minsk clubs; the agent picked what
  the search panel showed rather than confirming a nightlife population.
- Interpretation used: post *authors* on the venue Tagged grid, not people tagged
  *in* those posts. The agent disclosed this. Tagged-at-venue remains a weak proxy
  for “popular party-goer who would post for a free pass.”
- Reviewer scoring from the agent’s own notes (not a live Instagram re-check), 43
  qualified website rows: about 13 strong nightlife/performer fits, 17 weak
  lifestyle/private/musician, 13 wrong audience (businesses, media, kids animators,
  cake/seamstress, venue owner/staff/sister company). Strong-only precision ~30%;
  strong+weak ~70%. Below the 80% QUAL-01 “qualified” threshold.
- `babyshow_jokers` (kids-party animators) reappears as a high-follower “hit.”
- One generic invite template with `{name}/{handle}/{followers}/{club}`. Not
  calibrated, not evidence-grounded per person.
- No DMs, follows, likes, or payments. One coder subagent verified HTML counts and
  returned; the Magpie harvest loop did not recur.

Positive evidence:

- D44’s cheap-read bet is no longer falsified by this task class: 0 peek in the
  baseline versus 62 peek + 46 side-tab opens here, while keeping the club Tagged
  page in the main tab.
- Cost per delivered unique handle ≈ $0.0045 versus ≈ $0.022 in the baseline;
  turns per handle ≈ 5.8 versus ≈ 17.4. Most of that is the operator recipe plus
  peek/side-tab, not a product change.
- Follower counts were read from live profiles, not guessed.
- The agent flagged owner/staff/sister-company rows instead of silently mixing them.
- Failures clustered in search UX, not in the per-profile loop.

Evidence added to tickets:

- QUAL-01: supports that an explicit loop still admits wrong audience; tagged-at-
  venue + 100 followers is not a party-goer rubric. Kids-animator false positive
  replicates.
- QUAL-02: tracker/HTML have handle, followers, club, free-text notes; no source
  post URL, observed-at, confidence, or typed fit dimensions.
- QUAL-03: two `success` reports despite 20-per-club miss and mixed audience. Honest
  caveats in prose do not change the status.
- QUAL-04: 46 vs 45 distinct, 44 vs 43 qualified, hand-maintained markdown vs HTML
  copy of the same list.
- QUAL-05: customized-invite request produced one template, not grounded drafts.
- QUAL-06: same model collected, classified, drafted, and declared success.
- PERF-01: neutral / cannot help; single-model session. Metrics matched the
  transcript this time.
- PERF-02: 259 unbounded interactive turns; `maxTurns: 0`.
- PERF-03: after clubs were chosen, the loop was almost a closed recipe (open side
  tab → peek post → peek/probe profile header → close). Model still spent one turn
  per item. Strongest homogeneous-batch evidence yet.
- PERF-04: 37 header probes after peeks that already had the profile page.
- PERF-05: three no-progress search scrolls; Tagged grids accepted at 12 tiles
  without a “scroll until new posts or limit” stop. Directly limited yield.
- PERF-06: placeholders still ~447KB at the end; growth is slower than the 1.61MB
  baseline but not rolled over.
- PERF-07: 16 schemas resent for 259 turns; schemas+card still ~86.5% of attributed
  bytes.
- PERF-08: still blocked on PERF-01; this run cannot separate model from rubric.
- PERF-09: collision rate 64.4% (125/194), max 40, worse than the baseline 26.3%.
- PERF-10: 45 “repeated probes” are the header recipe on different URLs.
- PERF-11: no approval prompts (read-only collection). Neutral.
- PERF-12: no challenge pages. Neutral.
- PERF-13: 8 failed acts, all search-phase, then stop-and-switch-query rather than
  a long no-progress budget burn. Weak support compared with Berlin.
- COST-01: 45 authenticated Instagram profile visits as `naiem6632`. Cheap-read
  footprint is now a live number, not hypothetical.
- AGENT-15: one successful coder slice; does not confirm the consecutive-failure
  breaker or live TUI working line.

Decision:

- Count this as additional comparable collection run 1 of 2 required before the
  QUAL/PERF decision review.
- Do not accept the behavioral optimization package. Do not close QUAL-01..06 or
  PERF-02..10.
- Instrumentation-only work (PERF-01, PERF-10) may still proceed.
- Next run should be another scoreable collection task, preferably a different
  domain (SaaS table, conference CFPs, or apartments) *without* shipping those
  fixes, so quality tickets can be checked off-Instagram. Do not reuse this exact
  tagged-feed recipe if the goal is to retest the original loose “find 200
  party-goers” prompt.

## 2026-09-09 — Strategy coach recorded from party-goer comparison

Identity:

- Prompt: `docs/example-prompts/party.txt` (Minsk party, invite popular party-goers
  for posts in exchange for free passes).
- Comparison (operator-reported, not a third scored `goal_*` in this log): (1) expensive
  planner then GLM, (2) all GLM, (3) all GLM with an operator-written route (venues →
  tagged page → peek/qualify profiles).

Observation:

- (1) and (2) wandered. The planner did not know Instagram affordances.
- (3) wandered much less. The missing artifact was a task-specific acquisition loop,
  not a better up-front plan.

Decision:

- Recorded as D58 / `docs/coach.md` / AGENT-16.
- Auto-coach is planner-owned policy (scout → coach → harvest), job-invoked, plus
  manual `/coach`. Not a wall-clock heuristic. Not a QUAL/PERF package accept.

## Following live run — pending

- Goal id:
- Date:
- Task class:
- Commit:
- Models:
- Comparable with baseline: yes / no
- Review location:
- Main evidence:
- Ticket implications:
- Decision:

## 2026-09-10 — Magpie Execute did not run `/coach` (`goal_mtumeewm001`)

Identity:

- Goal: `goal_mtumeewm001`
- Session: `2026-09-09T21-38-26-450Z_01a0881b-9e12-747d-8bca-c7405f68cfd1`
- Task: `docs/example-prompts/party.txt` (Minsk party-goers, list only, “Use insta”)
- Host: local Magpie / Pi browser chat

Observation:

- `/plan` classified `calibration_required`. Todos included step 4
  `Coach: Submit the scout artifact for coaching…` and step 5
  `Harvest (blocked on coach artifact)`.
- Execute at 21:41:02Z injected all seven steps, including the coach todo, as
  remaining executor work. Plan `turn_end` only tracks `[DONE:n]`.
- GLM did not emit `[DONE:n]` during scout. First `[DONE:]` tags are 22:13–22:14Z
  on a second Execute after harvest.
- At 21:46:38Z GLM reasoned there is no coach tool and called
  `subagent({ agent: "planner" })` (“Your job as coach”). Child: DeepSeek Flash,
  3 turns, $0.0016. Output saved as `artifacts/harvest-criteria.md`
  (`ev_mtumq8vy05m`). No `coach-checkpoint`, no `[COACH REVIEW]`.
- T03 `agent=coach` refuse did not apply. This is not R1.E2.

Decision:

- Open **AGENT-16-T05**: Magpie Execute invokes the existing `/coach` handler after
  pre-coach todos complete; remaining-steps MUST omit the coach-role todo.
- Do not treat this as QUAL/PERF accept. Do not start AGENT-16-T04 for this gap.

## 2026-09-14 — Cheap-fetch harvest on JS trust portals (`goal_mtz1c1ar001`)

Identity:

- Goal: `goal_mtz1c1ar001`
- Task: ~100 developer SaaS API matrix (trial, CC, API key, SSO, SOC2, pricing,
  usage-based). Parent/Grok Bot Magpie session. Local copy:
  `/Users/ith/Downloads/goal_mtz1c1ar001`
- Models: operate ~GLM flash (~$0.03–0.05); reviewer/coder children DeepSeek flash.

Observation:

- Scout verified dense `/pricing` pages (Resend). Strategy (markdown
  `strategy-saas-api-survey.md`, then v2) scaled **fetch/peek HTML** (~2 fetches
  beyond pricing, unknown-and-move-on). Harvest used **coder curl scripts**, not
  Magpie `observe` on painted pages.
- Coach path was a **reviewer subagent** over that markdown, not host `/coach`
  JSON (`coach-checkpoint`). Same bypass class as `goal_mtumeewm001`.
- Matrix of 30 rows delivered. SPA/JS trust portals (Algolia, Anthropic, Datadog,
  …) stayed unknown/thin. “Verify on the product” was often page text, not signup.
- Operator review: flash was right for breadth; quality gap is coach optimizing
  cost/throughput instead of escalate-to-browser on shells/unknown required fields.
  Grok 4.6 would not fix fetch-blind SPAs.

Decision:

- **COACH-20**: strategy must preserve qualification quality; cheapest route is
  D44 peek (not curl). Empty JS shell / unknown required field → `observe`.
  Harvest Execute hint forbids coder-fetch as the loop.
- Do not treat this as R1.E2 or E-QUAL. Host `/coach` bypass remains T05/T06 live
  debt on parent sessions.
