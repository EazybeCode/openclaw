// ============================================
// PROACTIVE INTELLIGENCE - Lazy Default Seeding
// ============================================

import type { TenantContext } from "../tenant/index.js";
import { DEFAULT_TRIGGERS } from "./defaults.js";
import { getTriggers, storeTrigger } from "./store.js";

/** Tracks orgs that have already been checked this process. */
const seededOrgs = new Set<string>();

/**
 * Ensure default triggers exist for the tenant's organization.
 * Idempotent: only seeds on the first call per org per process.
 */
export async function ensureDefaultTriggers(tenant: TenantContext): Promise<void> {
  const orgKey = tenant.organizationId;

  if (seededOrgs.has(orgKey)) return;
  seededOrgs.add(orgKey);

  try {
    const existing = await getTriggers(tenant);
    const existingIds = new Set(existing.map((t) => t.triggerId));

    const toSeed = DEFAULT_TRIGGERS.filter((t) => !existingIds.has(t.triggerId));

    if (toSeed.length === 0) {
      console.log(`[proactive-init] Defaults already present for org=${orgKey}`);
      return;
    }

    console.log(`[proactive-init] Seeding ${toSeed.length} default triggers for org=${orgKey}...`);

    for (const trigger of toSeed) {
      await storeTrigger(trigger, tenant);
    }

    console.log(`[proactive-init] Done seeding defaults for org=${orgKey}`);
  } catch (err) {
    // Remove from set so it retries next time
    seededOrgs.delete(orgKey);
    console.error(`[proactive-init] Failed to seed defaults for org=${orgKey}:`, err);
  }
}
