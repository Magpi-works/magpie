import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserPort } from "../../src/core/browser.ts";
import type { Observation } from "../../src/core/types.ts";
import { TOOL_ACT } from "../../src/runtime/names.ts";
import { buildTools, fillArgs } from "../../src/runtime/tools.ts";
import { nullEvidence } from "../../src/runtime/evidence.ts";

function fieldBrowser(filled: string[]): BrowserPort {
  let value = "";
  const obs = (): Observation => ({
    id: "obs_1",
    tabId: "tab_1",
    url: "https://example.test/form",
    title: "Form",
    controls: [{ ref: "e1", role: "text", name: "Name", tag: "input", inputType: "text", value } as Observation["controls"][number]],
    dialogs: [],
    errors: [],
    consoleErrors: [],
    failedRequests: [],
    changes: [],
    capturedAt: new Date().toISOString(),
  });
  return {
    observe: async () => obs(),
    facts: async () => ({ url: obs().url, title: "Form", text: "", observation: obs() }),
    fill: async (_tab: string, _ref: string, text: string) => {
      filled.push(text);
      value = text;
    },
    waitFor: async () => undefined,
    lastObservation: () => obs(),
  } as unknown as BrowserPort;
}

function act(browser: BrowserPort) {
  const tools = buildTools({ browser, tabId: "tab_1", evidence: nullEvidence() });
  return tools.find((tool) => (tool as { name: string }).name === TOOL_ACT) as {
    execute: (id: string, params: unknown) => Promise<{ details: unknown }>;
  };
}

describe("act fill arguments", () => {
  it("types the value when a model puts type's text in value", async () => {
    const filled: string[] = [];
    await act(fieldBrowser(filled)).execute("t1", { kind: "type", ref: "e1", value: "Acme QA" });
    assert.deepEqual(filled, ["Acme QA"]);
  });

  it("refuses a type with no text instead of typing an empty string that verifies", async () => {
    const filled: string[] = [];
    const result = await act(fieldBrowser(filled)).execute("t1", { kind: "type", ref: "e1" });
    assert.deepEqual(filled, []);
    assert.match((result.details as { error?: string }).error ?? "", /type needs "text"/);
  });

  it("keeps an explicit empty text (clearing a field) and maps select text to value", () => {
    assert.deepEqual(fillArgs({ kind: "type", ref: "e1", text: "" }), { kind: "type", ref: "e1", text: "" });
    assert.deepEqual(fillArgs({ kind: "select", ref: "e2", text: "Large" }), { kind: "select", ref: "e2", text: "Large", value: "Large" });
    assert.match(String(fillArgs({ kind: "select", ref: "e2" })), /select needs "value"/);
  });
});

describe("refusal notes", () => {
  it("tells the model a commit's expect is a precondition and how to assert the outcome instead", async () => {
    const { refusalNote } = await import("../../src/runtime/tools.ts");
    assert.match(refusalNote("precondition_failed"), /checked before acting[\s\S]*act again without expect, then use check/);
    assert.match(refusalNote("policy_forbids_commit"), /Fix the precondition or take another route/);
  });
});
