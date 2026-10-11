import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { act } from "../../src/core/act.ts";
import { LocalBrowser } from "../../src/core/browser.ts";
import { Ledger } from "../../src/core/ledger.ts";
import { REDACTION_MASK } from "../../src/core/redact.ts";
import { FixtureServer } from "../helpers/fixture-server.ts";

const server = new FixtureServer();
let origin = "";
let browser: LocalBrowser;
let root = "";

before(async () => {
  origin = await server.start();
  browser = await LocalBrowser.launch({ headless: true });
  root = await mkdtemp(path.join(os.tmpdir(), "act-target-"));
});

after(async () => {
  await browser?.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function refFor(tab: string, role: string, name: string): Promise<string> {
  const observation = await browser.observe(tab);
  const control = observation.controls.find(
    (candidate) => candidate.role === role && candidate.name.includes(name),
  );
  assert.ok(control, `no ${role} named ${name}`);
  return control.ref;
}

describe("ledger records what an action was performed on", () => {
  it("keeps role, name, tag, and the input for type, select, and click", async () => {
    const ledger = await Ledger.open(root, "goal_apply");
    const tab = await browser.openTab(`${origin}/apply`);

    await act(
      browser,
      { kind: "type", tabId: tab, ref: await refFor(tab, "text", "Full name"), text: "Ada Lovelace" },
      { ledger },
    );
    await act(
      browser,
      { kind: "select", tabId: tab, ref: await refFor(tab, "select-one", "Location"), value: "nyc" },
      { ledger },
    );
    await act(
      browser,
      { kind: "click", tabId: tab, ref: await refFor(tab, "submit", "Submit application") },
      { ledger },
    );

    const [typed, selected, clicked] = await ledger.read();

    assert.equal(typed?.action?.target?.role, "text");
    assert.match(typed?.action?.target?.name ?? "", /Full name/);
    assert.equal(typed?.action?.target?.tag, "input");
    assert.equal(typed?.action?.input, "Ada Lovelace");

    assert.equal(selected?.action?.target?.role, "select-one");
    assert.match(selected?.action?.target?.name ?? "", /Location/);
    assert.equal(selected?.action?.input, "nyc");

    assert.equal(clicked?.action?.target?.role, "submit");
    assert.match(clicked?.action?.target?.name ?? "", /Submit application/);
    assert.equal(clicked?.action?.input, undefined, "a click has no input");
  });

  it("masks what was typed into a password field", async () => {
    const ledger = await Ledger.open(root, "goal_login");
    const tab = await browser.openTab(`${origin}/login`);

    await act(
      browser,
      { kind: "type", tabId: tab, ref: await refFor(tab, "password", "Password"), text: "hunter2" },
      { ledger },
    );

    const [event] = await ledger.read();
    assert.equal(event?.action?.target?.inputType, "password");
    assert.equal(event?.action?.input, REDACTION_MASK);
    assert.equal(JSON.stringify(event).includes("hunter2"), false, "password must not reach disk");
  });

  it("records no target for an action without a ref", async () => {
    const ledger = await Ledger.open(root, "goal_nav");
    const tab = await browser.openTab(`${origin}/apply`);

    await act(browser, { kind: "navigate", tabId: tab, url: `${origin}/jobs` }, { ledger });

    const [event] = await ledger.read();
    assert.equal(event?.action?.kind, "navigate");
    assert.equal(event?.action?.target, undefined);
    assert.equal(event?.action?.input, undefined);
  });
});
