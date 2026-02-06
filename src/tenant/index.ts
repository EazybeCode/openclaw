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
  let context = `## Tenant Context\n`;
  context += `- Organization: ${tenant.organizationId}\n`;
  context += `- Workspace: ${tenant.workspaceId}\n`;
  context += `- Team: ${tenant.teamId}\n`;
  context += `- User: ${tenant.userId}\n`;
  context += `- Surface: ${tenant.surface}\n`;

  if (tenant.customerId) {
    context += `- Customer: ${tenant.customerId}\n`;
  }

  context += `\nYou are assisting this specific user within their organization context.\n`;

  // Add available data sources for analytics
  context += `\n## Available Data Sources\n`;
  context += `You have access to WhatsApp Analytics data via the bigquery-mcp skill.\n`;
  context += `\n### Tables in whatsapp_analytics dataset:\n`;
  context += `- **daily_performance_summary**: Daily agent metrics (activity_date, user_id, avg_agent_response_time_seconds, time_to_first_response_seconds, agent_message_count, contact_message_count)\n`;
  context += `- **conversation_summary**: Per-chat metrics (average_response_time, first_response_time, analytics.messages_sent, analytics.messages_received)\n`;
  context += `\n### When to use BigQuery:\n`;
  context += `- Questions about response times, performance metrics, message counts\n`;
  context += `- Agent/rep performance comparisons and rankings\n`;
  context += `- Daily/weekly analytics trends\n`;
  context += `\nUse the bigquery-mcp skill with execute_sql to query this data.\n`;

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
