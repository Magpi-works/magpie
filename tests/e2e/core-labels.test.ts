import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { LocalBrowser } from "../../src/core/browser.ts";
import { FixtureServer } from "../helpers/fixture-server.ts";

describe("control names follow the field's label", () => {
  const server = new FixtureServer();
  let origin = "";
  let browser: LocalBrowser;

  before(async () => {
    origin = await server.start();
    browser = await LocalBrowser.launch({ headless: true });
  });

  after(async () => {
    await browser.close();
    await server.stop();
  });

  it("uses <label for>, aria-labelledby, and wrapping labels before the placeholder", async () => {
    const tab = await browser.openTab(`${origin}/labels`);
    const names = (await browser.observe(tab)).controls.map((control) => control.name);
    assert.deepEqual(names, ["Who are you billing?", "Amount", "Notes", "Only a placeholder"]);
  });
});
