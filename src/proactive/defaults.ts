// ============================================
// PROACTIVE INTELLIGENCE - Default Trigger Templates
// ============================================

import type { ProactiveTrigger } from "./types.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SIX_DAYS_MS = 6 * ONE_DAY_MS;

export const DEFAULT_TRIGGERS: readonly ProactiveTrigger[] = [
  {
    triggerId: "stale-deals-reminder",
    name: "Stale Deals Reminder",
    description:
      "Reminds the user about stale or inactive deals when CRM data is queried and the response mentions stale/inactive patterns.",
    enabled: true,
    condition: {
      type: "data",
      checkName: "stale_deals",
      requiredTools: ["search_crm_objects", "query_bigquery"],
      responsePattern: "\\b(stale|inactive|no activity|dormant|stuck|aging)\\b",
    },
    action: {
      kind: "send_reminder",
      messageTemplate:
        "Some deals in your pipeline appear stale or inactive. Consider reviewing and updating their status, or reaching out to the contacts to re-engage.",
    },
    cooldownMs: ONE_DAY_MS,
    scope: "organization",
    delivery: { channel: "last" },
  },
  {
    triggerId: "negative-feedback-alert",
    name: "Negative Feedback Alert",
    description: "Logs an alert when the user expresses frustration or negative sentiment.",
    enabled: true,
    condition: {
      type: "event",
      eventName: "negative_feedback",
      pattern: "\\b(angry|frustrated|terrible|worst|hate|unacceptable|disappointed|useless)\\b",
    },
    action: {
      kind: "log_event",
      eventLabel: "negative_sentiment_detected",
      logMessage: "User expressed negative sentiment — consider escalation or follow-up.",
    },
    cooldownMs: FOUR_HOURS_MS,
    scope: "organization",
    delivery: { channel: "last" },
  },
  {
    triggerId: "weekly-pipeline-summary",
    name: "Weekly Pipeline Summary",
    description: "Suggests a weekly pipeline review every Monday morning (9 AM IST).",
    enabled: true,
    condition: {
      type: "time",
      cron: "0 9 * * MON",
      tz: "Asia/Kolkata",
    },
    action: {
      kind: "send_reminder",
      messageTemplate:
        "It's Monday — a great time to review your sales pipeline. Ask me to summarize your pipeline status, highlight stale deals, or compare team performance this week.",
    },
    cooldownMs: SIX_DAYS_MS,
    scope: "organization",
    delivery: { channel: "last" },
  },
];
