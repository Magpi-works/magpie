import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../../src/core/ledger.ts";
import { goalPaths } from "../../src/core/paths.ts";
import { main, parseArgs, parseCriterion, splitFlagList } from "../../src/cli/main.ts";
import { SMOKE_TASK_IDS, selectTasks } from "../../src/suite/tags.ts";
import { SUITE_TASKS } from "../../src/suite/tasks.ts";

describe("CLI argument parsing", () => {
  it("separates the command, positionals, and flags", () => {
    const args = parseArgs(["run", "apply for the role", "--url", "http://x/apply", "--headed"]);
    assert.equal(args.command, "run");
    assert.deepEqual(args.positional, ["apply for the role"]);
    assert.equal(args.flags.url, "http://x/apply");
    assert.equal(args.flags.headed, true);
  });

  it("collects a repeated flag instead of dropping the earlier one", () => {
    const args = parseArgs([
      "run",
      "goal",
      "--criterion",
      "text_visible:Thanks",
      "--criterion",
      "url_includes:/done",
    ]);
    assert.equal(args.flags.criterion, "text_visible:Thanks,url_includes:/done");
  });

  it("keeps repeated JSON criteria whole when splitting the list", () => {
    const args = parseArgs([
      "run",
      "goal",
      "--criterion",
      '{"kind":"url_includes","text":"/pay"}',
      "--criterion",
      "text_visible:Thanks",
      "--criterion",
      '{"kind":"all","of":[{"kind":"text_visible","text":"a, b \\"c\\" }"},{"kind":"no_console_error"}]}',
    ]);
    const entries = splitFlagList(String(args.flags.criterion));
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(parseCriterion), [
      { kind: "url_includes", text: "/pay" },
      { kind: "text_visible", text: "Thanks" },
      { kind: "all", of: [{ kind: "text_visible", text: 'a, b "c" }' }, { kind: "no_console_error" }] },
    ]);
  });

  it("treats a trailing flag as a boolean", () => {
    assert.equal(parseArgs(["suite", "--target", "mock", "--all"]).flags.all, true);
  });

  it("defaults to help with no arguments", () => {
    assert.equal(parseArgs([]).command, "help");
  });
});

describe("finding a run to ask about", () => {
  it("lists goals newest first, with what they sent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bsa-goals-"));
    try {
      // Two runs, the second later, so ordering is observable rather than incidental.
      const older = await Ledger.open(root, "g_older");
      await older.append({ type: "goal_started", intent: "the first thing" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = await Ledger.open(root, "g_newer");
      await newer.append({ type: "goal_started", intent: "the second thing" });
      await writeFile(goalPaths(root, "g_newer").payloadsFile, `${"x".repeat(2048)}\n`, "utf8");

      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        assert.equal(await main(["goals", "--root", root]), 0);
      } finally {
        process.stdout.write = write;
      }

      const listed = lines.join("").trim().split("\n");
      assert.match(listed[0] ?? "", /g_newer/, "newest first, because that is the one you ran");
      assert.match(listed[0] ?? "", /the second thing/);
      assert.match(listed[0] ?? "", /2 KB sent/);
      assert.match(listed[1] ?? "", /g_older/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("says where it looked when there is nothing there", async () => {
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(await main(["goals", "--root", "/tmp/definitely-not-here"]), 1);
    } finally {
      process.stderr.write = write;
    }
    assert.match(said.join(""), /no runs under \/tmp\/definitely-not-here\/goals/);
  });
});

describe("criterion shorthand", () => {
  it("treats bare text as visible text", () => {
    assert.deepEqual(parseCriterion("Application submitted"), {
      kind: "text_visible",
      text: "Application submitted",
    });
  });

  it("understands kind:value", () => {
    assert.deepEqual(parseCriterion("url_includes:/jobs"), {
      kind: "url_includes",
      text: "/jobs",
    });
    assert.deepEqual(parseCriterion("text_absent:error"), {
      kind: "text_absent",
      text: "error",
    });
  });

  it("understands a named field for value predicates", () => {
    assert.deepEqual(parseCriterion("value_includes:Email=ada@example.com"), {
      kind: "value_includes",
      name: "Email",
      text: "ada@example.com",
    });
  });

  it("understands control predicates", () => {
    assert.deepEqual(parseCriterion("control_exists:Submit application"), {
      kind: "control_exists",
      name: "Submit application",
    });
  });

  it("accepts raw JSON for the full language", () => {
    assert.deepEqual(
      parseCriterion('{"kind":"all","of":[{"kind":"text_visible","text":"a"}]}'),
      { kind: "all", of: [{ kind: "text_visible", text: "a" }] },
    );
  });

  it("rejects an unusable criterion loudly", () => {
    assert.throws(() => parseCriterion('{"kind":"not_a_predicate"}'));
  });
});

describe("task selection", () => {
  it("selects the smoke subset, and it is genuinely smaller", () => {
    const smoke = selectTasks(SUITE_TASKS, { smoke: true });
    assert.equal(smoke.length, SMOKE_TASK_IDS.length);
    assert.ok(smoke.length < SUITE_TASKS.length / 2, "a live run should be cheap");
  });

  it("covers distinct failure modes in the smoke subset", () => {
    const tags = new Set(selectTasks(SUITE_TASKS, { smoke: true }).flatMap((task) => task.tags));
    for (const required of ["form", "commit", "widget", "abandon", "validation", "errors"]) {
      assert.ok(tags.has(required), `smoke subset is missing "${required}"`);
    }
  });

  it("filters by tag and by id", () => {
    assert.ok(selectTasks(SUITE_TASKS, { tags: ["combobox"] }).every((task) => task.tags.includes("combobox")));
    assert.deepEqual(
      selectTasks(SUITE_TASKS, { only: ["apply-submit"] }).map((task) => task.id),
      ["apply-submit"],
    );
  });

  it("returns everything by default", () => {
    assert.equal(
      selectTasks(SUITE_TASKS).length,
      SUITE_TASKS.filter((task) => !task.perceiver || task.perceiver === "lean").length,
      "tasks that name another perceiver stay out of the default set",
    );
    assert.ok(
      selectTasks(SUITE_TASKS, { perceiver: "lean" }).some((task) => task.id === "followers-under-dialog"),
      "the lean-only task is selected when that perceiver is running",
    );
  });

  it("names only tasks that exist", () => {
    const ids = new Set(SUITE_TASKS.map((task) => task.id));
    for (const id of SMOKE_TASK_IDS) {
      assert.ok(ids.has(id), `smoke list names a task that does not exist: ${id}`);
    }
  });
});
