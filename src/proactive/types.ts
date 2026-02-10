// ============================================
// PROACTIVE INTELLIGENCE - Type Definitions
// ============================================

export type ConditionType = "time" | "event" | "data";

// --- Conditions ---

export interface TimeCondition {
  type: "time";
  /** Cron expression (e.g. "0 9 * * MON") */
  cron: string;
  /** IANA timezone (e.g. "Asia/Kolkata") */
  tz?: string;
}

export interface EventCondition {
  type: "event";
  /** Event name for matching (e.g. "negative_feedback") */
  eventName: string;
  /** Regex pattern to match against user message */
  pattern: string;
}

export interface DataCondition {
  type: "data";
  /** Named data check (e.g. "stale_deals") */
  checkName: string;
  /** Tool names that must have been used */
  requiredTools: string[];
  /** Regex pattern to match against response text */
  responsePattern: string;
}

export type ProactiveCondition = TimeCondition | EventCondition | DataCondition;

// --- Actions ---

export interface SendReminderAction {
  kind: "send_reminder";
  /** Message template to append to the response */
  messageTemplate: string;
}

export interface RunSkillAction {
  kind: "run_skill";
  /** Suggested tool/skill name */
  skillName: string;
  /** Suggestion message */
  messageTemplate: string;
}

export interface LogEventAction {
  kind: "log_event";
  /** Event label for structured logging */
  eventLabel: string;
  /** Optional message (not appended to response) */
  logMessage?: string;
}

export type ProactiveAction = SendReminderAction | RunSkillAction | LogEventAction;

// --- Trigger ---

export interface ProactiveTrigger {
  triggerId: string;
  name: string;
  description: string;
  enabled: boolean;
  condition: ProactiveCondition;
  action: ProactiveAction;
  /** Minimum milliseconds between firings */
  cooldownMs: number;
  /** Scope: "organization" triggers apply to all users in the org */
  scope: "organization" | "user";
  /** Optional channel delivery target — when set, the message is delivered via the outbound channel pipeline */
  delivery?: { channel: string; to?: string };
}

// --- Evaluation Result ---

export interface ProactiveEvalResult {
  triggerId: string;
  fired: boolean;
  skipReason?: string;
  /** Message to append to response (only when fired) */
  message?: string;
  /** Delivery intent passed through from the trigger (only when fired + trigger has delivery) */
  delivery?: { channel: string; to?: string };
}
