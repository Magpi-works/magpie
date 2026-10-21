/**
 * Core capabilities as agent tools.
 *
 * Thin on purpose: validate, delegate to the core, return a compact result. Everything
 * that matters — verification, reversibility, the commit gate, evidence — happens inside
 * the core, so a tool cannot skip it by accident.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { inferTextFileName } from "../core/scratch.ts";
import type { BrowserPort } from "../core/browser.ts";
import { guardedAct, type ApprovalMode, type ApprovalRequest } from "../core/gate.ts";
import { peek, readOpenedTab } from "../core/peek.ts";
import { describeCheck, optionalPredicate, PREDICATE_KIND_LIST, validatePredicate } from "../core/predicates.ts";
import { describeDataDocument } from "../core/document.ts";
import { viewWithoutSession } from "../core/perspective.ts";
import { surveyCounts } from "../core/survey.ts";
import { stepCheck } from "../core/task.ts";
import { CoreError, type ActionRequest, type ParkedOutcome } from "../core/types.ts";
import { isBrowserApp, type WindowPort } from "../core/window-port.ts";
import {
  TOOL_ACT,
  TOOL_ASK,
  TOOL_CHECK,
  TOOL_DONE,
  TOOL_FORK,
  TOOL_OBSERVE,
  TOOL_PARK,
  TOOL_DISCOVER,
  TOOL_PEEK,
  TOOL_PROBE,
  TOOL_REMEMBER,
  TOOL_SAVE,
  TOOL_SEE,
  TOOL_SIDE_CLOSE,
  TOOL_SIDE_OPEN,
  TOOL_STRANGER,
  TOOL_SURVEY,
  TOOL_USE,
} from "./names.ts";
import { hashOf, observationStats } from "./metrics.ts";
import { isYieldKind, yieldInput } from "./coach/yield.ts";
import type { Evidence } from "./evidence.ts";
import { findWireObservation, wireText } from "./wire.ts";
import { DEFAULT_VIEW, type ViewStrategy } from "./view/index.ts";
import { challengeBehaviorEnabled } from "./challenge-detector.ts";
import { InteractiveChallengeGuard, type ChallengeTakeoverInfo } from "./challenge-handoff.ts";

export interface ReportPayload {
  status: "success" | "blocked" | "failed";
  summary: string;
}

export interface ToolContext {
  browser: BrowserPort;
  tabId?: string;
  /**
   * Required, and one thing rather than six optional ones.
   *
   * Every recording dependency used to be individually optional, so forgetting them all
   * looked exactly like choosing to record nothing. Recording nothing is still possible
   * via `nullEvidence()`; it just has to be said out loud.
   */
  evidence: Evidence;
  policy?: ApprovalMode;
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  askUser?: (question: string) => Promise<string | undefined>;
  onReport?: (report: ReportPayload) => void;
  /**
   * Close coach gate (COACH-22). Return terminate to finish, continue to keep
   * harvesting after an extend artifact, halt to stop for the operator.
   */
  beforeReport?: (
    report: ReportPayload,
  ) => Promise<"terminate" | "continue" | "halt">;
  onParked?: (parked: ParkedOutcome) => void;
  /** Counts one browser action against the task budget. */
  onStep?: () => void;
  /**
   * The action budget, so results can say how much is left.
   *
   * The system prompt is set once and resent verbatim, so a live counter cannot live in
   * the task card. Riding on action results instead costs nothing: the model already
   * reads them, and it currently cannot tell it is losing until it is cut off.
   */
  stepLimit?: number;
  /**
   * Cap on session-free views. Each one is a real anonymous request to the site, so it is
   * budgeted like any other read-only exploration rather than being free.
   */
  strangerViewBudget?: number;
  /** The current turn, so a result can be joined to the turn that paid for it. */
  turn?: () => number;
  /** How the page is described to the model. Defaults to the flat control list. */
  grants?: import("../core/gate.ts").GateGrant[];
  specHash?: string;
  neverPreapprove?: import("../core/gate.ts").NondelegableAction[];
  claim?: (key: string) => Promise<boolean>;
  onGrantUsed?: (grantId: string) => Promise<void>;
  onDiscover?: (input: {
    templateId: string;
    entities: Array<{ label: string; facts?: Record<string, unknown> }>;
  }) => Promise<{ created: number; error?: string }>;
  view?: ViewStrategy;
  /**
   * Interactive challenge halt (AGENT-13-T03). Wired by the host to focus the tab.
   * Behavior stays off unless BSA_CHALLENGE_BEHAVIOR is set.
   */
  onChallengeTakeover?: (info: ChallengeTakeoverInfo) => Promise<void>;
  challengeGuard?: InteractiveChallengeGuard;
  /** Desktop channel. Omitted by the suite and the hosted runtime. */
  window?: WindowPort;
  /** After `use` leaves Chrome, reconnect CDP so the next observe still has refs. */
  onLeaveBrowser?: () => Promise<void>;
}

export const DEFAULT_STRANGER_VIEW_BUDGET = 3;

type ToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type Result = { content: ToolContentPart[]; details: unknown; terminate?: boolean };

/**
 * Our tool shape. Params are `unknown` on purpose: the schema is enforced by the engine,
 * and narrowing here rather than trusting a generic keeps the cast at one boundary.
 */
interface RuntimeTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<Result>;
}

function reply(value: unknown, details: unknown = value): Result {
  return { content: [{ type: "text", text: wireText(value) }], details };
}

/** A file name, not a path. Paste-site hunting started with nowhere local to write. */
export function safeArtifactName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Measure and keep every tool result, at the one place they all pass through.
 *
 * Wrapping `execute` rather than `reply` keeps the tool name available and means a tool
 * added later is measured without touching it. The text measured here is exactly the
 * string the model receives, so the bytes are the real bytes rather than an estimate -
 * and it is the same string written to the payload log, which is what makes it safe for
 * a host to show one line instead.
 */
function measured(
  tool: RuntimeTool,
  context: ToolContext,
  view: ViewStrategy,
  guard: InteractiveChallengeGuard,
): RuntimeTool {
  const { metrics, payloads } = context.evidence;

  return {
    ...tool,
    execute: async (toolCallId: string, params: unknown) => {
      const halted =
        guard.halted &&
        challengeBehaviorEnabled() &&
        tool.name !== TOOL_OBSERVE &&
        tool.name !== TOOL_PEEK &&
        tool.name !== TOOL_DONE &&
        tool.name !== TOOL_ASK;
      if (halted) {
        const blocked = guard.blockedReply();
        return reply(blocked, blocked);
      }

      const result = await tool.execute(toolCallId, params);
      const turn = context.turn?.() ?? 0;
      const text = result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const hash = hashOf(text);

      payloads.write({ at: new Date().toISOString(), turn, tool: tool.name, bytes: text.length, hash, text });

      metrics.record({
        kind: "tool_result",
        turn,
        tool: tool.name,
        bytes: text.length,
        hash,
      });

      /*
       * Snapshots dominate the bill, so they are counted in their own right wherever they
       * turn up rather than only when `observe` produced them.
       *
       * Read back out of the text the model received, through the view that wrote it. A
       * hard-coded shape here counted zero snapshots the moment a candidate description
       * stopped using an array of objects, which would have left the seam unable to
       * measure the only thing it exists to measure.
       */
      const observation = view.anySnapshot(text) ?? findWireObservation(result.details);
      if (observation) {
        metrics.record({
          kind: "observation",
          turn,
          tool: tool.name,
          // In the format it was sent in, or the comparison between two descriptions is
          // a comparison of one description measured twice.
          bytes: view.sizeOf(observation),
          hash: hashOf(wireText(observation)),
          ...observationStats(observation),
        });
        const blocked = await guard.afterObservation({
          observation,
          intent: tool.name,
          evidenceIds: [],
          tabId: context.tabId,
          ledger: context.evidence.ledger,
          metrics: context.evidence.metrics,
          entityId: context.evidence.entityId,
        });
        if (blocked) return reply(blocked, blocked);
      }

      return result;
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof CoreError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Closed predicate shape the model fills in. Nested `of` stays loosely typed. */
const PredicateSchema = Type.Object({
  kind: Type.Enum(PREDICATE_KIND_LIST, {
    description: "text_visible, url_includes, … — not probe's text kind",
  }),
  text: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  open: Type.Optional(Type.Boolean()),
  of: Type.Optional(Type.Any()),
});

/**
 * `type` reads `text` and `select` reads `value`, and models swap them. A swapped field
 * used to type "" and pass the read-back (an empty want accepts anything), so a form
 * looked filled while staying empty.
 */
/**
 * On a commit the gate reads `expect` as a precondition (D23), while a model usually
 * means the outcome. Without saying so, a refused "create" looked like a dead end and
 * the run gave up with the form filled.
 */
export function refusalNote(code: string): string {
  if (code === "precondition_failed") {
    return "The action did not happen. This action commits, so expect was checked before acting as a precondition. If expect describes the outcome you want, act again without expect, then use check.";
  }
  return "The action did not happen. Fix the precondition or take another route.";
}

export function fillArgs(request: ActionRequest): ActionRequest | string {
  if (request.kind === "type" && request.text === undefined) {
    if (typeof request.value === "string") return { ...request, text: request.value };
    return 'type needs "text" (use "" to clear a field)';
  }
  if (request.kind === "select" && request.value === undefined) {
    if (typeof request.text === "string") return { ...request, value: request.text };
    return 'select needs "value"';
  }
  return request;
}

export function buildTools(context: ToolContext): AgentTool[] {
  const view = context.view ?? DEFAULT_VIEW;
  const guard =
    context.challengeGuard ??
    new InteractiveChallengeGuard(
      // Lazy: reading goalId at compose time mints a directory before session_start
      // can restore the id from Pi entries.
      () => `session:${context.evidence.goal?.goalId ?? "interactive"}`,
      undefined,
      context.onChallengeTakeover,
    );
  let strangerViews = 0;
  let steps = 0;

  // The primary tab is the one the task is anchored to. A side tab makes the *active* tab
  // something else for a while, and every tool follows it, so `act` works in the side tab
  // with no special casing. The primary is never navigated by side work, which is the
  // whole point: there is no position to restore because nothing moved.
  let sideTab: string | undefined;
  const tab = () => sideTab ?? context.tabId;

  const closeSideTab = async (): Promise<void> => {
    if (!sideTab) return;
    const closing = sideTab;
    sideTab = undefined;
    await context.browser.closeTab(closing).catch(() => undefined);
  };

  const countStep = () => {
    steps += 1;
    context.onStep?.();
  };

  /**
   * How much of the budget is gone.
   *
   * The nudge past halfway exists because a bad route is only worth knowing about while
   * there is still budget to change it. It suggests rather than instructs: we do not know
   * how many items are left, so we cannot say whether the pace is actually wrong.
   */
  const budget = (): Record<string, unknown> | undefined => {
    if (!context.stepLimit) return undefined;
    const spent = { spent: steps, limit: context.stepLimit };
    if (steps * 2 < context.stepLimit) return spent;
    return {
      ...spent,
      note:
        "Over half the action budget is gone. If you are working through a list, check you " +
        `are on the cheap route: ${TOOL_PEEK} reads an item without leaving the list.`,
    };
  };

  const tools: RuntimeTool[] = [
    {
      name: TOOL_OBSERVE,
      label: "Observe",
      description: "Snapshot this tab: url, title, controls with refs, dialogs, errors, and what changed.",
      promptSnippet: "Look at the page. Refs come from here.",
      parameters: Type.Object({}),
      execute: async () => reply(view.observation(await context.browser.observe(tab()))),
    },
    {
      name: TOOL_PROBE,
      label: "Probe",
      description:
        'Read-only query. Required: query.kind (page_meta | text | count | elements | form_inventory | table | links). ' +
        'count, elements, and table also need query.select (a CSS selector). Cannot change the page or read credentials.',
      promptSnippet: "Read anything about the page without touching it.",
      parameters: Type.Object({ query: Type.Object({}, { additionalProperties: true })}),
      execute: async (_id: string, params: unknown) => {
        const query = (params as { query: unknown }).query;
        try {
          const result = await context.browser.probe(query, tab());
          // The probe answers; recording is ours, so evidence has one owner.
          await context.evidence.ledger.append({
            type: "probe",
            entityId: context.evidence.entityId,
            intent: `probe ${(query as { kind?: string })?.kind ?? "?"}`,
            payload: {
              query,
              truncated: result.truncated,
              url: context.browser.lastObservation(tab())?.url,
            },
          });
          return reply(result.truncated ? { data: result.data, note: result.note } : result.data);
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_CHECK,
      label: "Check",
      description: "Evaluate a predicate on the live page (text_visible, url_includes, all, …).",
      promptSnippet: "Verify a claim instead of assuming it.",
      parameters: Type.Object({ predicate: Type.Optional(PredicateSchema) }),
      execute: async (_id: string, params: unknown) => {
        try {
          const verification = await stepCheck(
            context.browser,
            (params as { predicate: unknown }).predicate,
            { ledger: context.evidence.ledger, entityId: context.evidence.entityId, tabId: tab() },
          );
          return reply(view.verification(verification));
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_ACT,
      label: "Act",
      description:
        "One verified action: navigate, click, type, select, scroll, wait, upload, or restore (reload the latest checkpoint). Address by ref.",
      promptSnippet: "One verified browser action.",
      parameters: Type.Object({
        kind: Type.String({
          description: "navigate | click | type | select | scroll | wait | upload | restore",
        }),
        ref: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ description: "type: the text to enter" })),
        value: Type.Optional(Type.String({ description: "select: the option to choose" })),
        dy: Type.Optional(Type.Number()),
        files: Type.Optional(Type.Array(Type.String())),
        wait: Type.Optional(Type.Object({}, { additionalProperties: true })),
        expect: Type.Optional({
          ...PredicateSchema,
          description:
            "What should hold after the action. On a commit (create, send, pay, delete) it must already hold before acting instead.",
        }),
        intent: Type.Optional(Type.String({ description: "Why, in a few words" })),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as { expect?: unknown };
        try {
          if (raw.expect != null) {
            const errors = validatePredicate(raw.expect, "expect");
            if (errors.length > 0) {
              return reply({
                error: errors.join("; "),
              });
            }
          }
          const args = fillArgs(params as ActionRequest);
          if (typeof args === "string") return reply({ error: args });
          countStep();
          const expect = optionalPredicate(raw.expect);
          const request = { ...args, tabId: tab(), expect };
          const outcome = await guardedAct(
            context.browser,
            request,
            {
              policy: context.policy,
              approve: context.approve,
              ledger: context.evidence.ledger,
              entityId: context.evidence.entityId,
              screenshotDir: context.evidence.screenshotDir,
              precondition: expect,
              checkpoint: context.evidence.goal,
              specHash: context.specHash,
              grants: context.grants,
              neverPreapprove: context.neverPreapprove,
              claim: context.claim,
              onGrantUsed: context.onGrantUsed,
              onAsk: (info) => {
                context.evidence.metrics.record({
                  kind: "gate_ask",
                  authorization: info.authorization,
                  recoverability: info.recoverability,
                  ruleId: info.ruleId,
                });
              },
            },
          );

          if (outcome.status === "parked") {
            context.onParked?.(outcome.parked);
            return reply({
              done: false,
              parked: outcome.parked.reason,
              note: "Needs operator approval because this would leave the session. It has not happened.",
            });
          }
          if (outcome.status === "refused") {
            return reply({
              done: false,
              refused: outcome.code,
              why: outcome.reason,
              note: refusalNote(outcome.code),
            });
          }
          const spent = budget();
          return reply({
            ...view.actionResult(outcome.result),
            ...(spent ? { budget: spent } : {}),
          });
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_ASK,
      label: "Ask operator",
      description:
        "Ask the operator for something only they know. Blocks until they answer. Never invent personal data or continue with guessed defaults.",
      promptSnippet: "Ask rather than guess personal facts, then wait.",
      parameters: Type.Object({ question: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const question = String((params as { question: unknown }).question);
        if (!context.askUser) {
          await context.evidence.ledger.append({
            type: "note",
            entityId: context.evidence.entityId,
            intent: `asked: ${question}`,
            outcome: { ok: false, detail: "unanswered" },
          });
          return reply({
            answered: false,
            note: "Nobody available. Report what you are missing.",
          });
        }
        const answer = await context.askUser(question);
        await context.evidence.ledger.append({
          type: "note",
          entityId: context.evidence.entityId,
          intent: `asked: ${question}`,
          outcome: { ok: answer !== undefined, detail: answer ?? "unanswered" },
        });
        return answer === undefined
          ? reply({
              answered: false,
              note: "The operator dismissed this. Do not invent an answer. Stop or ask again only if the task cannot continue.",
            })
          : reply({ answered: true, answer });
      },
    },
    {
      name: TOOL_STRANGER,
      label: "View without session",
      description: "Load a URL with no session and compare it to what you see.",
      promptSnippet: "See a page as an anonymous visitor, and how that differs.",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ description: "Defaults to the current page" })),
      }),
      execute: async (_id: string, params: unknown) => {
        const budget = context.strangerViewBudget ?? DEFAULT_STRANGER_VIEW_BUDGET;
        if (strangerViews >= budget) {
          return reply({
            error: `session-free view budget of ${budget} is spent`,
            note: "Reason from what you already observed, or ask the operator.",
          });
        }
        strangerViews += 1;
        try {
          const result = await viewWithoutSession(context.browser, {
            url: (params as { url?: string }).url,
            tabId: tab(),
            ledger: context.evidence.ledger,
            entityId: context.evidence.entityId,
          });
          if (result.dataDocument) {
            return reply({
              error: describeDataDocument(result.dataDocument),
              note: "This is a payload, not a page. Use scratch_ls / scratch_read; do not peek file://.",
            });
          }
          return reply({
            asStranger: view.observation(result.signedOut),
            differences: result.delta,
          });
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_REMEMBER,
      label: "Remember",
      description: "Record something you established, in your own words.",
      promptSnippet: "Record what you established, with the evidence for it.",
      parameters: Type.Object({
        key: Type.String({ description: "Short name, e.g. operating-identity" }),
        value: Type.String({ description: "What you established, and what you saw" }),
        yield: Type.Optional(
          Type.String({
            description:
              "Yield kind: candidate_accepted | candidate_rejected | candidate_duplicate | fact_established | route_affordance | lost_place",
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as { key?: unknown; value?: unknown; yield?: unknown };
        const key = String(raw.key ?? "").trim();
        const value = String(raw.value ?? "").trim();
        if (!key || !value) return reply({ error: "remember needs a key and a value" });

        const kind = isYieldKind(raw.yield) ? raw.yield : undefined;
        const event = await context.evidence.ledger.append(
          kind
            ? yieldInput({ kind, summary: key, reason: value, entityId: context.evidence.entityId })
            : {
                type: "note",
                entityId: context.evidence.entityId,
                intent: `established: ${key}`,
                outcome: { ok: true, detail: value },
              },
        );
        await context.evidence.facts.mergeGoalFacts({
          [key]: { value, evidence: event?.id, at: new Date().toISOString() },
        });
        return reply({ remembered: key, evidence: event?.id ?? null });
      },
    },
    {
      name: TOOL_SAVE,
      label: "Save artifact",
      description: "Write a text document to this goal's artifacts.",
      promptSnippet: "Persist a document here, not on a paste site.",
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "File name, e.g. portfolio.csv. If omitted, Magpie infers artifact.csv / .md / .json / .txt from the content.",
          }),
        ),
        content: Type.String({ description: "The full document" }),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as { name?: unknown; content?: unknown };
        const content = String(raw.content ?? "");
        const name = safeArtifactName(
          inferTextFileName(typeof raw.name === "string" ? raw.name : undefined, content),
        );
        if (!name) return reply({ error: "save_artifact needs content (and a file name if the content is empty)" });
        const dir = context.evidence.ledger.artifactsDir;
        if (!dir) return reply({ error: "this session has nowhere to write artifacts" });
        const file = path.join(dir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(file, content, "utf8");
        const event = await context.evidence.ledger.append({
          type: "note",
          entityId: context.evidence.entityId,
          intent: `saved artifact ${name}`,
          outcome: { ok: true, detail: file },
          artifacts: [file],
        });
        return reply({
          saved: name,
          path: file,
          bytes: Buffer.byteLength(content, "utf8"),
          evidence: event?.id ?? null,
          ...(typeof raw.name === "string" && raw.name.trim() ? {} : { inferredName: true }),
        });
      },
    },
    {
      name: TOOL_SURVEY,
      label: "Survey",
      description: "List what this page offers, following none of it.",
      promptSnippet: "See the routes on offer before picking one.",
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const survey = await context.browser.survey(tab());
          await context.evidence.ledger.append({
            type: "probe",
            entityId: context.evidence.entityId,
            intent: `survey what ${survey.url} offers`,
            payload: { counts: surveyCounts(survey) },
          });
          return reply(survey);
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_PEEK,
      label: "Peek",
      description: `Read a URL in a side tab and return. Pass expect when you built the URL. Refs from it cannot be acted on; use ${TOOL_SIDE_OPEN} to work there.`,
      promptSnippet: "Read something elsewhere without losing your place.",
      parameters: Type.Object({
        url: Type.String(),
        expect: Type.Optional(PredicateSchema),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as { url?: unknown; expect?: unknown };
        try {
          countStep();
          const expect = optionalPredicate(raw.expect);
          const result = await peek(context.browser, {
            url: String(raw.url ?? ""),
            tabId: tab(),
            ...(expect ? { expect } : {}),
            ledger: context.evidence.ledger,
            entityId: context.evidence.entityId,
          });
          const spent = budget();
          if (result.dataDocument) {
            return reply({
              matched: false,
              note: `${describeDataDocument(result.dataDocument)}. Do not read anything into it.`,
              stillOn: result.origin.url,
              ...(spent ? { budget: spent } : {}),
            });
          }
          return reply({
            page: view.observation(result.observation),
            matched: result.matched,
            ...(result.identity ? { identity: describeCheck(result.identity) } : {}),
            ...(result.matched
              ? result.identity && !result.identity.passed
                ? { note: "The URL opened, but it is not the entity you expected." }
                : {}
              : { note: "This URL did not open the page you asked for. Do not read anything into it." }),
            stillOn: result.origin.url,
            ...(spent ? { budget: spent } : {}),
          });
        } catch (err) {
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_SIDE_OPEN,
      label: "Open side tab",
      description: `Open a side tab and work there until ${TOOL_SIDE_CLOSE}. One at a time.`,
      promptSnippet: "Work somewhere else without losing your place.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        if (sideTab) {
          return reply({
            error: "a side tab is already open",
            note: `Close it with ${TOOL_SIDE_CLOSE} first. Only one at a time.`,
          });
        }
        let opened: string | undefined;
        try {
          countStep();
          const primary = await context.browser.observe(context.tabId);
          opened = await context.browser.openTab(String((params as { url?: unknown }).url ?? ""));
          sideTab = opened;
          const facts = await readOpenedTab(context.browser, sideTab);
          if (facts.document?.kind === "data") {
            await context.browser.closeTab(opened).catch(() => undefined);
            sideTab = undefined;
            return reply({
              error: describeDataDocument(facts.document),
              note: "This is a payload, not a page. Close is unnecessary; the tab was not kept.",
              stillOn: primary.url,
            });
          }
          const observation = facts.observation;
          await context.evidence.ledger.append({
            type: "note",
            entityId: context.evidence.entityId,
            intent: `open side tab at ${observation.url}`,
            outcome: { ok: true, detail: `still on ${primary.url}` },
          });
          return reply({
            page: view.observation(observation),
            stillOn: primary.url,
            note: `You are now working in the side tab. ${TOOL_SIDE_CLOSE} returns you.`,
          });
        } catch (err) {
          // A failed open must not leave a leaked tab or the active tab pointing at nothing.
          if (opened) await context.browser.closeTab(opened).catch(() => undefined);
          sideTab = undefined;
          return reply({ error: describeError(err) });
        }
      },
    },
    {
      name: TOOL_SIDE_CLOSE,
      label: "Close side tab",
      description: "Close the side tab and go back to working on the page you left.",
      promptSnippet: "Return to the page you left.",
      parameters: Type.Object({}),
      execute: async () => {
        if (!sideTab) return reply({ error: "no side tab is open" });
        const closing = sideTab;
        sideTab = undefined;
        try {
          await context.browser.closeTab(closing);
        } catch (err) {
          return reply({ error: describeError(err) });
        }
        return reply({ page: view.observation(await context.browser.observe(context.tabId)) });
      },
    },
    {
      name: TOOL_FORK,
      label: "Note fork",
      description: "Record that a task word matched more than one thing here.",
      promptSnippet: "Record an ambiguity instead of silently resolving it.",
      parameters: Type.Object({
        term: Type.String({ description: 'The word from the task, e.g. "friend list"' }),
        candidates: Type.Array(Type.String(), { description: "What it could mean here" }),
        resolution: Type.String({ description: "covered_all | asked | chose" }),
        why: Type.String(),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as {
          term?: unknown;
          candidates?: unknown;
          resolution?: unknown;
          why?: unknown;
        };
        const term = String(raw.term ?? "").trim();
        const candidates = Array.isArray(raw.candidates)
          ? raw.candidates.map((entry) => String(entry).trim()).filter(Boolean)
          : [];
        if (!term || candidates.length < 2) {
          return reply({
            error: "a fork needs a term and at least two candidates",
            note: "If only one thing matched, there is no fork to record.",
          });
        }
        const resolution = ["covered_all", "asked", "chose"].includes(String(raw.resolution))
          ? String(raw.resolution)
          : "chose";
        const why = String(raw.why ?? "").trim();

        const event = await context.evidence.ledger.append({
          type: "fork",
          entityId: context.evidence.entityId,
          intent: `"${term}" could mean ${candidates.join(" or ")}`,
          outcome: { ok: true, detail: `${resolution}: ${why}` },
          payload: { term, candidates, resolution, why },
        });
        await context.evidence.facts.mergeGoalFacts({
          [`fork:${term}`]: { candidates, resolution, why, evidence: event?.id },
        });
        return reply({ recorded: term, candidates: candidates.length, resolution });
      },
    },
    {
      name: TOOL_PARK,
      label: "Park",
      description:
        "Stop this attempt without failing the job. Use for CAPTCHA, rate limits, waiting on a person, or a missing fact. Terminates the turn.",
      promptSnippet: "Yield with a wake condition rather than looping.",
      parameters: Type.Object({
        reason: Type.String(),
        wake: Type.String({ description: "timer | third_party | human" }),
        perishable: Type.Boolean(),
        recommendedRetryMs: Type.Optional(Type.Number()),
        handoff: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String({ description: "decision | approval | challenge | identity" })),
        resource: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as {
          reason?: unknown;
          wake?: unknown;
          perishable?: unknown;
          recommendedRetryMs?: unknown;
          handoff?: unknown;
          kind?: unknown;
          resource?: unknown;
        };
        const wake = ["timer", "third_party", "human"].includes(String(raw.wake))
          ? (String(raw.wake) as ParkedOutcome["wake"])
          : "human";
        const parked: ParkedOutcome = {
          status: "parked",
          reason: String(raw.reason ?? "parked"),
          wake,
          perishable: Boolean(raw.perishable),
          recommendedRetryMs:
            typeof raw.recommendedRetryMs === "number" ? raw.recommendedRetryMs : undefined,
          handoff: raw.handoff ? String(raw.handoff) : undefined,
          payload: {
            kind: raw.kind ? String(raw.kind) : wake === "human" ? "decision" : "challenge",
            resource: raw.resource ? String(raw.resource) : undefined,
          },
        };
        context.onParked?.(parked);
        await closeSideTab();
        return { ...reply(parked, parked), terminate: true };
      },
    },
    {
      name: TOOL_DISCOVER,
      label: "Discover work",
      description:
        "Append entities from an approved task template. Cannot invent weaker criteria.",
      promptSnippet: "Instantiate an approved template for newly found entities.",
      parameters: Type.Object({
        templateId: Type.String(),
        entities: Type.Array(
          Type.Object({
            label: Type.String(),
            facts: Type.Optional(Type.Object({}, { additionalProperties: true })),
          }),
        ),
      }),
      execute: async (_id: string, params: unknown) => {
        if (!context.onDiscover) {
          return reply({
            error: "discovery is not enabled on this task",
            note: "Only approved templates on a job run can create more work.",
          });
        }
        const raw = params as {
          templateId?: unknown;
          entities?: Array<{ label?: unknown; facts?: Record<string, unknown> }>;
        };
        const result = await context.onDiscover({
          templateId: String(raw.templateId ?? ""),
          entities: (raw.entities ?? []).map((entry) => ({
            label: String(entry.label ?? ""),
            facts: entry.facts,
          })),
        });
        return reply(result);
      },
    },
    {
      name: TOOL_DONE,
      label: "Report",
      description: "Report the outcome and stop. status is success, blocked, or failed.",
      promptSnippet: "Finish with a truthful report.",
      parameters: Type.Object({
        status: Type.String({ description: "success | blocked | failed" }),
        summary: Type.String(),
      }),
      execute: async (_id: string, params: unknown) => {
        const raw = params as { status?: unknown; summary?: unknown };
        const status = ["success", "blocked", "failed"].includes(String(raw.status))
          ? (String(raw.status) as ReportPayload["status"])
          : "failed";
        const report: ReportPayload = { status, summary: String(raw.summary ?? "") };
        const gate = context.beforeReport ? await context.beforeReport(report) : "terminate";
        if (gate === "continue") {
          return reply({
            ...report,
            status: "blocked",
            summary: `${report.summary}\n[close coach] SUCCESS not met — continue harvest on the new guideline.`,
            close: "extend",
          });
        }
        if (gate === "halt") {
          await closeSideTab();
          const halted: ReportPayload = {
            status: "blocked",
            summary: `${report.summary}\n[close coach] Halted for the operator.`,
          };
          context.onReport?.(halted);
          return { ...reply(halted, halted), terminate: true };
        }
        await closeSideTab();
        context.onReport?.(report);
        // Terminate: the report ends the task, so no follow-up model turn is needed.
        return { ...reply(report, report), terminate: true };
      },
    },
  ];

  if (context.window) {
    const desktop = context.window;
    const see = async (): Promise<Result> => {
      try {
        const windows = await desktop.list();
        const focused = windows.find((window) => window.focused) ?? windows[0];
        const body = {
          windows: windows.map((window) => ({
            app: window.app,
            title: window.title,
            focused: window.focused,
          })),
          focused: focused ? { app: focused.app, title: focused.title } : undefined,
        };
        if (!focused) return reply({ ...body, error: "no windows" });
        const image = await desktop.capture(focused.id);
        return {
          content: [
            { type: "text", text: wireText(body) },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
          details: { ...body, windowId: focused.id },
        };
      } catch (err) {
        return reply({ error: describeError(err) });
      }
    };

    tools.push(
      {
        name: TOOL_SEE,
        label: "See",
        description:
          "List desktop windows and attach one image of the focused window. Coordinates are not browser refs.",
        promptSnippet: "Look at the focused desktop window when the page has no named control.",
        parameters: Type.Object({}),
        execute: async () => see(),
      },
      {
        name: TOOL_USE,
        label: "Use",
        description:
          "One desktop action on the focused window: focus, click, type, key, or scroll. Returns the next see. Not a browser ref.",
        promptSnippet: "One desktop action, then look again.",
        parameters: Type.Object({
          action: Type.String({ description: "focus | click | type | key | scroll" }),
          title: Type.Optional(Type.String({ description: "Window title or app name for focus" })),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          text: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          dy: Type.Optional(Type.Number()),
        }),
        execute: async (_id: string, params: unknown) => {
          const raw = params as {
            action?: string;
            title?: string;
            x?: number;
            y?: number;
            text?: string;
            key?: string;
            dy?: number;
          };
          try {
            const action = String(raw.action ?? "");
            if (action === "focus") {
              const outcome = await desktop.focus(String(raw.title ?? ""));
              if (!outcome.ok) {
                return reply({
                  titles: outcome.titles,
                  note: "Two windows share that title. Pick one.",
                });
              }
              if (!isBrowserApp(outcome.window.app)) await context.onLeaveBrowser?.();
              return see();
            }
            const windows = await desktop.list();
            const focused = windows.find((window) => window.focused) ?? windows[0];
            if (!focused) return reply({ error: "no focused window" });
            if (action === "click") await desktop.click(focused.id, Number(raw.x ?? 0), Number(raw.y ?? 0));
            else if (action === "type") await desktop.type(String(raw.text ?? ""));
            else if (action === "key") await desktop.key(String(raw.key ?? ""));
            else if (action === "scroll") await desktop.scroll(Number(raw.dy ?? 0));
            else return reply({ error: `unknown desktop action: ${action}` });
            if (!isBrowserApp(focused.app)) await context.onLeaveBrowser?.();
            return see();
          } catch (err) {
            return reply({ error: describeError(err) });
          }
        },
      },
    );
  }

  // One cast, at the boundary where the engine takes over.
  return tools.map((tool) => measured(tool, context, view, guard)) as unknown as AgentTool[];
}
