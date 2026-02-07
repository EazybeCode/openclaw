// ============================================
// TENANT SYSTEM - Multi-Tenant Support for OpenClaw
// ============================================

import type { IncomingHttpHeaders } from "node:http";

/**
 * Surface types - where the chat is happening
 */
export type Surface =
  | "whatsapp-web"
  | "whatsapp-api"
  | "web"
  | "api"
  | "slack"
  | "teams"
  | "telegram"
  | "discord";

/**
 * Complete tenant context
 */
export interface TenantContext {
  organizationId: string;
  workspaceId: string;
  teamId: string;
  userId: string;
  surface: Surface;
  sessionId: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Scope levels for memory isolation
 */
export type ScopeLevel = "organization" | "workspace" | "team" | "user" | "customer";

/**
 * Validation result
 */
export interface TenantValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Get header value (handles string | string[] | undefined)
 */
function getHeaderValue(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key] || headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value as string | undefined;
}

/**
 * Extract tenant from HTTP request headers and body
 */
export function extractTenantFromRequest(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  body?: Record<string, unknown>,
): TenantContext {
  const safeBody = body || {};

  const getValue = (headerKey: string, bodyKey: string): string => {
    return getHeaderValue(headers, headerKey) || (safeBody[bodyKey] as string) || "";
  };

  const rawSurface = getValue("x-surface", "surface") || "api";
  const validSurfaces: Surface[] = [
    "whatsapp-web",
    "whatsapp-api",
    "web",
    "api",
    "slack",
    "teams",
    "telegram",
    "discord",
  ];
  const surface: Surface = validSurfaces.includes(rawSurface as Surface)
    ? (rawSurface as Surface)
    : "api";

  return {
    organizationId: getValue("x-org-id", "orgId"),
    workspaceId: getValue("x-workspace-id", "workspaceId"),
    teamId: getValue("x-team-id", "teamId"),
    userId: getValue("x-user-id", "userId"),
    surface,
    sessionId:
      (safeBody.sessionId as string) ||
      `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    customerId: (safeBody.customerId as string) || undefined,
    metadata: (safeBody.metadata as Record<string, unknown>) || undefined,
    timestamp: new Date(),
  };
}

/**
 * Validate tenant context has required fields
 */
export function validateTenant(tenant: TenantContext): TenantValidationResult {
  const errors: string[] = [];

  if (!tenant.organizationId?.trim()) {
    errors.push("Missing organization ID (x-org-id header or orgId in body)");
  }
  if (!tenant.workspaceId?.trim()) {
    errors.push("Missing workspace ID (x-workspace-id header or workspaceId in body)");
  }
  if (!tenant.teamId?.trim()) {
    errors.push("Missing team ID (x-team-id header or teamId in body)");
  }
  if (!tenant.userId?.trim()) {
    errors.push("Missing user ID (x-user-id header or userId in body)");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Create scope key for a specific level
 */
export function createScopeKey(
  tenant: TenantContext,
  level: ScopeLevel,
  customerId?: string,
): string {
  switch (level) {
    case "organization":
      return `org:${tenant.organizationId}`;
    case "workspace":
      return `ws:${tenant.organizationId}:${tenant.workspaceId}`;
    case "team":
      return `team:${tenant.organizationId}:${tenant.workspaceId}:${tenant.teamId}`;
    case "user":
      return `user:${tenant.organizationId}:${tenant.userId}`;
    case "customer":
      const custId = customerId || tenant.customerId;
      if (!custId) throw new Error("Customer ID required for customer-level scope");
      return `cust:${tenant.organizationId}:${custId}`;
    default:
      throw new Error(`Unknown scope level: ${level}`);
  }
}

/**
 * Get all scope keys for a tenant (most specific to least specific)
 */
export function getAllScopeKeys(tenant: TenantContext): string[] {
  const scopes: string[] = [];

  if (tenant.customerId) {
    scopes.push(createScopeKey(tenant, "customer"));
  }
  scopes.push(createScopeKey(tenant, "user"));
  scopes.push(createScopeKey(tenant, "team"));
  scopes.push(createScopeKey(tenant, "workspace"));
  scopes.push(createScopeKey(tenant, "organization"));

  return scopes;
}

/**
 * Format tenant as display string
 */
export function tenantToString(tenant: TenantContext): string {
  return `${tenant.userId}@${tenant.teamId}.${tenant.workspaceId}.${tenant.organizationId} [${tenant.surface}]`;
}

/**
 * Build system prompt context from tenant
 */
export function buildTenantSystemContext(tenant: TenantContext): string {
  const context = `You are an autonomous Revenue Intelligence Agent for Eazybe.

## Tenant Context
- Organization ID: ${tenant.organizationId}
- Workspace ID: ${tenant.workspaceId}
- Team: ${tenant.teamId}
- User: ${tenant.userId}
- Surface: ${tenant.surface}
${tenant.customerId ? `- Customer: ${tenant.customerId}\n` : ""}

## Available Tools (use exec command)

**Team API** - Map names to user_ids (use FIRST for comparisons):
\`exec python3 /app/skills/eazybe-team/scripts/team.py --org-id "${tenant.workspaceId}" find "name"\`

**BigQuery** - WhatsApp analytics:
\`exec python3 /app/skills/bigquery-mcp/scripts/bigquery.py query "SELECT ... FROM waba-454907.whatsapp_analytics.daily_performance_summary WHERE org_id='${tenant.organizationId}' ..."\`
- Columns: user_id, org_id, activity_date, agent_message_count, contact_message_count, avg_agent_response_time_seconds

**HubSpot** - CRM data:
\`exec python3 /app/skills/hubspot-mcp/scripts/hubspot.py --org-id "${tenant.organizationId}" --workspace-id "${tenant.workspaceId}" call search_crm_objects --args '{"objectType":"DEAL"}'\`

## Critical Rules

1. **NEVER make up information** - always use tools
2. **BigQuery**: ALWAYS include WHERE org_id='${tenant.organizationId}'
3. **Comparisons**: First get user_ids from Team API, then query BigQuery
4. **Be specific**: Include numbers, create tables for comparisons
`;

  return context;
}

/**
 * Check if tenant headers are present in request
 */
export function hasTenantHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): boolean {
  return !!(
    getHeaderValue(headers, "x-org-id") ||
    getHeaderValue(headers, "x-workspace-id") ||
    getHeaderValue(headers, "x-user-id")
  );
}
