/**
 * The single action choke point.
 *
 * Every mutation goes through `act`, and `act` always evaluates a postcondition.
 * Verification is therefore skipped by construction, not by discipline: there is no
 * code path that performs an action without checking whether it did anything.
 */

import { visibleText } from "./perceive.ts";
import { uniqueChooserHit } from "./chooser.ts";
import { describeCheck, describePredicate, evaluatePredicate, optionalPredicate, verify } from "./predicates.ts";
import { describeVerification, settleVerification, DEFAULT_SETTLE_MS } from "./settle.ts";
import type { BrowserPort } from "./browser.ts";
import type { LedgerSink, LedgerTarget } from "./ledger.ts";
import { REDACTION_MASK } from "./redact.ts";
import { classifyAction, type Classification } from "./reversibility.ts";
import { urlMatchesIntent } from "./url-intent.ts";
import {
  CoreError,
  type ActionRequest,
  type ActionResult,
  type Control,
  type FailureBundle,
  type Observation,
  type PageFacts,
  type Predicate,
  type Verification,
} from "./types.ts";

export type Classifier = (request: ActionRequest, control: Control | undefined) => Classification;

export interface ActOptions {
  classify?: Classifier;
  /** Directory for on-failure screenshots. Omitted means no screenshot. */
  screenshotDir?: string;
  timeoutMs?: number;
  /** When set, every action is traced: intent, before, action, after, outcome. */
  ledger?: LedgerSink;
  entityId?: string;
  /**
   * How long a failing postcondition is given to become true before it is believed.
   * Zero means judge the first look, which is only useful for proving the race exists.
   */
  settleMs?: number;
}

export const MAX_RECOVERY_CHARS = 600;

export async function act(
  browser: BrowserPort,
  request: ActionRequest,
  options: ActOptions = {},
): Promise<ActionResult> {
  const classify = options.classify ?? classifyAction;
  const timeout = options.timeoutMs ?? 10_000;

  // Wait and scroll judge "did the page change", so the before-facts have to include
  // the body text an already-true `text_visible` would match. Observe is enough for
  // every other kind.
  const beforeFacts =
    request.kind === "wait" || request.kind === "scroll"
      ? await browser.facts(request.tabId)
      : undefined;
  const before = beforeFacts?.observation ?? (await browser.observe(request.tabId));
  const control = request.ref
    ? before.controls.find((candidate) => candidate.ref === request.ref)
    : undefined;

  if (request.ref && !control) {
    throw new CoreError("missing_ref", `No control with ref ${request.ref}`, {
      ref: request.ref,
      available: before.controls.map((candidate) => candidate.ref),
    });
  }

  const classification = classify(request, control);

  // Perform, through the port's primitives. Everything that decides *meaning* stays
  // here; the port only knows how to poke a browser.
  switch (request.kind) {
    case "navigate": {
      if (!request.url) throw new CoreError("bad_request", "navigate needs a url");
      await browser.navigate(request.tabId, request.url, timeout);
      break;
    }
    case "click": {
      await browser.click(request.tabId, request.ref!, timeout);
      break;
    }
    case "type": {
      await browser.fill(request.tabId, request.ref!, request.text ?? "", timeout);
      const typed = request.text ?? "";
      const opened = await browser.observe(request.tabId);
      const hit = uniqueChooserHit(typed, before.controls, opened.controls);
      if (hit && hit.ref !== request.ref) {
        await browser.click(request.tabId, hit.ref, timeout);
      }
      break;
    }
    case "select": {
      await browser.selectOption(request.tabId, request.ref!, request.value ?? "", timeout);
      break;
    }
    case "scroll": {
      await browser.scroll(request.tabId, request.ref, request.dy, timeout);
      break;
    }
    case "upload": {
      await browser.setInputFiles(request.tabId, request.ref!, request.files ?? [], timeout);
      break;
    }
    case "wait": {
      const spec = request.wait ?? { kind: "timeout", timeoutMs: 500 };
      await browser.waitFor(request.tabId, spec, Math.min(spec.timeoutMs ?? timeout, 15_000));
      break;
    }
    case "check": {
      // No mutation; the postcondition below is the entire point of the call.
      break;
    }
    case "restore": {
      throw new CoreError("bad_request", "restore is a gate action; call guardedAct");
    }
  }

  const refused = request.kind === "navigate"
    ? await refuseDataDocument(browser, request, before, timeout)
    : undefined;
  const { facts, verification } = refused
    ?? await settleVerification(
      browser,
      (settled) => postcondition(request, before, settled, control, beforeFacts),
      {
        tabId: request.tabId,
        since: before,
        budgetMs: options.settleMs ?? DEFAULT_SETTLE_MS,
        until: request.kind === "navigate" ? "stable" : "pass",
      },
    );

  const result: ActionResult = {
    ok: verification.status === "passed",
    kind: request.kind,
    reversibility: classification.reversibility,
    reversibilityReason: classification.reason,
    authorization: classification.authorization,
    authorizationReason: classification.authorizationReason,
    observation: facts.observation,
    verification,
  };

  if (!result.ok) {
    result.failure = await buildFailure(browser, request, facts, verification, options);
  }

  // One event per action, carrying the whole story including the failure bundle, so a
  // trace is diagnosable without the model transcript.
  await options.ledger?.append({
    type: result.ok ? "action" : "failure",
    entityId: options.entityId,
    intent: request.intent ?? `${request.kind} ${request.ref ?? request.url ?? ""}`.trim(),
    before: {
      url: before.url,
      title: before.title,
      controls: before.controls.length,
      ...(before.truncated ? { truncated: true as const } : {}),
    },
    action: {
      kind: request.kind,
      ref: request.ref,
      target: control ? ledgerTarget(control) : undefined,
      input: ledgerInput(request, control),
      url: request.url,
      reversibility: classification.reversibility,
      reversibilityReason: classification.reason,
      authorization: classification.authorization,
      authorizationReason: classification.authorizationReason,
    },
    after: {
      url: facts.observation.url,
      title: facts.observation.title,
      changes: facts.observation.changes,
    },
    outcome: {
      ok: result.ok,
      detail: describeVerification(verification),
    },
    payload: result.failure ? { failure: result.failure } : undefined,
    artifacts: result.failure?.screenshot ? [result.failure.screenshot] : undefined,
  });

  return result;
}

function ledgerTarget(control: Control): LedgerTarget {
  return {
    role: control.role,
    name: control.name,
    tag: control.tag,
    ...(control.href ? { href: control.href } : {}),
    ...(control.inputType ? { inputType: control.inputType } : {}),
  };
}

function ledgerInput(request: ActionRequest, control: Control | undefined): string | undefined {
  const input = request.kind === "type"
    ? request.text
    : request.kind === "select"
      ? request.value
      : undefined;
  if (input === undefined) return undefined;
  return control?.inputType === "password" ? REDACTION_MASK : input;
}

/**
 * What "it worked" means.
 *
 * Fill is special: the harness already knows how to check a field (read the value back).
 * A model `text_visible` of the whole blob used to replace that check and fail a fill
 * that stuck. Type and select always read back; only a value_* expect may AND with it.
 * Other kinds of expect still replace the default for clicks and navigation.
 */
function postcondition(
  request: ActionRequest,
  before: Observation,
  facts: PageFacts,
  control: Control | undefined,
  beforeFacts?: PageFacts,
): Verification {
  const expect = optionalPredicate(request.expect);
  const judged: ActionRequest = expect ? { ...request, expect } : { ...request, expect: undefined };

  if (judged.kind === "wait" || judged.kind === "scroll") {
    return waitScrollPostcondition(judged, before, facts, beforeFacts);
  }
  if (judged.kind === "type" || judged.kind === "select") {
    const readBack = defaultPostcondition(judged, before, facts, control);
    const extra = fillValueExpect(expect);
    if (!extra) return readBack;
    const anded = verify([extra], facts);
    return {
      status: readBack.status === "passed" && anded.status === "passed" ? "passed" : "failed",
      checks: [...readBack.checks, ...anded.checks],
    };
  }
  if (expect) return verify([expect], facts);
  return defaultPostcondition(judged, before, facts, control);
}

/**
 * Wait and scroll mean "the page moved", not "a string that was already on screen is
 * still there".
 *
 * An `expect` that was false before and true after is still success — that is waiting
 * until something appears. The same expect already true before the action is not
 * "loaded more".
 */
function waitScrollPostcondition(
  request: ActionRequest,
  before: Observation,
  facts: PageFacts,
  beforeFacts: PageFacts | undefined,
): Verification {
  const changed = snapshotChanged(before, facts.observation);
  const delta = single(
    changed,
    "pageDelta",
    changed
      ? facts.observation.changes.join("; ") || facts.observation.dialogs.join("; ") || "snapshot changed"
      : `noop ${request.kind}: the page did not change`,
  );
  const expect = request.expect;
  if (!expect) return delta;

  const afterCheck = evaluatePredicate(expect, facts);
  if (!afterCheck.passed) return verify([expect], facts);

  const already = beforeFacts ? evaluatePredicate(expect, beforeFacts).passed : false;
  if (!already) return verify([expect], facts);

  return single(
    changed,
    "pageDelta",
    changed
      ? facts.observation.changes.join("; ") || "snapshot changed"
      : `${describePredicate(expect)} already held before the ${request.kind}; page did not change`,
  );
}

function snapshotChanged(before: Observation, after: Observation): boolean {
  return (
    after.changes.length > 0 ||
    before.url !== after.url ||
    before.title !== after.title ||
    before.dialogs.join("\n") !== after.dialogs.join("\n") ||
    before.errors.join("\n") !== after.errors.join("\n")
  );
}

function fillValueExpect(expect: Predicate | undefined): Predicate | undefined {
  if (!expect) return undefined;
  if (expect.kind === "value_equals" || expect.kind === "value_includes") return expect;
  return undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fillAccepted(wanted: string, actual: string): boolean {
  if (wanted === "") return true;
  const want = collapse(wanted);
  const got = collapse(actual);
  if (got === want || got.toLowerCase().includes(want.toLowerCase())) return true;
  if (want.length > 200) {
    const ratio = got.length / Math.max(want.length, 1);
    if (ratio >= 0.9 && ratio <= 1.1 && got.toLowerCase().startsWith(want.slice(0, 40).toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * What "it worked" means when the caller gave no explicit expectation.
 * A click that changes nothing is a failure — the single most common way a browser
 * agent fools itself.
 */
function defaultPostcondition(
  request: ActionRequest,
  before: Observation,
  facts: PageFacts,
  control: Control | undefined,
): Verification {
  const after = facts.observation;
  switch (request.kind) {
    case "click": {
      const changed = snapshotChanged(before, after);
      return single(
        changed,
        "pageDelta",
        changed
          ? after.changes.join("; ") || after.url
          : "noop click: nothing on the page changed",
      );
    }
    case "type":
    case "select": {
      const wanted = request.kind === "type" ? (request.text ?? "") : (request.value ?? "");
      const updated = after.controls.find((candidate) => candidate.ref === request.ref);
      if (control?.inputType === "password") {
        return single(true, "readBack", "password redacted");
      }
      const actual = updated?.value ?? "";
      const passed = fillAccepted(wanted, actual);
      return single(passed, "readBack", passed ? actual : `expected "${wanted}", read "${actual}"`);
    }
    case "navigate": {
      const target = request.url ?? "";
      const passed = urlMatchesIntent(after.url, target);
      return single(passed, "urlIntent", passed ? after.url : `expected ${target}, got ${after.url}`);
    }
    case "upload": {
      const updated = after.controls.find((candidate) => candidate.ref === request.ref);
      const expected = (request.files ?? []).map((file) => file.split("/").pop() ?? file);
      const actual = updated?.value ?? "";
      const passed = expected.length === 0 || expected.some((name) => actual.includes(name));
      return single(passed, "fileAttached", passed ? actual : `expected ${expected.join(",")}, read "${actual}"`);
    }
    default:
      return single(true, request.kind, `${request.kind} completed`);
  }
}

function single(passed: boolean, name: string, detail: string): Verification {
  return { status: passed ? "passed" : "failed", checks: [{ passed, detail, predicate: name }] };
}

/**
 * A JSON (or XML, or bytes) response is a successful fetch and a failed place to be.
 * Restore the page we came from so the tab is still a page.
 */
async function refuseDataDocument(
  browser: BrowserPort,
  request: ActionRequest,
  before: Observation,
  timeout: number,
): Promise<{ facts: PageFacts; verification: Verification } | undefined> {
  const landed = await browser.facts(request.tabId);
  if (landed.document?.kind !== "data") return undefined;
  const doc = landed.document;
  const detail =
    `not a page (${doc.contentType}, ${doc.bytes} bytes). Restored the previous page.`;
  try {
    await browser.navigate(request.tabId, before.url, timeout);
  } catch {
    // The refusal still holds if restore fails; the recovery note says why.
  }
  const facts = await browser.facts(request.tabId).catch(() => landed);
  return { facts, verification: single(false, "htmlDocument", detail) };
}

async function buildFailure(
  browser: BrowserPort,
  request: ActionRequest,
  facts: PageFacts,
  verification: Verification,
  options: ActOptions,
): Promise<FailureBundle> {
  const failed = verification.checks.filter((check) => !check.passed);
  const detail =
    failed.map(describeCheck).join(" | ") ||
    `action did not meet expectations at ${facts.url}`;
  // How long we waited belongs in the recovery text: "has not happened yet" and "is not
  // going to happen" read identically without it, and they call for different next moves.
  const waited = verification.waitedMs ?? 0;
  const recovery = (
    waited > 0 ? `${detail} (still failing ${waited}ms after the action)` : detail
  ).slice(0, MAX_RECOVERY_CHARS);

  let screenshot: string | undefined;
  if (options.screenshotDir) {
    screenshot = `${options.screenshotDir}/${facts.observation.id}.png`;
    await browser.screenshot(request.tabId, screenshot).catch(() => {
      screenshot = undefined;
    });
  }

  return {
    recovery,
    changes: facts.observation.changes,
    consoleErrors: facts.observation.consoleErrors,
    failedRequests: facts.observation.failedRequests,
    screenshot,
  };
}

/**
 * Evaluate a predicate against the live page without mutating anything.
 *
 * Settles like a postcondition does, for the same reason: a check issued straight after
 * something asynchronous would otherwise report the page as it was a moment ago. An
 * assertion that is genuinely false pays the full wait, which costs latency and no
 * tokens — the cheaper of the two ways to be wrong.
 */
export async function check(
  browser: BrowserPort,
  predicate: Predicate,
  tabId?: string,
  settleMs = DEFAULT_SETTLE_MS,
): Promise<Verification> {
  const { verification } = await settleVerification(
    browser,
    (facts) => {
      const result = evaluatePredicate(predicate, facts);
      return { status: result?.passed ? "passed" : "failed", checks: [result] };
    },
    // No `since`: predicates read the page, never what changed on it, so a check stays
    // at one read on the happy path.
    { tabId, budgetMs: settleMs },
  );
  return verification;
}

export { visibleText };
