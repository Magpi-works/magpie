# Magpie parent — Grok Bot bootstrap (paste once)

Paste this **once** into Grok Bot (save-from-chat / Teach a task / enable under
Plugins → Yours). After that, humans only send a **goal** (and maybe “use
Magpie”). They do not paste Magpie flags, plan steps, or session ids.

Canonical playbook (git; refresh every job):

`https://raw.githubusercontent.com/naiemk/browser-session-agent/main/skills/magpie-parent/SKILL.md`

Grok Bot has no Plugins “install skill from GitHub URL” path. This bootstrap plus
Agent Computer `curl` is the reproducible install. See
`docs/grok-bot-feasibility.md` RESEARCH-02 / RESEARCH-10.

---

## Skill body (what to save in Grok Bot)

When the human names Magpie / Magpi **or** asks for a multi-site harvest / find
~N people with public socials / any **long-running repetitive browser** job
(qualify many entities, scroll+peek lists, multi-site research, keep working),
you are the Magpie parent.

You install Magpie, set its cheap models, write a coarse plan, start **one**
session, poll the same `session_id`, and return the **result**. You do **not**
browse/harvest in your own browser (that burns Grok Bot credits). You do not ask
the human to write `plan.md` or run CLI flags.

### 0. Refresh the canonical skill

```bash
mkdir -p /workspace/magpie
curl -fsSL "https://raw.githubusercontent.com/naiemk/browser-session-agent/main/skills/magpie-parent/SKILL.md" \
  -o /workspace/magpie/SKILL.md
```

Follow `/workspace/magpie/SKILL.md` for the full playbook. If the fetch fails,
stop — do not invent Magpie procedure from memory. The steps below are the
Grok Bot install / cost bootstrap that must stay in this saved skill.

### 1. Install Magpie (once per Agent Computer)

**Package:** `@naiemk/magpi` on npm. **Latest published:** `0.1.5` (need **≥ 0.1.5**
so `magpie --help` shows `--json` and `profiles`). Binary name is `magpie`.
Need **Node ≥ 24**.

```bash
node -v   # must be v24+
npm install -g @naiemk/magpi@0.1.5
# or always latest: npm install -g @naiemk/magpi
export MAGPIE_SESSION_DIR="${MAGPIE_SESSION_DIR:-/workspace/magpie/sessions}"
mkdir -p "$MAGPIE_SESSION_DIR"
magpie --help | head -40
```

Confirm `--json` and `profiles` appear. If they do not, upgrade and stop.
Do **not** run bare `magpie` (interactive TUI — hangs headless).

### 2. OpenRouter API key (Magpie’s LLM, not Grok Bot chat)

Magpie pays for harvest turns with **its own** provider. Set OpenRouter on the
Agent Computer (do not paste the key into chat or into this skill text):

```bash
# Prefer a secret the human already put on the machine, or ask them once for a
# masked secret / env file — never echo the key back in the conversation.
test -n "$OPENROUTER_API_KEY" || {
  echo "OPENROUTER_API_KEY is missing. Ask the human to set it on the Agent Computer"
  echo "(Settings / env / secure secret). Magpie cannot harvest without it."
  exit 1
}
export OPENROUTER_API_KEY
# Persist for later Magpie processes on this machine if the shell is ephemeral:
mkdir -p /workspace/magpie
grep -q OPENROUTER_API_KEY /workspace/magpie/env.sh 2>/dev/null || \
  echo 'export OPENROUTER_API_KEY="'"$OPENROUTER_API_KEY"'"' >> /workspace/magpie/env.sh
# shellcheck: source when starting Magpie
#   source /workspace/magpie/env.sh
```

If the key is missing, **stop and tell the human** Magpie needs an OpenRouter key.
Do not burn Grok Bot credits doing the harvest yourself.

### 3. Low-cost model pins (recommended default)

Magpie slots: **default** = browser worker (harvest/operate), **plan** = admit /
coarse plan, **coach** = strategy critic after scout. Coding children are separate.

**Recommended cheap harvest stack (OpenRouter):**

| Slot | Model | Why |
| --- | --- | --- |
| Worker (`default`) | `openrouter/z-ai/glm-5.3-flash` | Cheap loop for peek / qualify / navigate |
| Planner (`plan`) | `openrouter/z-ai/glm-5.3` | Stronger admit / coarse plan |
| Coach (`coach`) | `openrouter/z-ai/glm-5.3` | Strategy after scout (same class as plan) |
| Coding child | `openrouter/z-ai/glm-5.3` or a stronger coder if Magpie spawns `coder` | File extract / unzip / scratch code — not the harvest loop |

Write Magpie’s pin file (paths under Magpie home; do not invent a second home):

```bash
mkdir -p ~/.browser-agent-core
cat > ~/.browser-agent-core/models.json <<'EOF'
{
  "default": "openrouter/z-ai/glm-5.3-flash",
  "plan": "openrouter/z-ai/glm-5.3",
  "coach": "openrouter/z-ai/glm-5.3"
}
EOF
# Optional named profile (older defaults); prefer the models.json above for GLM:
#   magpie profiles recommend
#   magpie profiles apply budget   # only if human confirms; GLM pins above win if written after
```

Do **not** auto-switch to a paid API-key backend the human did not approve.
Do **not** print API keys.

### 4. When to use Magpie vs stay local

**Use Magpie** for long / repetitive browser work: multi-site research, lead/qualify
~N people, scroll+peek lists, campaigns that run minutes+, anything where Magpie’s
scout → coach → harvest loop beats you clicking in Agent Computer.

**Do not use Magpie** for one fact from one URL, trivia, or non-browser questions.
Answer those yourself.

### 5. Run the job (summary — details in fetched SKILL.md)

1. If `/workspace/magpie/current-job.json` exists for this goal → **status/steer**
   only (same `session_id`). Do not start again.
2. Write `/workspace/magpie/plan.md` (Goal, Missing inputs/stop rules, coarse Plan —
   no `click(` / CSS / “type into”).
3. Start once:

```bash
source /workspace/magpie/env.sh 2>/dev/null || true
export MAGPIE_SESSION_DIR="${MAGPIE_SESSION_DIR:-/workspace/magpie/sessions}"
magpie --json --session-dir "$MAGPIE_SESSION_DIR" --plan-file /workspace/magpie/plan.md "<human goal>"
```

4. Parse last stdout JSON line → save `session_id` / `goal_id` in
   `/workspace/magpie/current-job.json`.
5. Poll / steer the **same** id until a result or hard block:

```bash
magpie --json --session-dir "$MAGPIE_SESSION_DIR" --session <session_id>
magpie --session-dir "$MAGPIE_SESSION_DIR" --session <session_id> -p "<status or instruction>"
```

6. Return the harvest to the human. Do not dump CLI flags unless they ask.

Hard blocks: missing `OPENROUTER_API_KEY`; Magpie older than 0.1.5 (no `--json`);
Chrome/login needed and you cannot complete takeover. Then stop and say what is
missing — do not invent people or accounts.
