// ============================================
// MEM0 CLIENT - Cloud Memory with Tenant Scoping
// ============================================

import type { TenantContext, ScopeLevel } from "../tenant/index.js";
import { createScopeKey, getAllScopeKeys } from "../tenant/index.js";

// Mem0 API endpoints - v1 for add, v2 for search (per documentation)
const MEM0_API_V1 = "https://api.mem0.ai/v1";
const MEM0_API_V2 = "https://api.mem0.ai/v2";

export interface Mem0Config {
  apiKey: string;
  orgId?: string;
}

export interface Mem0Memory {
  id: string;
  memory: string;
  user_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface Mem0SearchResult {
  id: string;
  memory: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface Mem0AddOptions {
  tenant: TenantContext;
  scopeLevel?: ScopeLevel;
  metadata?: Record<string, unknown>;
}

export interface Mem0SearchOptions {
  tenant: TenantContext;
  scopeLevels?: ScopeLevel[];
  limit?: number;
}

function getEnvConfig(): Mem0Config | null {
  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    orgId: process.env.MEM0_ORG_ID,
  };
}

export class Mem0Client {
  private apiKey: string;
  private orgId?: string;

  constructor(config?: Mem0Config) {
    const resolvedConfig = config ?? getEnvConfig();
    if (!resolvedConfig?.apiKey) {
      throw new Error("MEM0_API_KEY is required");
    }
    this.apiKey = resolvedConfig.apiKey;
    this.orgId = resolvedConfig.orgId;
  }

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    apiVersion: "v1" | "v2" = "v1",
  ): Promise<T> {
    const baseUrl = apiVersion === "v2" ? MEM0_API_V2 : MEM0_API_V1;
    const url = `${baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    console.log(`[mem0] API ${method} ${url}`);
    if (body) {
      console.log(`[mem0] Request body: ${JSON.stringify(body).substring(0, 500)}`);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseText = await response.text();
    console.log(`[mem0] Response ${response.status}: ${responseText.substring(0, 500)}`);

    if (!response.ok) {
      throw new Error(`Mem0 API error: ${response.status} - ${responseText}`);
    }

    try {
      return JSON.parse(responseText) as T;
    } catch {
      return {} as T;
    }
  }

  async addMemory(content: string, options: Mem0AddOptions): Promise<Mem0Memory[]> {
    const { tenant, scopeLevel = "user", metadata = {} } = options;
    const scopeKey = createScopeKey(tenant, scopeLevel);
    const agentId = this.orgId || "openclaw";

    console.log(`[mem0] ========== ADD MEMORY ==========`);
    console.log(`[mem0] Content: "${content.substring(0, 100)}..."`);
    console.log(`[mem0] user_id: ${scopeKey}`);
    console.log(`[mem0] agent_id: ${agentId}`);
    console.log(`[mem0] scope: ${scopeLevel}`);
    console.log(`[mem0] org: ${tenant.organizationId}`);

    const payload = {
      messages: [{ role: "user", content }],
      user_id: scopeKey,
      agent_id: agentId,
      // Use sync mode for immediate confirmation (per Mem0 docs)
      infer: true,
      metadata: {
        ...metadata,
        tenant_org: tenant.organizationId,
        tenant_workspace: tenant.workspaceId,
        tenant_team: tenant.teamId,
        tenant_user: tenant.userId,
        scope_level: scopeLevel,
        scope_key: scopeKey,
        surface: tenant.surface,
        customer_id: tenant.customerId,
      },
    };

    const result = await this.request<{ results: Mem0Memory[] }>(
      "/memories/",
      "POST",
      payload,
      "v1",
    );

    console.log(`[mem0] Add result: ${result.results?.length || 0} memories created`);
    if (result.results) {
      for (const mem of result.results) {
        console.log(`[mem0] - ID: ${mem.id}, Memory: "${mem.memory?.substring(0, 50)}..."`);
      }
    }

    return result.results || [];
  }

  async searchMemories(query: string, options: Mem0SearchOptions): Promise<Mem0SearchResult[]> {
    const { tenant, scopeLevels, limit = 10 } = options;
    const scopesToSearch = scopeLevels || this.getDefaultScopeLevels(tenant);
    const allResults: Mem0SearchResult[] = [];

    console.log(`[mem0] ========== SEARCH MEMORIES ==========`);
    console.log(`[mem0] Query: "${query.substring(0, 50)}..."`);
    console.log(`[mem0] Scopes to search: ${scopesToSearch.join(", ")}`);

    for (const scopeLevel of scopesToSearch) {
      try {
        const scopeKey = createScopeKey(tenant, scopeLevel);
        const agentId = this.orgId || "openclaw";

        // V2 API requires filters object - user_id and agent_id go inside filters
        const payload = {
          query,
          top_k: Math.ceil(limit / scopesToSearch.length),
          filters: {
            user_id: scopeKey,
            agent_id: agentId,
          },
        };

        console.log(`[mem0] Search scope ${scopeLevel}: user_id=${scopeKey}`);

        // Use V2 API for search - Mem0 may return array directly OR { results: [...] }
        const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
          "/memories/search/",
          "POST",
          payload,
          "v2",
        );

        const results = Array.isArray(rawResult)
          ? rawResult
          : (rawResult as { results?: Mem0SearchResult[] }).results || [];

        console.log(`[mem0] Scope ${scopeLevel} returned ${results.length} results`);

        if (results.length > 0) {
          allResults.push(
            ...results.map((r) => ({
              ...r,
              metadata: { ...r.metadata, scope_level: scopeLevel },
            })),
          );
        }
      } catch (err) {
        console.warn(`[mem0] Search failed for scope ${scopeLevel}:`, err);
      }
    }

    console.log(`[mem0] Total results across all scopes: ${allResults.length}`);
    return allResults.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Search for learnings by specific scope key (user-level or any scope)
  // V2 API REQUIRES filters object - user_id/agent_id go inside filters
  async searchLearningsByScope(
    query: string,
    scopeKey: string,
    orgId: string,
    limit: number = 5,
  ): Promise<Mem0SearchResult[]> {
    const agentId = this.orgId || "openclaw";

    console.log(`[mem0] ========== SEARCH LEARNINGS BY SCOPE ==========`);
    console.log(`[mem0] Query: "${query}"`);
    console.log(`[mem0] Scope Key: ${scopeKey}`);
    console.log(`[mem0] Org ID: ${orgId}`);
    console.log(`[mem0] Agent ID: ${agentId}`);

    // Try V2 API with user_id filter
    try {
      const payload = {
        query,
        top_k: limit * 3,
        filters: {
          user_id: scopeKey,
          agent_id: agentId,
        },
      };

      const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v2",
      );

      const results = Array.isArray(rawResult)
        ? rawResult
        : (rawResult as { results?: Mem0SearchResult[] }).results || [];

      console.log(`[mem0] Scope search returned ${results.length} results`);

      // Filter for learnings from this org
      const learnings = results.filter(
        (r) => r.metadata?.type === "learning" && r.metadata?.tenant_org === orgId,
      );

      if (learnings.length > 0) {
        console.log(`[mem0] Found ${learnings.length} learnings for scope ${scopeKey}`);
        return learnings.slice(0, limit);
      }

      // Return all results if no specific learnings found
      if (results.length > 0) {
        const orgResults = results.filter((r) => r.metadata?.tenant_org === orgId);
        return orgResults.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[mem0] Scope search failed:`, err);
    }

    // Fallback: V1 API
    try {
      const payload = {
        query,
        user_id: scopeKey,
        agent_id: agentId,
        limit: limit * 3,
      };

      const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v1",
      );

      const results = Array.isArray(rawResult)
        ? rawResult
        : (rawResult as { results?: Mem0SearchResult[] }).results || [];

      const learnings = results.filter(
        (r) => r.metadata?.type === "learning" && r.metadata?.tenant_org === orgId,
      );

      return learnings.slice(0, limit);
    } catch (err) {
      console.warn(`[mem0] V1 scope search failed:`, err);
    }

    return [];
  }

  // Search for org-level learnings using metadata filters
  // V2 API REQUIRES filters object - user_id/agent_id go inside filters
  async searchLearningsByOrg(
    query: string,
    orgId: string,
    limit: number = 5,
  ): Promise<Mem0SearchResult[]> {
    const agentId = this.orgId || "openclaw";
    const scopeKey = `org${orgId}`; // Match the format used when storing

    console.log(`[mem0] ========== SEARCH LEARNINGS ==========`);
    console.log(`[mem0] Query: "${query}"`);
    console.log(`[mem0] Org ID: ${orgId}`);
    console.log(`[mem0] Scope Key: ${scopeKey}`);
    console.log(`[mem0] Agent ID: ${agentId}`);

    // Strategy 1: V2 API with user_id and agent_id in filters
    try {
      console.log(`[mem0] Strategy 1: V2 API with filters object`);

      const payload = {
        query,
        top_k: limit * 3,
        filters: {
          user_id: scopeKey,
          agent_id: agentId,
        },
      };

      // Mem0 may return array directly OR { results: [...] }
      const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v2",
      );

      const results = Array.isArray(rawResult)
        ? rawResult
        : (rawResult as { results?: Mem0SearchResult[] }).results || [];
      console.log(`[mem0] Strategy 1 returned ${results.length} results`);

      for (const r of results) {
        console.log(
          `[mem0] Result: "${r.memory?.substring(0, 60)}..." score=${r.score} type=${r.metadata?.type}`,
        );
      }

      // Filter for learnings
      const learnings = results.filter((r) => r.metadata?.type === "learning");
      if (learnings.length > 0) {
        console.log(`[mem0] Found ${learnings.length} learnings`);
        return learnings.slice(0, limit);
      }

      if (results.length > 0) {
        console.log(`[mem0] No learnings metadata, returning all ${results.length} results`);
        return results.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[mem0] Strategy 1 failed:`, err);
    }

    // Strategy 2: V2 API with AND filter for user_id and agent_id
    try {
      console.log(`[mem0] Strategy 2: V2 API with AND filter`);

      const payload = {
        query,
        top_k: limit * 3,
        filters: {
          AND: [{ user_id: scopeKey }, { agent_id: agentId }],
        },
      };

      // Mem0 may return array directly OR { results: [...] }
      const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v2",
      );

      const results = Array.isArray(rawResult)
        ? rawResult
        : (rawResult as { results?: Mem0SearchResult[] }).results || [];
      console.log(`[mem0] Strategy 2 returned ${results.length} results`);

      for (const r of results) {
        console.log(`[mem0] Result: "${r.memory?.substring(0, 60)}..." score=${r.score}`);
      }

      const learnings = results.filter((r) => r.metadata?.type === "learning");
      if (learnings.length > 0) {
        return learnings.slice(0, limit);
      }
      if (results.length > 0) {
        return results.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[mem0] Strategy 2 failed:`, err);
    }

    // Strategy 3: V2 API with agent_id only, client-side user filtering
    try {
      console.log(`[mem0] Strategy 3: V2 API with agent_id filter, client-side filtering`);

      const payload = {
        query,
        top_k: 50,
        filters: {
          agent_id: agentId,
        },
      };

      // Mem0 may return array directly OR { results: [...] }
      const rawResult = await this.request<Mem0SearchResult[] | { results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v2",
      );

      // Handle both response formats
      const results = Array.isArray(rawResult)
        ? rawResult
        : (rawResult as { results?: Mem0SearchResult[] }).results || [];
      console.log(`[mem0] Strategy 3 returned ${results.length} total results`);

      for (const r of results.slice(0, 10)) {
        console.log(
          `[mem0] Result: "${r.memory?.substring(0, 60)}..." type=${r.metadata?.type} org=${r.metadata?.tenant_org}`,
        );
      }

      // Filter for learnings from this org
      const filtered = results.filter(
        (r) => r.metadata?.type === "learning" && r.metadata?.tenant_org === orgId,
      );

      if (filtered.length > 0) {
        console.log(`[mem0] Found ${filtered.length} learnings after client-side filtering`);
        return filtered.slice(0, limit);
      }

      // Also check for any results matching this org
      const orgResults = results.filter((r) => r.metadata?.tenant_org === orgId);
      if (orgResults.length > 0) {
        console.log(`[mem0] Found ${orgResults.length} org results after filtering`);
        return orgResults.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[mem0] Strategy 3 failed:`, err);
    }

    // Strategy 4: V1 API fallback (doesn't require filters object)
    try {
      console.log(`[mem0] Strategy 4: V1 API fallback`);

      const payload = {
        query,
        user_id: scopeKey,
        agent_id: agentId,
        limit: limit * 3,
      };

      const result = await this.request<{ results: Mem0SearchResult[] }>(
        "/memories/search/",
        "POST",
        payload,
        "v1",
      );

      const results = result.results || [];
      console.log(`[mem0] Strategy 4 (V1) returned ${results.length} results`);

      for (const r of results) {
        console.log(`[mem0] Result: "${r.memory?.substring(0, 60)}..." type=${r.metadata?.type}`);
      }

      if (results.length > 0) {
        const learnings = results.filter((r) => r.metadata?.type === "learning");
        return learnings.length > 0 ? learnings.slice(0, limit) : results.slice(0, limit);
      }
    } catch (err) {
      console.warn(`[mem0] Strategy 4 failed:`, err);
    }

    console.log(`[mem0] All strategies exhausted, no learnings found`);
    return [];
  }

  async getMemories(tenant: TenantContext, scopeLevel: ScopeLevel = "user"): Promise<Mem0Memory[]> {
    const scopeKey = createScopeKey(tenant, scopeLevel);
    const agentId = this.orgId || "openclaw";

    console.log(`[mem0] ========== GET MEMORIES ==========`);
    console.log(`[mem0] Scope: ${scopeLevel}`);
    console.log(`[mem0] Scope Key: ${scopeKey}`);
    console.log(`[mem0] Agent ID: ${agentId}`);

    // Try without agent_id filter first (Mem0 might not require it for GET)
    const urlWithoutAgent = `/memories/?user_id=${encodeURIComponent(scopeKey)}`;
    const urlWithAgent = `/memories/?user_id=${encodeURIComponent(scopeKey)}&agent_id=${encodeURIComponent(agentId)}`;

    try {
      const result = await this.request<{ results: Mem0Memory[] }>(
        urlWithoutAgent,
        "GET",
        undefined,
        "v1",
      );
      console.log(`[mem0] GET (no agent filter): ${result.results?.length || 0} results`);
      if (result.results && result.results.length > 0) {
        for (const mem of result.results.slice(0, 5)) {
          console.log(`[mem0] - "${mem.memory?.substring(0, 50)}..." type=${mem.metadata?.type}`);
        }
        return result.results;
      }
    } catch (err) {
      console.log(`[mem0] GET without agent_id failed, trying with agent_id`);
    }

    // Fallback to with agent_id
    const result = await this.request<{ results: Mem0Memory[] }>(
      urlWithAgent,
      "GET",
      undefined,
      "v1",
    );
    console.log(`[mem0] GET (with agent filter): ${result.results?.length || 0} results`);
    if (result.results) {
      for (const mem of result.results.slice(0, 5)) {
        console.log(`[mem0] - "${mem.memory?.substring(0, 50)}..." type=${mem.metadata?.type}`);
      }
    }
    return result.results || [];
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.request(`/memories/${memoryId}/`, "DELETE");
  }

  getTenantScopeKeys(tenant: TenantContext): string[] {
    return getAllScopeKeys(tenant);
  }

  private getDefaultScopeLevels(tenant: TenantContext): ScopeLevel[] {
    const levels: ScopeLevel[] = ["user", "team", "workspace", "organization"];
    if (tenant.customerId) {
      levels.unshift("customer");
    }
    return levels;
  }
}

let mem0Instance: Mem0Client | null = null;

export function getMem0Client(): Mem0Client | null {
  if (!mem0Instance) {
    try {
      mem0Instance = new Mem0Client();
    } catch {
      return null;
    }
  }
  return mem0Instance;
}

export async function buildMemoryContext(
  query: string,
  tenant: TenantContext,
  limit: number = 5,
): Promise<string> {
  const client = getMem0Client();
  if (!client) {
    return "";
  }

  try {
    const memories = await client.searchMemories(query, { tenant, limit });

    if (memories.length === 0) {
      return "";
    }

    let context = "## Relevant Memories\n";
    context += "The following memories are relevant to this conversation:\n\n";

    for (const memory of memories) {
      const scopeLevel = memory.metadata?.scope_level || "unknown";
      context += `- [${scopeLevel}] ${memory.memory}\n`;
    }

    context += "\nUse these memories to provide personalized responses.\n";

    return context;
  } catch (err) {
    console.error("[mem0] Failed to build memory context:", err);
    return "";
  }
}

export async function storeMemory(
  content: string,
  tenant: TenantContext,
  scopeLevel: ScopeLevel = "user",
): Promise<boolean> {
  const client = getMem0Client();
  if (!client) {
    return false;
  }

  try {
    await client.addMemory(content, { tenant, scopeLevel });
    return true;
  } catch (err) {
    console.error("[mem0] Failed to store memory:", err);
    return false;
  }
}

// ============================================
// SELF-IMPROVEMENT LEARNING SYSTEM
// ============================================

/**
 * Learning scope levels for multi-tenant storage
 * - workspace: Personal learnings for specific workspace (employee)
 * - team: Team learnings (manager)
 * - organization: Shared learnings for all (admin)
 */
export type LearningScopeLevel = "workspace" | "team" | "organization";

/**
 * Store a learning from user correction
 * Supports multi-level multi-tenancy based on workspace_id:
 * - "workspace" level: Personal learnings for specific workspace
 * - "team" level: Team learnings for all team members
 * - "organization" level: Shared learnings for all users in org
 */
export async function storeLearning(
  trigger: string,
  lesson: string,
  tenant: TenantContext,
  scopeLevel: LearningScopeLevel = "workspace", // Default to workspace-level
): Promise<boolean> {
  console.log(`[learning] ========== STORE LEARNING ==========`);
  console.log(`[learning] Trigger: "${trigger}"`);
  console.log(`[learning] Lesson: "${lesson}"`);
  console.log(`[learning] Scope Level: ${scopeLevel}`);
  console.log(`[learning] Org: ${tenant.organizationId}`);
  console.log(`[learning] Workspace: ${tenant.workspaceId}`);
  console.log(`[learning] Team: ${tenant.teamId}`);
  console.log(`[learning] Role: ${tenant.role}`);

  const client = getMem0Client();
  if (!client) {
    console.log(`[learning] ERROR: No Mem0 client available`);
    return false;
  }

  try {
    // Format as a clear preference that Mem0 AI can extract as a fact
    const content = `Important: When searching for ${trigger}, always ${lesson}. This is the preferred workflow.`;

    console.log(`[learning] Content to store: "${content}"`);

    // Create scope key based on level (workspace_id is main identifier)
    let scopeKey: string;
    switch (scopeLevel) {
      case "organization":
        scopeKey = `org${tenant.organizationId}`;
        break;
      case "team":
        scopeKey = `team:${tenant.organizationId}:${tenant.teamId}`;
        break;
      case "workspace":
      default:
        scopeKey = `ws:${tenant.organizationId}:${tenant.workspaceId}`;
        break;
    }

    console.log(`[learning] Scope Key: ${scopeKey}`);

    // Map learning scope to memory scope
    const memoryScopeLevel: ScopeLevel =
      scopeLevel === "organization" ? "organization" : scopeLevel === "team" ? "team" : "workspace";

    const result = await client.addMemory(content, {
      tenant,
      scopeLevel: memoryScopeLevel,
      metadata: {
        type: "learning",
        learning_scope: scopeLevel, // "workspace", "team", or "organization"
        trigger: trigger.toLowerCase(),
        lesson,
        learned_at: new Date().toISOString(),
      },
    });

    console.log(`[learning] Store result: ${result.length} memories created`);

    if (result.length > 0) {
      console.log(`[learning] SUCCESS: Learning stored at ${scopeLevel} level`);
      for (const mem of result) {
        console.log(`[learning] - ID: ${mem.id}`);
        console.log(`[learning] - Memory: "${mem.memory}"`);
        console.log(`[learning] - user_id: ${mem.user_id}`);
      }
    } else {
      console.log(`[learning] NOTE: Empty result (async processing), memory may still be stored`);
    }

    return true;
  } catch (err) {
    console.error("[learning] ERROR: Failed to store learning:", err);
    return false;
  }
}

/**
 * Retrieve learnings relevant to a query
 * Role-based multi-tenant search:
 * - Admin: All org learnings (everyone's learnings)
 * - Manager: Team-based learnings (team members' learnings)
 * - Employee: Workspace-based learnings (personal only)
 */
export async function getLearnings(
  query: string,
  tenant: TenantContext,
  limit: number = 5,
): Promise<string[]> {
  console.log(`[learning] ========== GET LEARNINGS (Role-Based) ==========`);
  console.log(`[learning] Query: "${query.substring(0, 100)}..."`);
  console.log(`[learning] Role: ${tenant.role}`);
  console.log(`[learning] Org: ${tenant.organizationId}`);
  console.log(`[learning] Workspace: ${tenant.workspaceId}`);
  console.log(`[learning] Team: ${tenant.teamId}`);
  console.log(`[learning] User: ${tenant.userId}`);
  console.log(`[learning] Limit: ${limit}`);

  const client = getMem0Client();
  if (!client) {
    console.log(`[learning] ERROR: No Mem0 client available`);
    return [];
  }

  const allLearnings: string[] = [];
  const seenLessons = new Set<string>();

  try {
    // Role-based learning retrieval
    // workspace_id is the main identifier for employees
    switch (tenant.role) {
      case "admin":
        // Admin: Get ALL org learnings (everyone's learnings)
        console.log(`[learning] ADMIN: Searching ALL org learnings...`);
        await searchAndCollectLearnings(
          client,
          query,
          `org${tenant.organizationId}`,
          tenant.organizationId,
          limit,
          "ORG-ALL",
          allLearnings,
          seenLessons,
        );
        break;

      case "manager":
        // Manager: Get team-based learnings (by team_id)
        console.log(`[learning] MANAGER: Searching TEAM learnings...`);

        // 1. Own workspace learnings first
        const managerWsScopeKey = `ws:${tenant.organizationId}:${tenant.workspaceId}`;
        await searchAndCollectLearnings(
          client,
          query,
          managerWsScopeKey,
          tenant.organizationId,
          Math.ceil(limit / 2),
          "SELF-WS",
          allLearnings,
          seenLessons,
        );

        // 2. Team learnings (all workspaces in the team)
        const teamScopeKey = `team:${tenant.organizationId}:${tenant.teamId}`;
        await searchAndCollectLearnings(
          client,
          query,
          teamScopeKey,
          tenant.organizationId,
          limit - allLearnings.length,
          "TEAM",
          allLearnings,
          seenLessons,
        );
        break;

      case "employee":
      default:
        // Employee: Get workspace-based learnings only (workspace_id is main identifier)
        console.log(`[learning] EMPLOYEE: Searching WORKSPACE learnings...`);
        const wsScopeKey = `ws:${tenant.organizationId}:${tenant.workspaceId}`;
        await searchAndCollectLearnings(
          client,
          query,
          wsScopeKey,
          tenant.organizationId,
          limit,
          "WORKSPACE",
          allLearnings,
          seenLessons,
        );
        break;
    }

    if (allLearnings.length > 0) {
      console.log(
        `[learning] SUCCESS: Found ${allLearnings.length} total learnings for ${tenant.role}`,
      );
    } else {
      console.log(`[learning] No learnings found for ${tenant.role}`);
    }

    return allLearnings.slice(0, limit);
  } catch (err) {
    console.error("[learning] ERROR: Failed to retrieve learnings:", err);
    return [];
  }
}

/**
 * Helper function to search and collect learnings
 */
async function searchAndCollectLearnings(
  client: Mem0Client,
  query: string,
  scopeKey: string,
  orgId: string,
  limit: number,
  label: string,
  allLearnings: string[],
  seenLessons: Set<string>,
): Promise<void> {
  try {
    const results = await client.searchLearningsByScope(query, scopeKey, orgId, limit);
    console.log(`[learning] [${label}] Search returned ${results.length} results`);

    for (const r of results) {
      const lesson = r.metadata?.lesson;
      const learning = typeof lesson === "string" ? lesson : r.memory;
      if (!seenLessons.has(learning)) {
        seenLessons.add(learning);
        allLearnings.push(learning);
        console.log(`[learning] [${label}] Extracted: "${learning}"`);
      }
    }
  } catch (err) {
    console.warn(`[learning] [${label}] Search failed:`, err);
  }
}
