// ============================================
// PROACTIVE INTELLIGENCE - Mem0-backed Storage
// ============================================

import type { TenantContext } from "../tenant/index.js";
import type { ProactiveTrigger } from "./types.js";
import { getMem0Client } from "../memory/mem0-client.js";

const TAG_TRIGGER = "proactive_trigger";
const TAG_FIRED = "proactive_fired";

/**
 * Store a proactive trigger in Mem0 (organization scope).
 */
export async function storeTrigger(
  trigger: ProactiveTrigger,
  tenant: TenantContext,
): Promise<boolean> {
  const client = getMem0Client();
  if (!client) {
    console.warn("[proactive-store] Mem0 client not available");
    return false;
  }

  const content = `Proactive trigger: ${trigger.name} — ${trigger.description}`;

  try {
    await client.addMemory(content, {
      tenant,
      scopeLevel: "organization",
      metadata: {
        type: TAG_TRIGGER,
        trigger_id: trigger.triggerId,
        trigger_data: JSON.stringify(trigger),
      },
    });
    console.log(`[proactive-store] Stored trigger: ${trigger.triggerId}`);
    return true;
  } catch (err) {
    console.error(`[proactive-store] Failed to store trigger ${trigger.triggerId}:`, err);
    return false;
  }
}

/**
 * Retrieve all proactive triggers for a tenant's organization.
 * Uses semantic search + client-side metadata filtering.
 */
export async function getTriggers(tenant: TenantContext): Promise<ProactiveTrigger[]> {
  const client = getMem0Client();
  if (!client) {
    return [];
  }

  try {
    // Semantic search for trigger configurations
    const results = await client.searchMemories("proactive trigger configuration", {
      tenant,
      scopeLevels: ["organization"],
      limit: 50,
    });

    const triggers: ProactiveTrigger[] = [];
    for (const r of results) {
      if (r.metadata?.type !== TAG_TRIGGER) continue;
      const raw = r.metadata.trigger_data;
      if (typeof raw !== "string") continue;
      try {
        triggers.push(JSON.parse(raw) as ProactiveTrigger);
      } catch {
        console.warn(`[proactive-store] Invalid trigger_data in memory ${r.id}`);
      }
    }

    if (triggers.length > 0) return triggers;

    // Fallback: getMemories at org scope and filter
    const memories = await client.getMemories(tenant, "organization");
    for (const m of memories) {
      if (m.metadata?.type !== TAG_TRIGGER) continue;
      const raw = m.metadata.trigger_data;
      if (typeof raw !== "string") continue;
      try {
        triggers.push(JSON.parse(raw) as ProactiveTrigger);
      } catch {
        console.warn(`[proactive-store] Invalid trigger_data in memory ${m.id}`);
      }
    }

    return triggers;
  } catch (err) {
    console.error("[proactive-store] Failed to get triggers:", err);
    return [];
  }
}

/**
 * Record that a trigger fired (for cooldown tracking).
 */
export async function recordTriggerFired(triggerId: string, tenant: TenantContext): Promise<void> {
  const client = getMem0Client();
  if (!client) return;

  const content = `Proactive trigger fired: ${triggerId} at ${new Date().toISOString()}`;

  try {
    await client.addMemory(content, {
      tenant,
      scopeLevel: "organization",
      metadata: {
        type: TAG_FIRED,
        trigger_id: triggerId,
        fired_at: Date.now(),
      },
    });
  } catch (err) {
    console.error(`[proactive-store] Failed to record firing for ${triggerId}:`, err);
  }
}

/**
 * Get the last time a trigger fired (ms epoch), or 0 if never.
 */
export async function getLastFiredMs(triggerId: string, tenant: TenantContext): Promise<number> {
  const client = getMem0Client();
  if (!client) return 0;

  try {
    const results = await client.searchMemories(`trigger fired ${triggerId}`, {
      tenant,
      scopeLevels: ["organization"],
      limit: 5,
    });

    let latest = 0;
    for (const r of results) {
      if (r.metadata?.type !== TAG_FIRED) continue;
      if (r.metadata.trigger_id !== triggerId) continue;
      const firedAt = Number(r.metadata.fired_at) || 0;
      if (firedAt > latest) latest = firedAt;
    }

    return latest;
  } catch (err) {
    console.error(`[proactive-store] Failed to get last fired for ${triggerId}:`, err);
    return 0;
  }
}
