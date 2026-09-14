/**
 * Interactive `/coach`: review-phase digest in, strategy artifact out (COACH-09, 12–13, 15–18).
 *
 * Stronger review class (COACH-12): Pi thinking `high`, plus the Magpie `coach` model
 * pin when set (`/models`). Restored after accept or abort. Not an `@ultra` prefix.
 */

import { coreRoot, goalPaths } from "../core/paths.ts";
import type { Evidence } from "../runtime/evidence.ts";
import { compileDigest, type CompiledDigest } from "../runtime/coach/digest.ts";
import {
  harvestFollowed,
  hasScoutYield,
  magpieRescueDecision,
  siteActionsWithoutCandidateYield,
} from "../runtime/coach/rescue.ts";
import {
  assertStrategyArtifact,
  renderStrategyArtifact,
  StrategyArtifactError,
  STRATEGY_JSON_EXAMPLE,
  STRATEGY_REQUIRED_HINT,
  type StrategyArtifact,
} from "../runtime/coach/strategy.ts";
import { readMetrics } from "../optimize/recorder.ts";
import type { CustomSessionMessage, ExtensionAPI, ExtensionContext } from "../pi-api.ts";
import { capabilityCoordinator } from "./pi-capabilities.ts";
import { PLAN_MODE_DISABLED_TOOLS } from "./pi-plan-mode.ts";
import { assistantText, isAssistantMessage } from "./pi-plan-todos.ts";
import { firstOperatorGoal, isOperatorGoalText, MAGPIE_CHAT_OBJECTIVE } from "./pi-operator-goal.ts";
import { modelKey, type MagpieModelHost } from "./pi-models.ts";

export const COACH_COMMAND = "coach";
export const COACH_CHECKPOINT_ENTRY = "coach-checkpoint";
export const COACH_CONTEXT_TYPE = "coach-review-context";
export const COACH_REVIEW_THINKING = "high" as const;
export const COACH_DISABLED_TOOLS = PLAN_MODE_DISABLED_TOOLS;

const COACH_RETRY_MAX = 2;

const COACH_INSTRUCTIONS =
  "[COACH REVIEW]\n" +
  "Phase: review. Mutations are off. Output one JSON object only, exactly this shape " +
  "(unknown keys are dropped and the artifact is rejected as empty):\n" +
  STRATEGY_JSON_EXAMPLE +
  "\n" +
  STRATEGY_REQUIRED_HINT +
  "\nDo not rewrite qualification criteria, grants, send, or follow policy. Do not skip approval. " +
  "Coach is a guideline generator, not a second planner. The loop is a trial, not a lock: " +
  "doNot may name wasted routes already in this digest; do not forbid untested pools. " +
  "If yield counts are zero, say so and demand recording — do not lock a pool. " +
  "This turn uses a stronger thinking class; it is restored after the artifact.\n\n" +
  "Efficiency is waste-reduction (a repeatable loop, peek instead of losing the list), " +
  "not a cheaper-than-browser substitute. If the digest shows empty SPA shells, " +
  "fetch-only HTML, or required fields left unknown, put an escalate-to-observe " +
  "(live Chrome) exception in the artifact. Harvest still uses Magpie peek/observe; " +
  "coder curl is not the loop when the spec says verify on the product. " +
  "Do not scale “mark unknown and move on” for fields the goal required checking.\n\n" +
  "Trajectory digest (not the session transcript):\n";

export interface CoachCheckpointData {
  at: string;
  artifact: StrategyArtifact;
  rendered: string;
  digestBytes: number;
  artifactBytes: number;
  phase: "review";
  replacedPrevious?: boolean;
}

export interface PlanSlice {
  objective?: string;
  criteria?: readonly string[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CoachThinking {
  get(): string | undefined;
  set(level: ThinkingLevel): void;
}

export interface CoachHandle {
  enabled(): boolean;
  injection(): string | undefined;
  hasArtifact(): boolean;
  startReview(ctx: ExtensionContext): Promise<boolean>;
  onArtifact(handler: (ctx: ExtensionContext) => void): void;
  setPlanSlice(slice: PlanSlice): void;
  /** Instant Execute began; plan-mode yields before this do not count as scout yield. */
  setScoutEpoch(iso: string | undefined): void;
  hasScoutYield(): Promise<boolean>;
  considerRescue(ctx: ExtensionContext): Promise<"none" | "started" | "halted">;
}

export interface CoachBindOptions {
  evidence: Evidence;
  objective: string | (() => string);
  criteria?: readonly string[] | (() => readonly string[]);
  thinking?: CoachThinking;
  models?: MagpieModelHost;
}

function restoreCheckpoint(
  entries: ReadonlyArray<{ customType?: string; data?: unknown }>,
): CoachCheckpointData | undefined {
  const found = [...entries].reverse().find((entry) => entry.customType === COACH_CHECKPOINT_ENTRY);
  const data = found?.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Partial<CoachCheckpointData>;
  if (!record.artifact || !record.rendered || !record.at) return undefined;
  return record as CoachCheckpointData;
}

function resolveBoundText(value: string | (() => string) | undefined): string {
  const raw = typeof value === "function" ? value() : value;
  return raw?.trim() ?? "";
}

function resolveBoundList(
  value: readonly string[] | (() => readonly string[]) | undefined,
): string[] {
  const raw = typeof value === "function" ? value() : value;
  return [...(raw ?? [])];
}

function thinkingControl(pi: ExtensionAPI, options: CoachBindOptions): CoachThinking | undefined {
  if (options.thinking) return options.thinking;
  if (typeof pi.setThinkingLevel !== "function") return undefined;
  return {
    get: () => pi.thinkingLevel ?? pi.getThinkingLevel?.(),
    set: (level) => pi.setThinkingLevel?.(level),
  };
}

async function compileSessionDigest(
  options: CoachBindOptions,
  checkpoint: CoachCheckpointData | undefined,
  ctx: ExtensionContext | undefined,
  planSlice: PlanSlice,
): Promise<CompiledDigest> {
  const events = (await options.evidence.ledger.read?.()) ?? [];
  await options.evidence.metrics.flush();
  let metrics: Awaited<ReturnType<typeof readMetrics>> = [];
  const goalId = options.evidence.goal?.goalId;
  const root = options.evidence.goal?.root ?? coreRoot();
  if (goalId) {
    metrics = await readMetrics(goalPaths(root, goalId).metricsFile);
  }
  const since = checkpoint
    ? events.filter((event) => {
        const ts = Date.parse(event.ts);
        const at = Date.parse(checkpoint.at);
        return !Number.isFinite(ts) || !Number.isFinite(at) || ts >= at;
      })
    : events;
  const boundObjective = resolveBoundText(options.objective);
  const goalText =
    (planSlice.objective && isOperatorGoalText(planSlice.objective) ? planSlice.objective : undefined) ||
    firstOperatorGoal(ctx?.sessionManager?.getEntries?.() ?? []) ||
    (isOperatorGoalText(boundObjective) ? boundObjective : undefined) ||
    boundObjective ||
    MAGPIE_CHAT_OBJECTIVE;
  const criteria = planSlice.criteria?.length
    ? [...planSlice.criteria]
    : resolveBoundList(options.criteria);
  return compileDigest({
    events,
    metrics,
    goalText,
    criteria,
    checkpoint: checkpoint ? { at: checkpoint.at } : undefined,
    previousArtifact: checkpoint
      ? { summary: checkpoint.artifact.summary, followed: harvestFollowed(since) }
      : undefined,
  });
}

export function bindCoach(pi: ExtensionAPI, options: CoachBindOptions): CoachHandle {
  const capabilities = capabilityCoordinator(pi);
  const thinking = thinkingControl(pi, options);
  let reviewing = false;
  let digestJson = "";
  let latest: CoachCheckpointData | undefined;
  let artifactListener: ((ctx: ExtensionContext) => void) | undefined;
  let lastAttemptText = "";
  let rejectCount = 0;
  let planSlice: PlanSlice = {};
  let scoutEpoch: string | undefined;
  let savedThinking: string | undefined;
  let coachHeld = false;
  let rescueInFlight = false;
  let emptyRescues = 0;
  let halted = false;

  function persist(data: CoachCheckpointData): void {
    latest = data;
    pi.appendEntry?.(COACH_CHECKPOINT_ENTRY, data);
  }

  function requestReviewClass(): boolean {
    if (!thinking) return false;
    savedThinking = thinking.get() ?? "medium";
    thinking.set(COACH_REVIEW_THINKING);
    return true;
  }

  function restoreReviewClass(): void {
    if (!thinking || savedThinking === undefined) return;
    const previous = savedThinking as ThinkingLevel;
    savedThinking = undefined;
    thinking.set(previous);
  }

  async function requestReviewModel(ctx: ExtensionContext): Promise<string | undefined> {
    if (!options.models) return undefined;
    const error = await options.models.enter("coach", ctx);
    if (error) return error;
    coachHeld = true;
    return undefined;
  }

  async function restoreReviewModel(ctx: ExtensionContext): Promise<void> {
    if (!coachHeld) return;
    coachHeld = false;
    await options.models?.leave(ctx);
  }

  function enableReview(ctx: ExtensionContext): void {
    reviewing = true;
    lastAttemptText = "";
    rejectCount = 0;
    capabilities.constrain("coach", { disable: COACH_DISABLED_TOOLS });
    ctx.ui.setStatus?.("coach", "coach review");
  }

  async function disableReview(ctx: ExtensionContext, notify = false, reason: "accept" | "abort" | "session" = "session"): Promise<void> {
    const wasRescue = rescueInFlight;
    reviewing = false;
    digestJson = "";
    lastAttemptText = "";
    rejectCount = 0;
    rescueInFlight = false;
    capabilities.release("coach");
    restoreReviewClass();
    await restoreReviewModel(ctx);
    if (reason === "abort" && wasRescue) emptyRescues += 1;
    if (reason === "accept") {
      emptyRescues = 0;
      halted = false;
    }
    ctx.ui.setStatus?.("coach", latest ? "coached" : undefined);
    if (notify) ctx.ui.notify("Coach review ended. Browser tools restored.");
  }

  function injection(): string | undefined {
    if (reviewing && digestJson) {
      return `${COACH_INSTRUCTIONS}${digestJson}`;
    }
    if (!latest) return undefined;
    const trial =
      "\nThis STRATEGY is a trial loop. Try it until it is falsified. Record candidate_accepted, " +
      "candidate_rejected, or candidate_duplicate after every candidate. Clicks that return ok are not " +
      "progress. If the named route is falsified, stop — do not invent a second plan. Magpie will run " +
      "/coach again. Do not treat Do-not as covering lists the scout never tried. " +
      "Do not replace peek/observe with curl or a coder fetch script as the harvest loop. " +
      "If a page is a JS shell or a required field stays unknown, observe it.\n";
    const swap = latest.replacedPrevious
      ? "\nA new guideline replaces the previous one. Finish the current entity before switching loops.\n"
      : trial;
    return `${latest.rendered}${swap}`;
  }

  async function handleCoach(_args: string, ctx: ExtensionContext): Promise<boolean> {
    if (reviewing) {
      ctx.ui.notify("Coach review is already running.");
      return false;
    }
    if (!requestReviewClass()) {
      ctx.ui.notify(
        "Coach needs Pi thinking-level control for a stronger review class (COACH-12).",
        "error",
      );
      return false;
    }
    const modelError = await requestReviewModel(ctx);
    if (modelError) {
      restoreReviewClass();
      ctx.ui.notify(modelError, "error");
      return false;
    }
    const previous = latest;
    let compiled: CompiledDigest;
    try {
      compiled = await compileSessionDigest(options, previous, ctx, planSlice);
    } catch (error) {
      restoreReviewClass();
      await restoreReviewModel(ctx);
      ctx.ui.notify(`Could not compile digest: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    digestJson = compiled.json;
    enableReview(ctx);
    const modelId = (await options.models?.resolved("coach")) ?? undefined;
    const using = modelId && modelKey(ctx.model) === modelId ? modelId : undefined;
    ctx.ui.notify(
      using
        ? `Coach review: mutations off. Digest only. Model ${using} + thinking high for this turn.`
        : "Coach review: mutations off. Digest only. Thinking high for this turn.",
    );
    const content = `${COACH_INSTRUCTIONS}${compiled.json}`;
    if (pi.sendUserMessage) {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    } else {
      ctx.ui.notify("Coach review on. Send the digest as the next message.");
    }
    return true;
  }

  async function acceptArtifact(text: string, ctx: ExtensionContext): Promise<boolean> {
    if (!reviewing) return false;
    if (text === lastAttemptText) return false;
    lastAttemptText = text;
    try {
      const artifact = assertStrategyArtifact(text);
      const rendered = renderStrategyArtifact(artifact);
      persist({
        at: new Date().toISOString(),
        artifact,
        rendered,
        digestBytes: digestJson.length,
        artifactBytes: JSON.stringify(artifact).length,
        phase: "review",
        replacedPrevious: Boolean(latest),
      });
      await options.evidence.facts.mergeGoalFacts({ strategyArtifact: artifact });
      await disableReview(ctx, false, "accept");
      pi.sendMessage?.(
        {
          customType: "coach-artifact",
          content: rendered,
          display: true,
        },
        { triggerTurn: false },
      );
      ctx.ui.notify("Strategy artifact saved. Harvest sees the guideline, not the digest.");
      artifactListener?.(ctx);
      return true;
    } catch (error) {
      if (error instanceof StrategyArtifactError) {
        ctx.ui.notify(`Coach output rejected (${error.code}): ${error.message}`, "warning");
        rejectCount += 1;
        if (rejectCount <= COACH_RETRY_MAX && pi.sendUserMessage) {
          pi.sendUserMessage(
            `[COACH REVIEW]\nPrevious output was rejected (${error.code}): ${error.message}\n` +
              `Output one JSON object only:\n${STRATEGY_JSON_EXAMPLE}`,
            { deliverAs: "followUp" },
          );
        } else if (rejectCount > COACH_RETRY_MAX) {
          await disableReview(ctx, true, "abort");
        }
        return false;
      }
      throw error;
    }
  }

  pi.registerCommand(COACH_COMMAND, {
    description: "Review-phase coach: digest in, strategy guideline out (mutations off)",
    handler: async (args, ctx) => {
      await handleCoach(args, ctx);
    },
  });

  pi.on("context", (_event: unknown) => {
    if (!reviewing || !digestJson) return undefined;
    return {
      messages: [{ role: "user", content: `${COACH_INSTRUCTIONS}${digestJson}` }],
    };
  });

  pi.on("before_agent_start", () => {
    const content = injection();
    if (!content) return undefined;
    return {
      message: {
        customType: reviewing ? COACH_CONTEXT_TYPE : "coach-harvest-context",
        content,
        display: false,
      } satisfies CustomSessionMessage,
    };
  });

  pi.on("turn_end", async (event: unknown, ctxUnknown: unknown) => {
    if (!reviewing) return;
    const message = (event as { message?: unknown })?.message;
    if (!isAssistantMessage(message)) return;
    await acceptArtifact(assistantText(message), ctxUnknown as ExtensionContext);
  });

  pi.on("agent_end", async (event: unknown, ctxUnknown: unknown) => {
    if (!reviewing) return;
    const ctx = ctxUnknown as ExtensionContext;
    const messages = Array.isArray((event as { messages?: unknown[] })?.messages)
      ? (event as { messages: unknown[] }).messages
      : [];
    const lastAssistant = [...messages].reverse().find(isAssistantMessage);
    if (lastAssistant) await acceptArtifact(assistantText(lastAssistant), ctx);
  });

  pi.on("session_start", (_event: unknown, ctxUnknown: unknown) => {
    const ctx = ctxUnknown as ExtensionContext;
    const restored = restoreCheckpoint(ctx?.sessionManager?.getEntries?.() ?? []);
    if (restored) latest = restored;
    reviewing = false;
    digestJson = "";
    coachHeld = false;
    capabilities.release("coach");
    restoreReviewClass();
    ctx.ui.setStatus?.("coach", latest ? "coached" : undefined);
  });

  return {
    enabled: () => reviewing,
    injection,
    hasArtifact: () => Boolean(latest),
    startReview: (ctx) => handleCoach("", ctx),
    onArtifact(handler) {
      artifactListener = handler;
    },
    setPlanSlice(slice) {
      planSlice = { ...planSlice, ...slice };
    },
    setScoutEpoch(iso) {
      scoutEpoch = iso;
    },
    async hasScoutYield() {
      const events = (await options.evidence.ledger.read?.()) ?? [];
      return hasScoutYield(events, scoutEpoch);
    },
    async considerRescue(ctx) {
      if (halted) return "none";
      if (reviewing || !latest) return "none";
      let compiled: CompiledDigest;
      try {
        compiled = await compileSessionDigest(options, latest, ctx, planSlice);
      } catch {
        return "none";
      }
      const events = (await options.evidence.ledger.read?.()) ?? [];
      const since = events.filter((event) => {
        const ts = Date.parse(event.ts);
        const at = Date.parse(latest!.at);
        return !Number.isFinite(ts) || !Number.isFinite(at) || ts >= at;
      });
      const decision = magpieRescueDecision({
        siteActionsWithoutCandidateYield: siteActionsWithoutCandidateYield(since),
        navigationCycles: compiled.digest.navigationCycles.length,
        lostPlace: compiled.digest.lostPlace,
        wallMs: compiled.digest.wallMs,
        emptyRescues,
      });
      if (decision === "halt") {
        halted = true;
        ctx.ui.notify(
          "Harvest produced no yield after a rescue coach. Stopping for the operator.",
          "warning",
        );
        return "halted";
      }
      if (decision === "review") {
        rescueInFlight = true;
        const started = await handleCoach("", ctx);
        if (!started) rescueInFlight = false;
        return started ? "started" : "none";
      }
      return "none";
    },
  };
}
