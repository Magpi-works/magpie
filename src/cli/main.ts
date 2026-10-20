#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Three things, deliberately: run one goal against a live site, run the task suite, and
 * read back a run's evidence. No socket, no pairing, no background service — the CLI is
 * the shortest path from a goal to a verified result, and the easiest thing to debug when
 * something goes wrong.
 */

import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalBrowser } from "../core/browser.ts";
import { evaluateTask } from "../core/evaluator.ts";
import { Ledger } from "../core/ledger.ts";
import { coreRoot, goalPaths } from "../core/paths.ts";
import { PlanStore } from "../core/plan.ts";
import { parsePredicate } from "../core/predicates.ts";
import { GoalStore } from "../core/state.ts";
import { TaskStore } from "../core/task.ts";
import type { Predicate } from "../core/types.ts";
import { evidenceForGoal } from "../host/evidence.ts";
import { FilePayloadLog, FileRecorder } from "../optimize/recorder.ts";
import { createLiveModel } from "../runtime/model.ts";
import { runTaskWithDeclineRetry } from "../runtime/runtime.ts";
import { JobService } from "../jobs/service.ts";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      // Repeated flags collect into a comma-joined value, so --criterion can be given twice.
      flags[name] = flags[name] === undefined ? next : `${String(flags[name])},${next}`;
      index += 1;
    }
  }

  return { command, positional, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagList(flags: ParsedArgs["flags"], name: string): string[] {
  return splitFlagList(flagString(flags, name) ?? "")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Splits a comma-joined repeated flag, but never inside a JSON value: a JSON criterion
 * such as `{"kind":"url_includes","text":"/pay"}` contains commas of its own.
 */
export function splitFlagList(value: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if ((char === "}" || char === "]") && depth > 0) depth -= 1;
    else if (char === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

/** `--criterion "text_visible:Thanks"` or raw JSON for the full predicate language. */
export function parseCriterion(raw: string): Predicate {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return parsePredicate(JSON.parse(trimmed));
  const separator = trimmed.indexOf(":");
  if (separator < 0) {
    return parsePredicate({ kind: "text_visible", text: trimmed });
  }
  const kind = trimmed.slice(0, separator).trim();
  const rest = trimmed.slice(separator + 1).trim();
  if (kind === "value_includes" || kind === "value_equals") {
    const [name, ...value] = rest.split("=");
    return parsePredicate({ kind, name: (name ?? "").trim(), text: value.join("=").trim() });
  }
  if (kind === "control_exists" || kind === "control_absent") {
    return parsePredicate({ kind, name: rest });
  }
  return parsePredicate({ kind, text: rest });
}

const HELP = `browser-agent — drive a browser toward a verified goal

Usage:
  browser-agent run "<goal>" --url <url> [options]
  browser-agent suite [--target mock|reference|live] [options]
  browser-agent goals [--limit <n>] [--root <dir>]
  browser-agent replay <goalId> [--root <dir>]
  browser-agent metrics <goalId> [--root <dir>] [--json]
  browser-agent compare <baseline.json> <current.json>
  browser-agent acp                   speak ACP on stdio (goal in, verdict out)
  browser-agent perceive diff <url> [--a reference] [--b lean]
  browser-agent perceive golden <dir> [--perceiver lean]
  browser-agent jobs [--root <dir>] [--json]
  browser-agent job create "<objective>" [--title NAME] [--root <dir>] [--json]
  browser-agent job show <id> [--root <dir>] [--json]
  browser-agent job title <id> <title> [--root <dir>]
  browser-agent job approve-plan <id> --hash <hash> [--root <dir>]
  browser-agent job pause <id> [--root <dir>]
  browser-agent job resume <id> [--root <dir>]
  browser-agent job tick <id>|--due [--root <dir>] [--json]
  browser-agent job run <id> --allow-ephemeral [--root <dir>] [--json] [--max-ticks <n>] [--headed]

  browser-agent durable …            Jobs V2 control plane (see durable help)

EXPERIMENTAL: the src/jobs prototype is not a production scheduler. job tick without a
model/browser host returns runtime_unavailable (exit 4), never idle. Do not cron these
commands until Jobs V2 attaches a persistent ExecutionHost. job run uses an ephemeral
Playwright browser (no Magpie profile); --allow-ephemeral is required and warns on stderr.
Use \`browser-agent durable\` for the Jobs V2 SQLite path. durable tick without --host
(or BSA_DURABLE_HOST=1) exits 4; with attach it uses the Magpie persistent profile + a
live model, or still exits 4 if either is missing (never fake success).

run options:
  --url <url>              page to start from (required)
  --criterion <spec>       success criterion; repeatable. "Thanks" or
                           "text_visible:Thanks" or "value_includes:Email=ada"
                           or raw JSON. Defaults to asking the model to report only.
  --policy auto|ask|never  irreversible actions (default: ask)
  --max-turns <n>          turn budget (default: 16)
  --model <provider/id>    override model selection
  --headed                 show the browser
  --root <dir>             where evidence goes (default: ~/.browser-agent-core)
  --json                   machine-readable result on stdout

suite options:
  --target mock            token-free: real loop, mock model (default)
  --target reference       no model at all: validates the tasks themselves
  --target live            real model; costs tokens
  --smoke                  a small representative subset (live default)
  --all                    every task
  --only <id,id>           specific task ids
  --tags <tag,tag>         tasks carrying any of these tags
  --view <name>            page description to measure (default: table)
  --perceiver <name>       how the page is read (default: lean)
  --out <file>             write the JSON report
  --optimize-out <file>    write just the cost summary, for a committed baseline
  --pause <ms>             gap between tasks (live default: 2000)

replay options:
  --root <dir>             evidence root

metrics options:
  --root <dir>             evidence root
  --json                   the full rollup as JSON

compare takes two suite reports and explains what moved, attributed by payload.
It never exits non-zero for a regression: a rise with a named cause is a
decision to make, not a build to break.

perceive diff prints the controls one perceiver found and the other missed.
perceive golden writes that control set for the committed corpus.
`;

async function commandRun(args: ParsedArgs): Promise<number> {
  const goal = args.positional.join(" ").trim();
  const url = flagString(args.flags, "url");
  if (!goal || !url) {
    process.stderr.write("run needs a goal and --url\n\n" + HELP);
    return 2;
  }

  const criteria = flagList(args.flags, "criterion").map(parseCriterion);
  const policy = (flagString(args.flags, "policy") ?? "ask") as "auto" | "ask" | "never";
  const maxTurns = Number(flagString(args.flags, "max-turns") ?? 16);
  const root = flagString(args.flags, "root") ?? coreRoot();
  const goalId = PlanStore.newGoalId();

  const live = await createLiveModel({ model: flagString(args.flags, "model") });
  const browser = await LocalBrowser.launch({ headless: !args.flags.headed });
  const ledger = await Ledger.open(root, goalId);
  const metrics = await FileRecorder.open(goalPaths(root, goalId).metricsFile);
  const payloads = await FilePayloadLog.open(goalPaths(root, goalId).payloadsFile);
  const store = await TaskStore.open(root, goalId);
  const goalStore = await GoalStore.open(root, goalId, goal);

  // A goal with no stated criteria still gets one, so "did it work" has an answer.
  const effective = criteria.length > 0 ? criteria : [{ kind: "url_includes" as const, text: "" }];
  const task = await store.create({ objective: goal, criteria: effective, maxTurns });

  try {
    const tab = await browser.openTab(url);
    process.stderr.write(`goal ${goalId} — ${live.name}\nevidence ${root}/goals/${goalId}\n`);

    const attempt = await runTaskWithDeclineRetry({
      card: { objective: goal, criteria: effective, startUrl: url, policy },
      maxTurns,
      stream: live.stream,
      model: live.model,
      tools: {
        browser,
        tabId: tab,
        evidence: evidenceForGoal({
          root,
          goalId,
          ledger,
          store: goalStore,
          metrics,
          payloads,
        }),
        policy,
        askUser: async (question) => {
          process.stderr.write(`\nThe agent needs an answer: ${question}\n`);
          return undefined;
        },
        approve: async (request) => {
          process.stderr.write(
            `\nApproval needed: ${request.request.kind} — ${request.reason}\n` +
              `Re-run with --policy auto to allow it.\n`,
          );
          return false;
        },
      },
      // A refusal gets one more chance with whatever the agent established about the
      // situation, in case it declined only because it could not tell where it stood.
      factsOnRetry: async () => (await goalStore.goal()).facts,
    });

    const outcome = attempt.outcome;

    const evaluation = await evaluateTask({
      store,
      taskId: task.taskId,
      browser,
      ledger,
      tabId: tab,
      claim: outcome.report?.summary,
      capped: outcome.capped,
      sessionError: outcome.error ?? outcome.modelErrors[0],
      declined: outcome.declined,
    });

    const result = {
      goalId,
      status: evaluation.status,
      claimed: outcome.report ?? null,
      turns: outcome.turns,
      tokens: outcome.tokens,
      costUsd: Number(outcome.costUsd.toFixed(6)),
      checks: evaluation.verification.checks,
    };

    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `\n${evaluation.status.toUpperCase()} after ${outcome.turns} turns ` +
          `(${outcome.tokens} tokens, $${outcome.costUsd.toFixed(4)})\n`,
      );
      for (const check of evaluation.verification.checks) {
        process.stdout.write(`  ${check.passed ? "pass" : "FAIL"} ${check.predicate}\n`);
      }
      if (outcome.report) {
        process.stdout.write(`  agent said: ${outcome.report.status} — ${outcome.report.summary}\n`);
      }
      if (outcome.declined) {
        process.stdout.write(`  the agent declined and took no action: ${outcome.declined}\n`);
      }
    }

    return evaluation.status === "success" ? 0 : 1;
  } finally {
    await browser.close();
  }
}

async function commandSuite(args: ParsedArgs): Promise<number> {
  const [{ runSuite, formatReport }, { SUITE_TASKS }, { selectTasks }] = await Promise.all([
    import("../suite/runner.ts"),
    import("../suite/tasks.ts"),
    import("../suite/tags.ts"),
  ]);
  const { FixtureServer } = await import("../../tests/helpers/fixture-server.ts");

  const target = flagString(args.flags, "target") ?? "mock";
  const smoke = target === "live" ? !args.flags.all : Boolean(args.flags.smoke);
  const perceiverName = flagString(args.flags, "perceiver");
  const { perceiverByName } = await import("../core/perception/index.ts");
  const perceiver = perceiverByName(perceiverName);
  const tasks = selectTasks(SUITE_TASKS, {
    only: flagList(args.flags, "only"),
    tags: flagList(args.flags, "tags"),
    smoke,
    perceiver: perceiver.name,
  });

  if (tasks.length === 0) {
    process.stderr.write("no tasks matched the selection\n");
    return 2;
  }

  const server = new FixtureServer();
  const origin = await server.start();
  const root = flagString(args.flags, "root") ?? (await mkdtemp(path.join(os.tmpdir(), "suite-")));

  try {
    const driver = await buildDriver(target, root, {
      model: flagString(args.flags, "model"),
      view: flagString(args.flags, "view"),
    });
    process.stderr.write(`${tasks.length} task(s), target ${driver.name}, evidence ${root}\n`);

    const report = await runSuite({
      tasks,
      driver,
      origin,
      perceiver,
      // The runner reads evidence back itself, so it names where every run writes it.
      evidenceRoot: root,
      headless: !args.flags.headed,
      pauseMs: Number(flagString(args.flags, "pause") ?? (target === "live" ? 2000 : 0)),
      onTask: (run) => {
        process.stderr.write(
          `  ${(run.outcome === "passed" ? "ok" : run.outcome).padEnd(6)} ${run.id} ` +
            `(${run.steps} steps)\n`,
        );
        if (run.outcome !== "passed") process.stderr.write(`         ${run.detail}\n`);
      },
    });

    const out = flagString(args.flags, "out");
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stderr.write(`wrote ${out}\n`);
    }

    // Just the cost summary, which is what a committed baseline wants: the full report
    // carries per-run detail that churns on every commit and buries the numbers.
    const optimizeOut = flagString(args.flags, "optimize-out");
    if (optimizeOut && report.optimize) {
      await mkdir(path.dirname(optimizeOut), { recursive: true });
      await writeFile(
        optimizeOut,
        `${JSON.stringify(
          {
            note: "Structural cost of the token-free suite. Regenerate with npm run optimize:baseline.",
            recordedAt: report.finishedAt,
            target: report.target,
            taskCount: report.taskCount,
            optimize: report.optimize,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      process.stderr.write(`wrote ${optimizeOut}\n`);
    }

    process.stdout.write(`${formatReport(report)}\n`);
    return report.valid ? 0 : 1;
  } finally {
    await server.stop();
  }
}

async function buildDriver(target: string, root: string, options: { model?: string; view?: string } = {}) {
  const { ReferenceDriver } = await import("../suite/reference-driver.ts");
  if (target === "reference") return new ReferenceDriver();

  const { RuntimeDriver } = await import("../suite/runtime-driver.ts");
  const { createMockModel } = await import("../runtime/mock-model.ts");
  const { planForSteps, planForTask } = await import("../suite/mock-plan.ts");
  const { viewByName } = await import("../runtime/view/index.ts");

  // Named on the command line so a candidate description can be measured against the
  // baseline without editing code, which is the whole point of the seam.
  const view = viewByName(options.view);

  if (target === "mock") {
    return new RuntimeDriver({
      name: options.view ? `mock:${view.name}` : "mock",
      root,
      view,
      policy: "auto",
      answers: { name: "Ada Lovelace", email: "ada@example.com", password: "hunter2" },
      // The same view the tools were built with: the mock resolves a named target by
      // reading back the snapshot it was shown, so a mismatch here would fail every task
      // for a reason that has nothing to do with the description being measured.
      createStream: (task, origin) =>
        createMockModel({
          plans: [
            planForTask(task, origin),
            ...(task.followUps ?? []).map((follow) => planForSteps(follow.reference, origin)),
          ],
          view,
        }),
    });
  }

  if (target === "live") {
    const live = await createLiveModel({ model: options.model });
    process.stderr.write(`live model: ${live.name}\n`);
    return new RuntimeDriver({
      name: `live:${live.name}`,
      root,
      view,
      model: live.model,
      // Fixtures are disposable, so a live run commits without pausing for a human.
      policy: "auto",
      answers: { name: "Ada Lovelace", email: "ada@example.com", password: "hunter2" },
      createStream: () => live.stream,
    });
  }

  throw new Error(`unknown target "${target}". Available: mock, reference, live.`);
}

async function commandReplay(args: ParsedArgs): Promise<number> {
  const goalId = args.positional[0];
  if (!goalId) {
    process.stderr.write("replay needs a goal id\n");
    return 2;
  }
  const root = flagString(args.flags, "root") ?? coreRoot();
  const events = await Ledger.readFrom(root, goalId);
  if (events.length === 0) {
    process.stderr.write(`no evidence for ${goalId} under ${root}\n`);
    return 1;
  }
  for (const event of events) {
    const mark = event.outcome ? (event.outcome.ok ? "ok  " : "FAIL") : "    ";
    const action = event.action ? `${event.action.kind} ${event.action.ref ?? event.action.url ?? ""}` : "";
    process.stdout.write(
      `${mark} ${event.type.padEnd(14)} ${(event.intent ?? action).slice(0, 70)}\n`,
    );
    if (event.outcome?.detail) {
      process.stdout.write(`         ${event.outcome.detail.slice(0, 100)}\n`);
    }
  }
  return 0;
}

async function commandMetrics(args: ParsedArgs): Promise<number> {
  const goalId = args.positional[0];
  if (!goalId) {
    process.stderr.write("metrics needs a goal id\n");
    return 2;
  }
  const [{ readMetrics }, { rollup, formatRollup }] = await Promise.all([
    import("../optimize/recorder.ts"),
    import("../optimize/rollup.ts"),
  ]);

  const root = flagString(args.flags, "root") ?? coreRoot();
  const records = await readMetrics(goalPaths(root, goalId).metricsFile);
  if (records.length === 0) {
    process.stderr.write(
      `no metrics for ${goalId} under ${root}. Run \`browser-agent goals\` to list what is there.\n`,
    );
    return 1;
  }

  // The ledger answers repeat visits and repeat probes better than the metrics do, so
  // both are read when it is there.
  const events = await Ledger.readFrom(root, goalId).catch(() => []);
  const summary = rollup({ records, events, goalId });

  process.stdout.write(
    args.flags.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatRollup(summary)}\n`,
  );
  return 0;
}

async function commandCompare(args: ParsedArgs): Promise<number> {
  const [baselineFile, currentFile] = args.positional;
  if (!baselineFile || !currentFile) {
    process.stderr.write("compare needs a baseline file and a current file\n");
    return 2;
  }
  const { compareReports, formatComparison } = await import("../optimize/regress.ts");
  const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

  const comparison = compareReports(await read(baselineFile), await read(currentFile));
  process.stdout.write(
    args.flags.json
      ? `${JSON.stringify(comparison, null, 2)}\n`
      : `${formatComparison(comparison)}\n`,
  );
  // Deliberately always zero. A regression is reported so it can be judged, never
  // enforced: shipping the job matters more than the token bill.
  return 0;
}

const PERCEIVE_CORPUS = ["/modal-list", "/nav-shell", "/nested-cards", "/crowded"];

async function commandPerceive(args: ParsedArgs): Promise<number> {
  const [verb, target] = args.positional;
  const { perceiverByName } = await import("../core/perception/index.ts");
  const { LocalBrowser } = await import("../core/browser.ts");

  if (verb === "diff") {
    if (!target) {
      process.stderr.write("perceive diff needs a url\n");
      return 2;
    }
    const left = perceiverByName(flagString(args.flags, "a") ?? "reference");
    const right = perceiverByName(flagString(args.flags, "b") ?? "lean");
    const browser = await LocalBrowser.launch({ headless: true, perceiver: left });
    try {
      const tab = await browser.openTab(target);
      const page = browser.pageFor(tab);
      const a = await left.observe(page, { tabId: tab });
      const b = await right.observe(page, { tabId: tab });
      const names = (observation: typeof a) => new Set(observation.controls.map((c) => `${c.role}:${c.name}`));
      const onlyA = [...names(a)].filter((name) => !names(b).has(name));
      const onlyB = [...names(b)].filter((name) => !names(a).has(name));
      process.stdout.write(
        `${left.name}: ${a.controls.length} controls (of ${a.totalControls ?? a.controls.length})\n` +
          `${right.name}: ${b.controls.length} controls (of ${b.totalControls ?? b.controls.length})\n` +
          `only ${left.name} (${onlyA.length}): ${onlyA.slice(0, 20).join(", ")}${onlyA.length > 20 ? "…" : ""}\n` +
          `only ${right.name} (${onlyB.length}): ${onlyB.slice(0, 20).join(", ")}${onlyB.length > 20 ? "…" : ""}\n`,
      );
      if (b.perception?.dropped) {
        process.stdout.write(`dropped: ${JSON.stringify(b.perception.dropped)}\n`);
      }
    } finally {
      await browser.close();
    }
    return 0;
  }

  if (verb === "golden") {
    if (!target) {
      process.stderr.write("perceive golden needs an output directory\n");
      return 2;
    }
    const perceiver = perceiverByName(flagString(args.flags, "perceiver") ?? "lean");
    const { FixtureServer } = await import("../../tests/helpers/fixture-server.ts");
    const server = new FixtureServer();
    const origin = await server.start();
    const browser = await LocalBrowser.launch({ headless: true, perceiver });
    try {
      await mkdir(target, { recursive: true });
      for (const pathName of PERCEIVE_CORPUS) {
        const tab = await browser.openTab(`${origin}${pathName}`);
        const observation = await browser.observe(tab);
        const file = path.join(target, `${pathName.slice(1)}.json`);
        await writeFile(
          file,
          `${JSON.stringify(
            {
              perceiver: perceiver.name,
              path: pathName,
              totalControls: observation.totalControls,
              offered: observation.controls.length,
              dropped: observation.perception?.dropped ?? {},
              controls: observation.controls.map((c) => ({ ref: c.ref, role: c.role, name: c.name })),
            },
            null,
            2,
          )}\n`,
        );
        process.stderr.write(`wrote ${file}\n`);
        await browser.closeTab(tab);
      }
    } finally {
      await browser.close();
      await server.stop();
    }
    return 0;
  }

  process.stderr.write(`unknown perceive verb "${verb ?? ""}"\n`);
  return 2;
}

/**
 * What runs are on this machine.
 *
 * Needed because a goal id is generated, not chosen: without this the operator has to
 * list a directory by hand before they can ask anything about their own last run.
 */
async function commandGoals(args: ParsedArgs): Promise<number> {
  const { readdir, stat } = await import("node:fs/promises");
  const root = flagString(args.flags, "root") ?? coreRoot();
  const dir = path.join(root, "goals");

  const ids = await readdir(dir).catch(() => [] as string[]);
  if (ids.length === 0) {
    process.stderr.write(`no runs under ${dir}\n`);
    return 1;
  }

  const rows = await Promise.all(
    ids.map(async (goalId) => {
      const paths = goalPaths(root, goalId);
      const events = await Ledger.readFrom(root, goalId).catch(() => []);
      const at = await stat(paths.dir).then(
        (info) => info.mtime,
        () => new Date(0),
      );
      const payloadBytes = await stat(paths.payloadsFile).then(
        (info) => info.size,
        () => 0,
      );
      const goal = events.find((event) => event.type === "goal_started")?.intent;
      return { goalId, at, events: events.length, payloadBytes, goal };
    }),
  );

  rows.sort((left, right) => right.at.getTime() - left.at.getTime());
  const limit = Number(flagString(args.flags, "limit") ?? 20);
  for (const row of rows.slice(0, limit)) {
    const kb = Math.round(row.payloadBytes / 1024);
    process.stdout.write(
      `${row.goalId}  ${row.at.toISOString()}  ${String(row.events).padStart(4)} events  ` +
        `${String(kb).padStart(6)} KB sent${row.goal ? `  ${row.goal}` : ""}\n`,
    );
  }
  process.stdout.write(`\n${dir}\n`);
  return 0;
}

async function commandAcp(): Promise<number> {
  const { AcpServer, serveAcpStdio } = await import("../hosts/acp/server.ts");
  await serveAcpStdio(new AcpServer());
  return 0;
}

async function commandJob(args: ParsedArgs): Promise<number> {
  const root = flagString(args.flags, "root") ?? coreRoot();
  const json = Boolean(args.flags.json);
  const service = new JobService({ root });
  const verb = args.positional[0] ?? "help";
  const rest = args.positional.slice(1);

  const print = (value: unknown) => {
    if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else if (typeof value === "string") process.stdout.write(`${value}\n`);
    else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };

  try {
    if (verb === "create") {
      const objective = rest.join(" ").trim();
      const store = await service.create(objective, flagString(args.flags, "title"));
      const job = await store.readJob();
      print(json ? job : `${job.jobId}  ${job.title}  ${job.status}`);
      return 0;
    }
    if (verb === "show") {
      const store = await service.resolve(rest[0] ?? "");
      print(await store.summary());
      return 0;
    }
    if (verb === "title") {
      const job = await service.rename(rest[0] ?? "", rest.slice(1).join(" "));
      print(`${job.jobId}  ${job.title}`);
      return 0;
    }
    if (verb === "approve-plan") {
      const hash = flagString(args.flags, "hash");
      if (!hash) {
        process.stderr.write("approve-plan needs --hash\n");
        return 2;
      }
      const spec = await service.approvePlan(rest[0] ?? "", hash);
      print({ jobId: spec.jobId, hash: spec.hash, version: spec.version });
      return 0;
    }
    if (verb === "pause") {
      print(await service.pause(rest[0] ?? ""));
      return 0;
    }
    if (verb === "resume") {
      print(await service.resume(rest[0] ?? ""));
      return 0;
    }
    if (verb === "tick") {
      const due = Boolean(args.flags.due);
      if (due) {
        const results = await service.tickDue();
        print(results);
        if (results.some((result) => result.status === "busy")) return 3;
        if (results.some((result) => result.status === "runtime_unavailable")) {
          process.stderr.write(
            "runtime_unavailable: at least one due job has eligible work without a host " +
              "(experimental jobs prototype; not idle)\n",
          );
          return 4;
        }
        if (results.some((result) => result.status === "failed")) return 1;
        return 0;
      }
      const result = await service.tick({ jobId: rest[0] ?? "" });
      print(result);
      if (result.status === "busy") return 3;
      if (result.status === "runtime_unavailable") {
        process.stderr.write(
          "runtime_unavailable: eligible work exists but no model/browser host is attached " +
            "(experimental jobs prototype; not idle)\n",
        );
        return 4;
      }
      if (result.status === "failed") return 1;
      return 0;
    }
    if (verb === "run") {
      if (!args.flags["allow-ephemeral"]) {
        process.stderr.write(
          "job run is experimental and launches an ephemeral browser (no persistent Magpie profile).\n" +
            "Pass --allow-ephemeral to continue, or wait for Jobs V2 persistent execution.\n",
        );
        return 2;
      }
      process.stderr.write(
        "warning: ephemeral job run — login state and open tabs will not persist across processes\n",
      );
      let live;
      try {
        live = await createLiveModel({ model: flagString(args.flags, "model") });
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      const browser = await LocalBrowser.launch({ headless: !args.flags.headed });
      try {
        const results = await service.run({
          jobId: rest[0] ?? "",
          stream: live.stream,
          browser,
          maxTicks: Number(flagString(args.flags, "max-ticks") ?? 20),
        });
        print(results);
        return 0;
      } finally {
        await browser.close();
      }
    }
    process.stderr.write(`unknown job verb "${verb}"\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function commandJobs(args: ParsedArgs): Promise<number> {
  const root = flagString(args.flags, "root") ?? coreRoot();
  const service = new JobService({ root });
  const jobs = await service.list();
  if (jobs.length === 0) {
    process.stderr.write(`no jobs under ${path.join(root, "goals")}\n`);
    return 1;
  }
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    return 0;
  }
  for (const job of jobs) {
    process.stdout.write(
      `${job.jobId}  ${job.title}  ${job.display}  humans:${job.humanCount}` +
        (job.nextWakeAt ? `  wake ${job.nextWakeAt}` : "") +
        `\n`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "run":
      return commandRun(args);
    case "goals":
      return commandGoals(args);
    case "suite":
      return commandSuite(args);
    case "replay":
      return commandReplay(args);
    case "metrics":
      return commandMetrics(args);
    case "compare":
      return commandCompare(args);
    case "perceive":
      return commandPerceive(args);
    case "acp":
      return commandAcp();
    case "jobs":
      return commandJobs(args);
    case "job":
      return commandJob(args);
    case "durable":
      return (await import("../durable/adapters/cli.ts")).commandDurable(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${HELP}`);
      return 2;
  }
}

export { HELP };
