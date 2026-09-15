# Magpie parent — Hermes / OpenClaw package

Same contract as Grok Bot: the human sends a **goal**; you fetch and follow
`skills/magpie-parent/SKILL.md`. Do not fork Magpie rules into a host-local paste.

```text
https://raw.githubusercontent.com/naiemk/browser-session-agent/main/skills/magpie-parent/SKILL.md
```

You are the **parent**. Magpie is the delegated browser worker for **long-running
repetitive** browser jobs (multi-site harvest, qualify ~N entities, scroll+peek
lists, campaigns). You do not drive the browser yourself. Tiny one-URL lookups stay
with you.

## Install Magpie

**Package:** `@naiemk/magpi` · **Latest:** `0.1.5` (need ≥ 0.1.5 for `--json` /
`profiles`). Binary: `magpie`. Need **Node ≥ 24**.

```bash
node -v   # v24+
npm install -g @naiemk/magpi@0.1.5
# or: npm install -g @naiemk/magpi
magpie --help | head -40
```

`--json` and `profiles` must appear. Do not run bare `magpie` (TUI). Prefer a
checkout of this repo; otherwise `curl` the raw SKILL.md URL and follow that file.

Session dir: Magpie default `~/.browser-agent-core/pi-sessions` unless
`MAGPIE_SESSION_DIR` is set. (Grok Bot uses `/workspace/magpie/sessions`.)

## OpenRouter API key

Magpie harvest turns use **Magpie’s** provider, not the Hermes/OpenClaw chat model.

```bash
test -n "$OPENROUTER_API_KEY" || {
  echo "Set OPENROUTER_API_KEY in the Magpie process env before starting a harvest."
  exit 1
}
export OPENROUTER_API_KEY
```

Ask the human once if the key is missing. Never paste keys into transcripts or
skills. Do not burn parent-agent credits doing the harvest yourself.

## Low-cost model pins (recommended)

| Slot | Model | Role |
| --- | --- | --- |
| Worker (`default`) | `openrouter/z-ai/glm-5.3-flash` | Cheap harvest / operate loop |
| Planner (`plan`) | `openrouter/z-ai/glm-5.3` | Admit / coarse plan |
| Coach (`coach`) | `openrouter/z-ai/glm-5.3` | Strategy after scout |
| Coding child | `openrouter/z-ai/glm-5.3` (or stronger coder if Magpie spawns `coder`) | Scratch extract / unzip / code — not the harvest loop |

```bash
mkdir -p ~/.browser-agent-core
cat > ~/.browser-agent-core/models.json <<'EOF'
{
  "default": "openrouter/z-ai/glm-5.3-flash",
  "plan": "openrouter/z-ai/glm-5.3",
  "coach": "openrouter/z-ai/glm-5.3"
}
EOF
# Optional: magpie profiles recommend / apply budget — only after human confirm.
# Writing models.json above is the preferred GLM low-cost setup.
```

## Host chrome

- One-shot ACP is Mode A (`npx -y browser-session-agent acp`); long harvests are
  Mode B (`magpie --json`). See `skills/browser-harness/SKILL.md`.
- Start once → keep `session_id` → status/instruct with `--session <id>` → return
  the result. Never start a second Magpie session for the same goal.
- Follow the fetched `SKILL.md` for plan.md shape, polling, and hard blocks.
