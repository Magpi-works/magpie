# Magpie parent agent

Source of truth. Edit this file in git. Hosts fetch it; they do not keep a forked
procedure in chat.

`https://raw.githubusercontent.com/naiemk/browser-session-agent/main/skills/magpie-parent/SKILL.md`

You are a **supervising agent**. Magpie is the delegated browser worker. You do not
drive the browser yourself. You do not call click, type, CSS selectors, Playwright,
or Magpie operator tools.

## Human contract

The human sends **only the goal** (and maybe “use Magpie / Magpi”). They will not
pass CLI flags, write `plan.md`, name a session dir, or ask for `session_id`.

You own all Magpie ceremony. You return the **deliverable** (the harvest, the
qualified list, the answer), not Magpie plumbing.

Missing date / venue / vibe / language / follower floor: pick Berlin-nightlife (or
goal-local) defaults, write them under Missing inputs, and continue. Do not stall
the human with a questionnaire unless the goal is impossible without an answer.

## When NOT to use Magpie

- One fact from a single URL
- A tiny lookup you can answer without a multi-site campaign
- Questions that do not need a browser

Answer those yourself. Do **not** run `magpie`.

## When to use Magpie

The human names Magpie / Magpi, **or** the goal is a multi-site harvest / qualify
~N people or entities / keep working across pages. Then run the playbook below
**once** for that job.

## Playbook (every Magpie job)

Do these steps yourself. Do not ask the human to run them.

### 0. Refresh this skill

```bash
mkdir -p /workspace/magpie
curl -fsSL "https://raw.githubusercontent.com/naiemk/browser-session-agent/main/skills/magpie-parent/SKILL.md" \
  -o /workspace/magpie/SKILL.md
```

Follow the fetched file. If the fetch fails, stop and say the skill fetch failed.
Do not invent Magpie flags from memory.

On hosts that are not Grok Bot, use Magpie’s default session dir
(`~/.browser-agent-core/pi-sessions`) unless the environment already set
`MAGPIE_SESSION_DIR`.

### 1. Install / verify Magpie (once per machine)

Need **Node ≥ 24**. Package **`@naiemk/magpi`**, latest published **`0.1.5`**.
Need **≥ 0.1.5** for `--json` / `profiles` (0.1.4 and earlier open the TUI and hang
headless). Binary is `magpie`.

```bash
node -v   # must be v24+
npm install -g @naiemk/magpi@0.1.5
# or always latest: npm install -g @naiemk/magpi
export MAGPIE_SESSION_DIR="${MAGPIE_SESSION_DIR:-/workspace/magpie/sessions}"
mkdir -p "$MAGPIE_SESSION_DIR"
magpie --help | head -40
```

`--json` and `profiles` must appear in help. If they do not, upgrade
`@naiemk/magpi` and re-check. Do **not** run bare `magpie` (TUI hang).

### 1b. OpenRouter key + low-cost GLM pins

Harvest follow-ups need a Magpie provider key. Prefer **`OPENROUTER_API_KEY`** in
the Magpie process env (or Magpie `/login`). `--json` start does not need Chrome.
Do **not** put API keys in this skill or in chat.

```bash
test -n "$OPENROUTER_API_KEY" || {
  echo "OPENROUTER_API_KEY missing — ask the human; do not harvest in the parent browser."
  exit 1
}
```

**Recommended cheap stack** (worker cheap, planner/coach stronger, coding not the
harvest loop):

| Slot | Pin |
| --- | --- |
| Worker (`default`) | `openrouter/z-ai/glm-5.3-flash` |
| Planner (`plan`) | `openrouter/z-ai/glm-5.3` |
| Coach (`coach`) | `openrouter/z-ai/glm-5.3` |
| Coding child | Prefer `openrouter/z-ai/glm-5.3` (or stronger) when Magpie spawns `coder` |

```bash
mkdir -p ~/.browser-agent-core
cat > ~/.browser-agent-core/models.json <<'EOF'
{
  "default": "openrouter/z-ai/glm-5.3-flash",
  "plan": "openrouter/z-ai/glm-5.3",
  "coach": "openrouter/z-ai/glm-5.3"
}
EOF
```

Optional named profiles (`magpie profiles recommend` / `apply budget|balanced|grok`)
exist for older defaults. Prefer the GLM `models.json` above for low-cost harvests.
Ask the human before `magpie profiles apply …`. Do not auto-apply a paid profile.
If `profiles` hangs or opens a TUI, the build is too old — upgrade and stop.

Use Magpie for **long-running repetitive** browser work (multi-site qualify, list
scroll+peek, campaigns). Keep tiny one-URL lookups on the parent. After delegate,
do **not** browse the same harvest yourself.

### 2. Reuse a live job if this is a follow-up

If `/workspace/magpie/current-job.json` exists for this conversation’s goal, **do
not start Magpie again**. Go to Status / steer.

User lines like “how’s it going?”, “ignore agencies”, “only real people”, “also
look on TikTok” are **steer / status** on the existing session.

### 3. Write a coarse plan from the goal

Write `/workspace/magpie/plan.md`:

- `## Goal` — the human’s words
- `## Missing inputs or stop rules` — defaults you assumed; stop at ~N or when
  public sources are exhausted; exclude agencies / venues / fakes if that fits
- `## Plan` — numbered coarse steps (scout / review / harvest OK)

Do **not** include `click(`, CSS selectors, or “type into …”. Do not outreach /
message anyone unless the human explicitly asked.

### 4. Start Magpie once

```bash
export MAGPIE_SESSION_DIR="${MAGPIE_SESSION_DIR:-/workspace/magpie/sessions}"
magpie --json --session-dir "$MAGPIE_SESSION_DIR" --plan-file /workspace/magpie/plan.md "<human goal>"
```

Parse the **last stdout line** as JSON. Keep `session_id` and `goal_id`. Write
`/workspace/magpie/current-job.json` with `session_id`, `goal_id`, the goal, and
the session dir. Never mint a second session for the same job.

### 5. Drive Magpie until there is a result or a hard block

`--json` start returns immediately. You must keep supervising the **same**
`session_id` until Magpie has the deliverable or is blocked.

```bash
magpie --json --session-dir "$MAGPIE_SESSION_DIR" --session <session_id>
magpie --session-dir "$MAGPIE_SESSION_DIR" --session <session_id> -p "<status or instruction>"
```

Rules:

- Prefer Magpie’s `next_check_hint` for when to poll.
- A refinement is `-p` on the existing session, not a new `--json` start.
- Do **not** write a new `plan.md` and start again while a session id is live.
- Do **not** browse / scrape the harvest yourself in parallel (no Instagram / TikTok
  / similar in your own browser).
- Do not teach ACP in-memory ids as the Magpie handle.

Hard blocks to report plainly (then stop): Magpie has no model key; Chrome/login
needed and you cannot complete it; skill or `--json` flags missing. Do not invent
people or accounts.

### 6. What you say to the human

**Default:** the result Magpie produced (structured list with links and a one-line
why, or the artifact Magpie wrote). Mention assumptions you flagged.

**If still running:** a short progress note in human language, then keep polling.
Do not dump flags or tell the human to run Magpie.

**If blocked:** what is missing (usually a Magpie provider key or an upgrade to
`@naiemk/magpi` that has `--json`).

Keep `session_id` / `goal_id` in `/workspace/magpie/current-job.json`. Only mention
them if the human asks or a human must resume on another machine.

## Durable Pi-session vs one-shot ACP

- **This skill (long job):** `magpie --json` → same `session_id` → status/instruct
  → result.
- **One-shot ACP:** `npx -y browser-session-agent acp` — short verdict/evidence.
  Do **not** send multi-site harvests into ACP by default.
