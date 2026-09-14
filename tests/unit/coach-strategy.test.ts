import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskCard } from "../../src/runtime/card.ts";
import {
  STRATEGY_JSON_EXAMPLE,
  STRATEGY_RENDER_MAX_CHARS,
  STRATEGY_STEP_ITEMS,
  assertStrategyArtifact,
  parseStrategyArtifact,
  parseJsonValue,
  renderStrategyArtifact,
  StrategyArtifactError,
  strategyFromFacts,
} from "../../src/runtime/coach/strategy.ts";

const GUIDELINE = {
  schemaVersion: 1,
  summary: "Acquire via venue tagged posts, then peek profiles.",
  loop: [
    "Search local venues / events, not generic party goers",
    "Open the venue's tagged posts",
    "Deduplicate handles before opening anyone",
    "Peek each profile in a side tab; keep the tagged list",
  ],
  qualify: ["Apply the goal's popularity and nightlife criteria; do not loosen them"],
  exceptions: ["Skip private tagged grids"],
  record: ["candidate_accepted or candidate_rejected after each peek"],
  stop: ["After N accepts, or after 3 venues with few new handles"],
  doNot: [
    "Navigate to a profile and Back; you lose the tagged list",
    "Generic Instagram people-search as the primary seed",
  ],
  confidence: "high",
  falsify: "Tagged posts are empty or private on the next two venues",
  assumptions: ["Tagged authors are a nightlife proxy"],
};

describe("AGENT-16-T02 strategy artifact", () => {
  it("schema example escalates JS shells instead of teaching cheapest-fetch", () => {
    const artifact = assertStrategyArtifact(parseJsonValue(STRATEGY_JSON_EXAMPLE));
    assert.match(artifact.summary, /painted page|wandering/i);
    assert.match(artifact.exceptions.join(" "), /JS shell|observe/i);
    assert.match(artifact.doNot.join(" "), /curl|coder fetch/i);
    assert.match(artifact.qualify.join(" "), /unknown required fields are not done/i);
  });

  it("accepts a venue → tagged → peek guideline", () => {
    const artifact = assertStrategyArtifact(GUIDELINE);
    assert.equal(artifact.schemaVersion, 1);
    assert.match(artifact.loop[1]!, /tagged posts/i);
    assert.match(artifact.loop[3]!, /Peek/);
    const rendered = renderStrategyArtifact(artifact);
    assert.ok(rendered.length <= STRATEGY_RENDER_MAX_CHARS);
    assert.match(rendered, /untrusted/i);
    assert.match(rendered, /does not authorize/);
  });

  it("rejects criteria rewrites and DM without approval", () => {
    assert.throws(
      () =>
        assertStrategyArtifact({
          ...GUIDELINE,
          qualify: ["Lower the follower threshold to 50"],
        }),
      (error: unknown) => error instanceof StrategyArtifactError && error.code === "spec_rewrite",
    );
    assert.throws(
      () =>
        assertStrategyArtifact({
          ...GUIDELINE,
          loop: ["DM them without approval"],
        }),
      (error: unknown) => error instanceof StrategyArtifactError && error.code === "spec_rewrite",
    );
    assert.throws(
      () => assertStrategyArtifact({ ...GUIDELINE, criteria: "200 followers" }),
      (error: unknown) => error instanceof StrategyArtifactError && error.code === "spec_rewrite",
    );
  });

  it("accepts assumptions that mention a follower threshold without rewriting it", () => {
    const artifact = assertStrategyArtifact({
      ...GUIDELINE,
      assumptions: ["no explicit follower threshold", "do not change the follower threshold"],
    });
    assert.match(artifact.assumptions.join(" "), /follower threshold/);
  });

  it("drops unknown keys and truncates over-long lists", () => {
    const parsed = parseStrategyArtifact({
      schemaVersion: 1,
      summary: "ok",
      loop: Array.from({ length: 20 }, (_, i) => `step ${i}`),
      extra: { nested: true },
      playwright: "page.click()",
      confidence: "medium",
      falsify: "x",
    });
    assert.ok(parsed);
    assert.equal(parsed.loop.length, STRATEGY_STEP_ITEMS);
    assert.equal("extra" in parsed, false);
    assert.equal("playwright" in parsed, false);
  });

  it("parse returns undefined for empty or non-object input; assert throws", () => {
    assert.equal(parseStrategyArtifact("{}"), undefined);
    assert.equal(parseStrategyArtifact("not json"), undefined);
    assert.equal(parseStrategyArtifact([]), undefined);
    assert.throws(() => assertStrategyArtifact("not json"), StrategyArtifactError);
  });

  it("rejects invented nested strategy JSON with a schema hint, not a silent empty object", () => {
    const invented = {
      schemaVersion: 1,
      artifact: "coach_strategy_review",
      strategy: {
        route_affordances_to_keep: ["Peek profile URLs directly"],
      },
      do_not: { skipApproval: true },
    };
    assert.equal(parseStrategyArtifact(invented), undefined);
    assert.throws(
      () => assertStrategyArtifact(invented),
      (error: unknown) =>
        error instanceof StrategyArtifactError &&
        error.code === "invalid" &&
        /dropping unknown keys/i.test(error.message) &&
        /summary/.test(error.message) &&
        /loop/.test(error.message),
    );
    const fenced = "```json\n" + JSON.stringify(invented, null, 2) + "\n```";
    assert.throws(
      () => assertStrategyArtifact(fenced),
      (error: unknown) => error instanceof StrategyArtifactError && /dropping unknown keys/i.test(error.message),
    );
  });

  it("renders onto the task card under the D29 budget", () => {
    const artifact = assertStrategyArtifact(GUIDELINE);
    const card = buildTaskCard({
      objective: "Find people",
      criteria: [],
      knownFacts: { strategyArtifact: artifact, operator: "ada" },
    });
    assert.match(card, /STRATEGY/);
    assert.match(card, /untrusted/);
    assert.match(card, /operator: "ada"/);
    assert.doesNotMatch(card, /strategyArtifact/);
    assert.equal(strategyFromFacts({ strategyArtifact: artifact })?.confidence, "high");
  });
});
