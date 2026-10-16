import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Ledger, MAX_PAYLOAD_CHARS } from "../../src/core/ledger.ts";
import { REDACTION_MASK, redactDeep, redactString } from "../../src/core/redact.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "core-ledger-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AGENT-00-T02 evidence ledger", () => {
  it("round-trips an action trace with intent, before, after, and outcome", async () => {
    const ledger = await Ledger.open(root, "goal_1");
    await ledger.append({
      type: "action",
      entityId: "ent_1",
      intent: "start the application",
      before: { url: "https://example.test/apply", title: "Apply", controls: 4 },
      action: { kind: "click", ref: "e4", reversibility: "committing", reversibilityReason: "submits a form" },
      after: { url: "https://example.test/done", title: "Done", changes: ["added text Thanks"] },
      outcome: { ok: true, detail: "confirmation visible" },
    });

    const events = await ledger.read();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "action");
    assert.equal(event.goalId, "goal_1");
    assert.equal(event.entityId, "ent_1");
    assert.equal(event.intent, "start the application");
    assert.equal(event.action?.reversibility, "committing");
    assert.equal(event.after?.url, "https://example.test/done");
    assert.equal(event.outcome?.ok, true);
    assert.ok(event.id && event.ts);
  });

  it("is readable cold, with no ledger instance", async () => {
    const ledger = await Ledger.open(root, "goal_2");
    await ledger.append({ type: "goal_started", intent: "apply to roles" });
    await ledger.append({ type: "note", intent: "second" });

    const events = await Ledger.readFrom(root, "goal_2");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "goal_started");
  });

  it("redacts secrets on write so traces are safe to keep", async () => {
    const ledger = await Ledger.open(root, "goal_3");
    await ledger.append({
      type: "probe",
      intent: "read the session token sk-abcdefghijklmnopqrstuvwxyz012345",
      payload: {
        password: "hunter2",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        note: "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K",
        safe: "Ada Lovelace",
      },
    });

    const raw = JSON.stringify(await ledger.read());
    assert.equal(raw.includes("hunter2"), false, "password value must not reach disk");
    assert.equal(raw.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
    assert.equal(raw.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
    assert.ok(raw.includes("Ada Lovelace"), "benign content must survive");
    assert.ok(raw.includes(REDACTION_MASK));
  });

  it("redacts the action target and input but keeps the gate's verdict", async () => {
    const ledger = await Ledger.open(root, "goal_target");
    await ledger.append({
      type: "action",
      action: {
        kind: "type",
        ref: "e7",
        target: { role: "textbox", name: "API token sk-abcdefghijklmnopqrstuvwxyz012345", tag: "input" },
        input: "Bearer abcdefghijklmnopqrstuvwxyz",
        authorization: "none",
        authorizationReason: "no outbound or destructive match (none)",
      },
    });

    const [event] = await ledger.read();
    assert.equal(event?.action?.target?.role, "textbox");
    assert.equal(event?.action?.target?.name.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
    assert.equal(event?.action?.input?.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(event?.action?.authorization, "none");
    assert.equal(event?.action?.authorizationReason, "no outbound or destructive match (none)");
  });

  it("caps oversized payloads instead of writing them whole", async () => {
    const ledger = await Ledger.open(root, "goal_4");
    await ledger.append({ type: "probe", payload: { blob: "x".repeat(MAX_PAYLOAD_CHARS * 3) } });
    const [event] = await ledger.read();
    assert.equal(event?.payload?.truncated, true);
    assert.ok(JSON.stringify(event?.payload).length < MAX_PAYLOAD_CHARS * 2);
  });

  it("keeps artifacts as file references, not inline bytes", async () => {
    const ledger = await Ledger.open(root, "goal_5");
    await stat(ledger.artifactsDir);
    const screenshot = path.join(ledger.artifactsDir, "obs_1.png");
    await ledger.append({ type: "failure", artifacts: [screenshot] });
    const [event] = await ledger.read();
    assert.deepEqual(event?.artifacts, [screenshot]);
    assert.equal(JSON.stringify(event).includes("base64"), false);
  });
});

describe("AGENT-00-T02 redaction", () => {
  it("masks credential shapes and leaves prose alone", () => {
    assert.equal(redactString("token=abcdef1234"), `token=${REDACTION_MASK}`);
    assert.ok(redactString("ghp_abcdefghijklmnopqrstuvwxyz01").includes(REDACTION_MASK));
    assert.equal(redactString("Apply to the Staff Engineer role"), "Apply to the Staff Engineer role");
  });

  it("masks sensitive keys wholesale, whatever the value looks like", () => {
    const out = redactDeep({ cookie: "a=1", nested: { apiKey: "short" }, keep: "plain text" });
    assert.equal(out.cookie, REDACTION_MASK);
    assert.equal((out.nested as { apiKey: string }).apiKey, REDACTION_MASK);
    assert.equal(out.keep, "plain text");
  });
});
