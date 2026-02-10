// ============================================
// PROACTIVE INTELLIGENCE - Public API
// ============================================

export { evaluateTriggers } from "./engine.js";
export type { EvalContext } from "./engine.js";
export { storeTrigger, getTriggers } from "./store.js";
export { ensureDefaultTriggers } from "./init.js";
export type {
  ConditionType,
  ProactiveCondition,
  TimeCondition,
  EventCondition,
  DataCondition,
  ProactiveAction,
  SendReminderAction,
  RunSkillAction,
  LogEventAction,
  ProactiveTrigger,
  ProactiveEvalResult,
} from "./types.js";
