// ============================================
// PROACTIVE INTELLIGENCE - Evaluation Engine
// ============================================

import { Cron } from "croner";
import type { TenantContext } from "../tenant/index.js";
import type { ProactiveTrigger, ProactiveEvalResult, ProactiveCondition } from "./types.js";
import { getTriggers, getLastFiredMs, recordTriggerFired } from "./store.js";

/** How far back to look for a cron match (30 minutes). */
const TIME_WINDOW_MS = 30 * 60 * 1000;

export interface EvalContext {
  userMessage: string;
  toolsUsed: string[];
  responseText: string;
  nowMs: number;
}

/**
 * Evaluate all triggers for a tenant and return results.
 * Called after each response inside the behavior hook.
 */
export async function evaluateTriggers(
  tenant: TenantContext,
  ctx: EvalContext,
): Promise<ProactiveEvalResult[]> {
  const triggers = await getTriggers(tenant);
  console.log(`[proactive-engine] Evaluating ${triggers.length} triggers`);

  const results: ProactiveEvalResult[] = [];

  for (const trigger of triggers) {
    try {
      const result = await evaluateOne(trigger, tenant, ctx);
      results.push(result);
    } catch (err) {
      console.error(`[proactive-engine] Error evaluating trigger ${trigger.triggerId}:`, err);
      results.push({
        triggerId: trigger.triggerId,
        fired: false,
        skipReason: "evaluation_error",
      });
    }
  }

  return results;
}

async function evaluateOne(
  trigger: ProactiveTrigger,
  tenant: TenantContext,
  ctx: EvalContext,
): Promise<ProactiveEvalResult> {
  const { triggerId } = trigger;

  // 1. Check enabled
  if (!trigger.enabled) {
    return { triggerId, fired: false, skipReason: "disabled" };
  }

  // 2. Check cooldown
  const lastFired = await getLastFiredMs(triggerId, tenant);
  if (lastFired > 0 && ctx.nowMs - lastFired < trigger.cooldownMs) {
    return { triggerId, fired: false, skipReason: "cooldown" };
  }

  // 3. Evaluate condition
  const conditionMet = checkCondition(trigger.condition, ctx);
  if (!conditionMet) {
    return { triggerId, fired: false, skipReason: "condition_not_met" };
  }

  // 4. Execute action → produce message
  const message = executeAction(trigger);

  // 5. Record firing
  await recordTriggerFired(triggerId, tenant);

  console.log(`[proactive-engine] Trigger FIRED: ${triggerId}`);

  return { triggerId, fired: true, message, delivery: trigger.delivery };
}

function checkCondition(condition: ProactiveCondition, ctx: EvalContext): boolean {
  switch (condition.type) {
    case "time":
      return checkTimeCondition(condition.cron, condition.tz, ctx.nowMs);
    case "event":
      return checkEventCondition(condition.pattern, ctx.userMessage);
    case "data":
      return checkDataCondition(
        condition.requiredTools,
        condition.responsePattern,
        ctx.toolsUsed,
        ctx.responseText,
      );
  }
}

/**
 * Check if a cron schedule would have fired within the last TIME_WINDOW_MS.
 * We look backwards from `nowMs` to see if a cron tick falls in the window.
 */
function checkTimeCondition(cron: string, tz: string | undefined, nowMs: number): boolean {
  try {
    const job = new Cron(cron, {
      timezone: tz?.trim() || undefined,
      catch: false,
    });

    // Find the previous run from now
    const windowStart = new Date(nowMs - TIME_WINDOW_MS);
    const next = job.nextRun(windowStart);

    if (!next) return false;

    // If the next run after windowStart falls before now, the cron would have fired
    return next.getTime() <= nowMs;
  } catch (err) {
    console.warn(`[proactive-engine] Invalid cron expression "${cron}":`, err);
    return false;
  }
}

/**
 * Check if user message matches the event pattern.
 */
function checkEventCondition(pattern: string, userMessage: string): boolean {
  try {
    const re = new RegExp(pattern, "i");
    return re.test(userMessage);
  } catch {
    console.warn(`[proactive-engine] Invalid event pattern: ${pattern}`);
    return false;
  }
}

/**
 * Check if relevant tools were used AND response matches the data pattern.
 */
function checkDataCondition(
  requiredTools: string[],
  responsePattern: string,
  toolsUsed: string[],
  responseText: string,
): boolean {
  // At least one required tool must have been used
  const toolUsed = requiredTools.some((t) => toolsUsed.includes(t));
  if (!toolUsed) return false;

  try {
    const re = new RegExp(responsePattern, "i");
    return re.test(responseText);
  } catch {
    console.warn(`[proactive-engine] Invalid data pattern: ${responsePattern}`);
    return false;
  }
}

/**
 * Execute the trigger action and return a message (or undefined for log-only).
 */
function executeAction(trigger: ProactiveTrigger): string | undefined {
  const { action } = trigger;

  switch (action.kind) {
    case "send_reminder":
      return action.messageTemplate;

    case "run_skill":
      return `${action.messageTemplate} (Suggested action: use \`${action.skillName}\`)`;

    case "log_event":
      console.log(`[proactive-event] ${action.eventLabel}: ${action.logMessage ?? trigger.name}`);
      return undefined;
  }
}
