import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import browserSessionAgent from "../../src/extension.ts";
import { bindCoach, COACH_CHECKPOINT_ENTRY, COACH_COMMAND, COACH_REVIEW_THINKING } from "../../src/host/pi-coach.ts";
import { MAGPIE_MODELS_FILE } from "../../src/host/pi-models.ts";
import { MAGPIE_CHAT_OBJECTIVE } from "../../src/host/pi-operator-goal.ts";
import { fileEvidence } from "../../src/host/evidence.ts";
import { MAGPIE_GOAL_ENTRY } from "../../src/host/pi-session-goal.ts";
import { MAGPIE_RESCUE_ACTIONS_WITHOUT_YIELD } from "../../src/runtime/coach/rescue.ts";
import { TOOL_REMEMBER } from "../../src/runtime/names.ts";
import { PLACEHOLDER } from "../../src/runtime/prune.ts";
import { PLAN_COMMAND, PLAN_MODE_CONTEXT, SCOUT_EXECUTE_HINT, HARVEST_EXECUTE_HINT } from "../../src/host/pi-plan-mode.ts";
import {
  coachStepNumber,
  executorRemaining,
  extractTodoItems,
  preCoachComplete,
} from "../../src/host/pi-plan-todos.ts";
import { STRATEGY_JSON_EXAMPLE } from "../../src/runtime/coach/strategy.ts";
import { extensionContext } from "../../src/host/memory-host.ts";
import { NodeHub } from "../../src/hosts/web/hub.ts";
import { OperatorRuntime } from "../../src/hosts/web/runtime.ts";
import { memoryEvidence } from "../../src/runtime/evidence.ts";
import { createFakePi, runCommand, runTool } from "../helpers/fake-pi.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/host/pi-subagent/bind.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const homes: string[] = [];
let previousCore: string | undefined;

beforeEach(() => {
  previousCore = process.env.BSA_CORE_HOME;
});

afterEach(async () => {
  if (previousCore === undefined) delete process.env.BSA_CORE_HOME;
  else process.env.BSA_CORE_HOME = previousCore;
  previousCore = undefined;
  while (homes.length) {
    await new Promise((resolve) => setImmediate(resolve));
    await rm(homes.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function tempCore(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "bsa-coach-"));
  homes.push(home);
  process.env.BSA_CORE_HOME = home;
  return home;
}

async function writePins(home: string, pins: { default?: string; plan?: string; coach?: string }): Promise<void> {
  await writeFile(
    path.join(home, MAGPIE_MODELS_FILE),
    `${JSON.stringify({ default: "", plan: "", coach: "", ...pins }, null, 2)}\n`,
  );
}

const ARTIFACT = {
  schemaVersion: 1,
  summary: "Venue tagged posts then peek.",
  loop: ["Search venues", "Open tagged", "Peek profiles; keep the list"],
  qualify: ["Apply the goal criteria; do not loosen them"],
  exceptions: [],
  record: ["candidate_accepted after a peek"],
  stop: ["After 8 accepts"],
  doNot: ["Navigate away and Back"],
  confidence: "medium",
  falsify: "Tagged grid empty on two venues",
  assumptions: [],
};

describe("AGENT-16-T03 interactive /coach", () => {
  it("plan-mode context requires scout → coach → harvest and forbids tactic lists", () => {
    assert.match(PLAN_MODE_CONTEXT, /scout/i);
    assert.match(PLAN_MODE_CONTEXT, /coach/i);
    assert.match(PLAN_MODE_CONTEXT, /harvest/i);
    assert.match(PLAN_MODE_CONTEXT, /MUST NOT invent a list of site tactics/i);
    assert.match(PLAN_MODE_CONTEXT, /qualification quality/i);
    assert.match(HARVEST_EXECUTE_HINT, /peek\/observe/i);
    assert.match(HARVEST_EXECUTE_HINT, /coder fetch/i);
  });

  it("/coach disables act / save / subagent while the review turn runs", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    assert.equal(pi.getActiveTools().includes("act"), true);
    await runCommand(pi, COACH_COMMAND, "");
    assert.equal(pi.getActiveTools().includes("act"), false);
    assert.equal(pi.getActiveTools().includes("save_artifact"), false);
    assert.equal(pi.getActiveTools().includes("subagent"), false);
    assert.equal(pi.getActiveTools().includes("observe"), true);
    assert.match(pi.notifications.join("\n"), /mutations off/i);
    assert.ok(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")));
  });

  it("replaces the session transcript with the digest for the coach model", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, COACH_COMMAND, "");
    const results = await pi.emit("context", {
      messages: [
        { role: "user", content: "controls: [{ref: e1, name: Submit}]" },
        { role: "assistant", content: "I clicked around" },
      ],
    });
    const coach = [...results]
      .reverse()
      .find(
        (result) =>
          result &&
          typeof result === "object" &&
          JSON.stringify(result).includes("[COACH REVIEW]"),
      );
    const payload = JSON.stringify(coach);
    assert.doesNotMatch(payload, /controls:/);
    assert.match(payload, /Trajectory digest/);
    assert.match(payload, /\[COACH REVIEW\]/);
  });

  it("persists a Fake assistant JSON artifact and restores it on session_start", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, COACH_COMMAND, "");
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.ok(pi.entries.some((entry) => entry.customType === COACH_CHECKPOINT_ENTRY));
    assert.equal(pi.getActiveTools().includes("act"), true);
    assert.ok(pi.customMessages.some((message) => /STRATEGY/.test(message.content)));

    const resume = createFakePi();
    resume.entries.push(...pi.entries);
    browserSessionAgent(resume);
    await resume.startSession();
    const injected = await resume.emit("before_agent_start", {});
    const text = JSON.stringify(injected);
    assert.match(text, /STRATEGY/);
    assert.match(text, /Peek profiles/);
    assert.doesNotMatch(text, /"actions":/);
  });

  it("rejects subagent({ agent: coach })", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    const result = await runTool(pi, SUBAGENT_TOOL_NAME, { agent: "coach", task: "write a strategy" });
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    assert.match(text, /\/coach/);
    assert.equal(result.details?.error, "coach_not_a_worker");
  });

  it("hosted /coach disables act on the real session tools", async () => {
    await tempCore();
    const notes: string[] = [];
    const runtime = new OperatorRuntime(new NodeHub(), (message) => {
      if (message.type === "notify") notes.push(message.message);
    });
    runtime.host.setActiveTools(["observe", "act", "probe", "ask_user", "subagent", "save_artifact"]);
    await runtime.api.commands.get(COACH_COMMAND)?.handler("", extensionContext(runtime.host));
    assert.match(notes.join("\n"), /mutations off/i);
    assert.equal(runtime.host.getActiveTools().includes("act"), false);
    assert.equal(runtime.host.getActiveTools().includes("subagent"), false);
    assert.equal(runtime.host.getActiveTools().includes("observe"), true);
  });

  it("bindCoach compiles from memoryEvidence without a provider", async () => {
    const pi = createFakePi();
    const evidence = memoryEvidence();
    await evidence.ledger.append({
      type: "action",
      intent: "open list",
      action: { kind: "click" },
      after: { url: "https://example.test/list", title: "List", changes: [] },
      outcome: { ok: true },
    });
    bindCoach(pi, { evidence, objective: "collect", criteria: ["nightlife"] });
    await pi.startSession();
    await runCommand(pi, COACH_COMMAND, "");
    const digest = pi.userMessages.join("\n");
    assert.match(digest, /collect/);
    assert.doesNotMatch(digest, /controls:/);
  });

  it("exposes /coach on the hosted chat command bar", async () => {
    const source = await readFile(path.join(ROOT, "src/hosts/web/public/app.js"), "utf8");
    assert.match(source, /\["coach", "Review-phase strategy coach"\]/);
  });

  it("tells the coach the closed schema so invented nested JSON is not accepted as empty", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, COACH_COMMAND, "");
    assert.ok(pi.userMessages.some((text) => text.includes(STRATEGY_JSON_EXAMPLE)));
    assert.ok(pi.userMessages.some((text) => /escalate-to-observe/i.test(text)));
    const invented =
      "```json\n" +
      JSON.stringify({
        schemaVersion: 1,
        artifact: "coach_strategy_review",
        strategy: { route_affordances_to_keep: ["peek profiles"] },
        do_not: { skipApproval: true },
      }) +
      "\n```";
    await pi.emit("turn_end", { message: { role: "assistant", content: invented } });
    await pi.emit("agent_end", { messages: [{ role: "assistant", content: invented }] });
    const rejects = pi.notifications.filter((note) => /rejected/i.test(note));
    assert.equal(rejects.length, 1);
    assert.match(rejects[0] ?? "", /dropping unknown keys/i);
    assert.ok(pi.userMessages.some((text) => /Previous output was rejected/i.test(text)));
    assert.equal(pi.entries.some((entry) => entry.customType === COACH_CHECKPOINT_ENTRY), false);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.ok(pi.entries.some((entry) => entry.customType === COACH_CHECKPOINT_ENTRY));
    assert.equal(pi.getActiveTools().includes("act"), true);
  });
});

const CALIBRATION_PLAN = `Plan:
1. Establish identity & access: Log into instagram.com, confirm which account
2. Scout (tight budget): Probe 3–4 discovery routes with a small cap each
3. Record scout findings: Save the samples + notes on which routes yield
4. Coach: Submit the scout artifact for coaching to turn "popular party goer" into criteria
5. Harvest (blocked on coach artifact): Using the coached criteria and the best loop
6. Dedupe & quality pass: Remove duplicates, business/club accounts, and extras
7. Deliver: Save the final list of ~20 candidates to a file in the scratch
`;

function executeContent(pi: ReturnType<typeof createFakePi>): string {
  return pi.customMessages
    .filter((message) => message.customType === "plan-mode-execute")
    .map((message) => message.content)
    .join("\n---\n");
}

async function executeNumberedPlan(pi: ReturnType<typeof createFakePi>, plan: string): Promise<void> {
  await runCommand(pi, PLAN_COMMAND, "");
  await pi.emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: plan }] }],
  });
}

describe("AGENT-16-T05 Magpie Execute invokes /coach", () => {
  it("classifies live goal_mtumeewm001 todo strings: coach is step 4, harvest still contains the word", () => {
    const items = extractTodoItems(CALIBRATION_PLAN);
    assert.equal(items.length, 7);
    assert.equal(coachStepNumber(items), 4);
    assert.match(items[3]?.text ?? "", /^Coach:/);
    assert.match(items[4]?.text ?? "", /Harvest.*coach/i);
    const pre = items.filter((item) => item.step < 4);
    assert.equal(pre.length, 3);
    assert.equal(preCoachComplete(items), false);
    for (const item of pre) item.completed = true;
    assert.equal(preCoachComplete(items), true);
    const scout = executorRemaining(items, false);
    assert.equal(scout.length, 0);
    assert.equal(scout.some((item) => /^Coach:/i.test(item.text)), false);
    const harvest = executorRemaining(items, true);
    assert.ok(harvest.some((item) => /^Harvest/i.test(item.text)));
    assert.equal(harvest.some((item) => /^Coach:/i.test(item.text)), false);
  });

  it("Execute remaining-steps omit Coach: Submit and Harvest until an artifact exists", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    const exec = executeContent(pi);
    assert.match(exec, /scout only/i);
    assert.match(exec, /Scout \(tight budget\)/);
    assert.match(exec, /Record scout findings/);
    assert.match(exec, new RegExp(SCOUT_EXECUTE_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(exec, /Coach: Submit/);
    assert.doesNotMatch(exec, /Harvest \(blocked/);
    const injected = await pi.emit("before_agent_start", {});
    const text = JSON.stringify(injected);
    assert.match(text, /scout only/i);
    assert.doesNotMatch(text, /Coach: Submit/);
    assert.doesNotMatch(text, /Harvest \(blocked/);
  });

  it("Execute starts one scout-only turn, not a full todo list that includes Coach", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    const todoLists = pi.customMessages.filter((message) => message.customType === "plan-todo-list");
    const executes = pi.customMessages.filter((message) => message.customType === "plan-mode-execute");
    assert.equal(todoLists.length, 0);
    assert.equal(executes.length, 1);
    assert.match(executes[0]?.content ?? "", /scout only/i);
    assert.doesNotMatch(executes[0]?.content ?? "", /Coach: Submit/);
    assert.equal(pi.userMessages.filter((text) => text.includes("Execute the plan")).length, 1);
    const widget = pi.widgets.get("plan-todos") ?? [];
    assert.ok(widget.some((line) => /Coach:/i.test(line)));
    assert.ok(widget.some((line) => /Harvest/i.test(line)));
  });

  it("pre-coach [DONE:n] then agent_end runs the T03 coach handler", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    assert.equal(pi.getActiveTools().includes("act"), true);
    await pi.emit("turn_end", {
      message: {
        role: "assistant",
        content: "Identity, scout, and notes recorded. [DONE:1] [DONE:2] [DONE:3]",
      },
    });
    assert.equal(pi.getActiveTools().includes("act"), true);
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);
    await pi.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          content: "Identity, scout, and notes recorded. [DONE:1] [DONE:2] [DONE:3]",
        },
      ],
    });
    assert.equal(pi.getActiveTools().includes("act"), false);
    assert.equal(pi.getActiveTools().includes("save_artifact"), false);
    assert.equal(pi.getActiveTools().includes("subagent"), false);
    assert.ok(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")));
    assert.match(pi.notifications.join("\n"), /mutations off/i);
  });

  it("accepted artifact marks the coach todo complete and injects Harvest, not a second review", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    await pi.emit("turn_end", {
      message: {
        role: "assistant",
        content: "[DONE:1] [DONE:2] [DONE:3]",
      },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
    });
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.ok(pi.entries.some((entry) => entry.customType === COACH_CHECKPOINT_ENTRY));
    assert.equal(pi.getActiveTools().includes("act"), true);
    const plan = [...pi.entries].reverse().find((entry) => entry.customType === "plan-mode") as
      | { data?: { todos?: Array<{ text: string; completed: boolean }> } }
      | undefined;
    const coachTodo = plan?.data?.todos?.find((todo) => /^Coach:/i.test(todo.text));
    assert.equal(coachTodo?.completed, true);
    const harvestExec = pi.customMessages.filter((message) => message.customType === "plan-mode-execute").at(-1);
    assert.match(harvestExec?.content ?? "", /Harvest \(blocked/);
    assert.doesNotMatch(harvestExec?.content ?? "", /^@medium\n/);
    assert.match(harvestExec?.content ?? "", new RegExp(HARVEST_EXECUTE_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(harvestExec?.content ?? "", /Coach: Submit/);
    assert.doesNotMatch(harvestExec?.content ?? "", /scout only/i);
    const reviewStarts = pi.userMessages.filter((text) => text.includes("[COACH REVIEW]"));
    assert.equal(reviewStarts.length, 1);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: JSON.stringify(ARTIFACT) }],
    });
    assert.equal(pi.userMessages.filter((text) => text.includes("[COACH REVIEW]")).length, 1);
    const injected = await pi.emit("before_agent_start", {});
    const text = JSON.stringify(injected);
    assert.match(text, /STRATEGY/);
    assert.match(text, /Harvest \(blocked/);
    assert.doesNotMatch(text, /Coach: Submit/);
  });

  it("known_flow Execute does not start review", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(
      pi,
      "Plan:\n1. Open the jobs page first\n2. Collect every listing next\n",
    );
    const exec = executeContent(pi);
    assert.doesNotMatch(exec, /scout only/i);
    assert.match(exec, /jobs page/i);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: "Opened. [DONE:1]" },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "Opened. [DONE:1]" }],
    });
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);
    assert.equal(pi.getActiveTools().includes("act"), true);
  });
});

function magpieGoalId(pi: ReturnType<typeof createFakePi>): string {
  const entry = [...pi.entries].reverse().find((item) => item.customType === MAGPIE_GOAL_ENTRY);
  const goalId = (entry?.data as { goalId?: string } | undefined)?.goalId;
  assert.ok(goalId);
  return goalId;
}

async function appendHarvestActions(pi: ReturnType<typeof createFakePi>, count: number): Promise<void> {
  const evidence = fileEvidence({ goalId: () => magpieGoalId(pi), goal: "t06" });
  for (let i = 0; i < count; i++) {
    await evidence.ledger.append({
      type: "action",
      intent: `harvest hop ${i}`,
      action: { kind: "click" },
      outcome: { ok: true },
      after: { url: `https://example.test/u/${i}`, title: "profile", changes: ["navigated"] },
    });
  }
}

async function runCalibrationToArtifact(pi: ReturnType<typeof createFakePi>): Promise<void> {
  pi.userMessages.push("Collect nightlife candidates; person not brand; do not help the operator.");
  await executeNumberedPlan(pi, CALIBRATION_PLAN);
  await pi.emit("turn_end", {
    message: { role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" },
  });
  await pi.emit("agent_end", {
    messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
  });
  await pi.emit("turn_end", {
    message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
  });
}

describe("AGENT-16-T06 Magpie closed-loop coach", () => {
  it("removes subagent while awaiting host coach and restores it after the artifact", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    assert.equal(pi.getActiveTools().includes("subagent"), false);
    assert.equal(pi.getActiveTools().includes("act"), true);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
    });
    assert.equal(pi.getActiveTools().includes("subagent"), false);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.equal(pi.getActiveTools().includes("subagent"), true);
    assert.equal(pi.getActiveTools().includes("act"), true);
  });

  it("coaches after scout remember yield without [DONE:n], not after an empty puff", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "Looking around." }],
    });
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);
    await runTool(pi, TOOL_REMEMBER, {
      key: "list-exists",
      value: "source list is scrollable",
      yield: "route_affordance",
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "Scout notes recorded." }],
    });
    assert.ok(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")));
  });

  it("does not skip scout for plan-mode yields; widget leaves Scout when coach runs", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, PLAN_COMMAND, "");
    await runTool(pi, TOOL_REMEMBER, {
      key: "hashtag-dead",
      value: "tags redirect to keyword search",
      yield: "route_affordance",
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: CALIBRATION_PLAN }] }],
    });
    // Execute click must not coach from the plan-mode remember (goal_mtvx69qt001).
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "empty puff" }],
    });
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);

    await runTool(pi, TOOL_REMEMBER, {
      key: "grid-scrolls",
      value: "keyword results load on scroll",
      yield: "route_affordance",
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "Scout sample recorded." }],
    });
    assert.ok(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")));

    const duringCoach = pi.widgets.get("plan-todos") ?? [];
    assert.ok(
      duringCoach.filter((line) => line.startsWith("☑")).length >= 3,
      `scout should be checked off before coach finishes: ${duringCoach.join(" | ")}`,
    );
    assert.ok(
      duringCoach.some((line) => line.startsWith("→") && /Coach/i.test(line)),
      `active step should be Coach, not Scout: ${duringCoach.join(" | ")}`,
    );

    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    const after = pi.widgets.get("plan-todos") ?? [];
    assert.ok(after.some((line) => /^☑.*Coach/i.test(line)), after.join(" | "));
    assert.ok(after.some((line) => /^→.*Harvest/i.test(line)), after.join(" | "));
  });

  it("requests thinking high for review and restores it after accept", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
    });
    assert.equal(pi.thinkingLog.includes(COACH_REVIEW_THINKING), true);
    assert.equal(pi.thinkingLevel, COACH_REVIEW_THINKING);
    const review = pi.userMessages.find((text) => text.includes("[COACH REVIEW]")) ?? "";
    assert.doesNotMatch(review, /^@(low|medium|high|ultra)\n/i);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.equal(pi.thinkingLevel, "medium");
    assert.equal(pi.thinkingLog.at(-1), "medium");
  });

  it("switches to the coach pin for review and restores the prior model", async () => {
    const home = await tempCore();
    await writePins(home, { coach: "test/strong-coach" });
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
    });
    assert.equal(pi.modelLog.includes("test/strong-coach"), true);
    assert.equal(pi.currentModelId(), "test/strong-coach");
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.equal(pi.currentModelId(), "fake/session");
    assert.equal(pi.modelLog.at(-1), "fake/session");
  });

  it("does not start review when the coach pin is not in the registry", async () => {
    const home = await tempCore();
    await writePins(home, { coach: "nope/missing" });
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await executeNumberedPlan(pi, CALIBRATION_PLAN);
    await pi.emit("turn_end", {
      message: { role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" },
    });
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "[DONE:1] [DONE:2] [DONE:3]" }],
    });
    assert.equal(pi.userMessages.some((text) => text.includes("[COACH REVIEW]")), false);
    assert.equal(pi.thinkingLevel, "medium");
    assert.match(pi.notifications.join("\n"), /not in the Pi model registry/);
  });

  it("hosted /coach still runs when a coach pin is set but the host cannot switch models", async () => {
    const home = await tempCore();
    await writePins(home, { coach: "test/strong-coach" });
    const notes: string[] = [];
    const runtime = new OperatorRuntime(new NodeHub(), (message) => {
      if (message.type === "notify") notes.push(message.message);
    });
    runtime.host.setActiveTools(["observe", "act", "probe", "ask_user", "subagent", "save_artifact"]);
    await runtime.api.commands.get(COACH_COMMAND)?.handler("", extensionContext(runtime.host));
    assert.match(notes.join("\n"), /mutations off/i);
    assert.match(notes.join("\n"), /coach model skipped/i);
    assert.equal(runtime.host.getActiveTools().includes("act"), false);
  });

  it("plan pin switches on /plan and Execute restores before scout", async () => {
    const home = await tempCore();
    await writePins(home, { plan: "test/plan-opus" });
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, PLAN_COMMAND, "");
    assert.equal(pi.currentModelId(), "test/plan-opus");
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: CALIBRATION_PLAN }] }],
    });
    assert.equal(pi.currentModelId(), "fake/session");
    assert.match(executeContent(pi), /scout/i);
  });

  it("manual /coach during plan restores the plan pin, not the operate model", async () => {
    const home = await tempCore();
    await writePins(home, { plan: "test/plan-opus", coach: "test/strong-coach" });
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCommand(pi, PLAN_COMMAND, "");
    assert.equal(pi.currentModelId(), "test/plan-opus");
    await runCommand(pi, COACH_COMMAND, "");
    assert.equal(pi.currentModelId(), "test/strong-coach");
    await pi.emit("turn_end", {
      message: { role: "assistant", content: JSON.stringify(ARTIFACT) },
    });
    assert.equal(pi.currentModelId(), "test/plan-opus");
  });

  it("puts the plan objective in the digest, not the generic Magpie card", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCalibrationToArtifact(pi);
    const review = pi.userMessages.find((text) => text.includes("[COACH REVIEW]")) ?? "";
    assert.match(review, /Collect nightlife candidates/);
    assert.match(review, /person not brand/);
    assert.doesNotMatch(review, new RegExp(MAGPIE_CHAT_OBJECTIVE.slice(0, 40)));
  });

  it("drops scout snapshots at the coach boundary and keeps STRATEGY", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCalibrationToArtifact(pi);
    const injected = await pi.emit("before_agent_start", {});
    const text = JSON.stringify(injected);
    assert.match(text, /STRATEGY/);
    assert.doesNotMatch(text, /"controls":/);
    const [compacted] = (await pi.emit("context", {
      messages: [
        {
          role: "toolResult",
          toolName: "act",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                url: "https://example.test/list",
                controls: [{ ref: "e1", role: "link", name: "Tagged" }],
              }),
            },
          ],
        },
        { role: "user", content: "[COACH REVIEW]\n{}" },
        { role: "assistant", content: "STRATEGY (untrusted guidance; the live page is the authority)" },
      ],
    })) as [{ messages?: Array<{ content?: unknown }> } | undefined];
    assert.ok(compacted?.messages);
    assert.doesNotMatch(JSON.stringify(compacted.messages[0]?.content), /controls/);
    assert.match(JSON.stringify(compacted.messages), /STRATEGY \(untrusted/);
    assert.match(
      JSON.stringify(compacted.messages[0]?.content),
      new RegExp(PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("rescues after N actions without candidate yield; elapsed-ms-only does not; second empty rescue halts", async () => {
    await tempCore();
    const pi = createFakePi();
    browserSessionAgent(pi);
    await pi.startSession();
    await runCalibrationToArtifact(pi);
    const digestReviews = () =>
      pi.userMessages.filter((text) => text.includes("Trajectory digest (not the session transcript)"));
    assert.equal(digestReviews().length, 1);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "harvesting without new actions" }],
    });
    assert.equal(digestReviews().length, 1);
    await appendHarvestActions(pi, MAGPIE_RESCUE_ACTIONS_WITHOUT_YIELD);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "still hopping" }],
    });
    assert.equal(digestReviews().length, 2);
    assert.match(digestReviews()[1] ?? "", /"followed":false/);
    await pi.emit("turn_end", { message: { role: "assistant", content: "not-json-1" } });
    await pi.emit("turn_end", { message: { role: "assistant", content: "not-json-2" } });
    await pi.emit("turn_end", { message: { role: "assistant", content: "not-json-3" } });
    assert.match(pi.notifications.join("\n"), /Coach review ended/i);
    await appendHarvestActions(pi, MAGPIE_RESCUE_ACTIONS_WITHOUT_YIELD);
    await pi.emit("agent_end", {
      messages: [{ role: "assistant", content: "still hopping after empty rescue" }],
    });
    assert.equal(digestReviews().length, 2);
    assert.match(pi.notifications.join("\n"), /Stopping for the operator/i);
  });
});
