// ============================================
// MEM0 CLIENT - Cloud Memory with Tenant Scoping
// ============================================

import type { TenantContext, ScopeLevel } from "../tenant/index.js";
import { createScopeKey, getAllScopeKeys } from "../tenant/index.js";

const MEM0_API_BASE = "https://api.mem0.ai/v1";

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
  ): Promise<T> {
    const url = `${MEM0_API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mem0 API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async addMemory(content: string, options: Mem0AddOptions): Promise<Mem0Memory[]> {
    const { tenant, scopeLevel = "user", metadata = {} } = options;
    const scopeKey = createScopeKey(tenant, scopeLevel);

    const payload = {
      messages: [{ role: "user", content }],
      user_id: scopeKey,
      agent_id: this.orgId || "openclaw",
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

    const result = await this.request<{ results: Mem0Memory[] }>("/memories/", "POST", payload);

    return result.results || [];
  }

  async searchMemories(query: string, options: Mem0SearchOptions): Promise<Mem0SearchResult[]> {
    const { tenant, scopeLevels, limit = 10 } = options;
    const scopesToSearch = scopeLevels || this.getDefaultScopeLevels(tenant);
    const allResults: Mem0SearchResult[] = [];

    for (const scopeLevel of scopesToSearch) {
      try {
        const scopeKey = createScopeKey(tenant, scopeLevel);

        const payload = {
          query,
          user_id: scopeKey,
          agent_id: this.orgId || "openclaw",
          limit: Math.ceil(limit / scopesToSearch.length),
        };

        const result = await this.request<{ results: Mem0SearchResult[] }>(
          "/memories/search/",
          "POST",
          payload,
        );

        if (result.results) {
          allResults.push(
            ...result.results.map((r) => ({
              ...r,
              metadata: { ...r.metadata, scope_level: scopeLevel },
            })),
          );
        }
      } catch (err) {
        console.warn(`[mem0] Search failed for scope ${scopeLevel}:`, err);
      }
    }

    return allResults.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async getMemories(tenant: TenantContext, scopeLevel: ScopeLevel = "user"): Promise<Mem0Memory[]> {
    const scopeKey = createScopeKey(tenant, scopeLevel);

    const result = await this.request<{ results: Mem0Memory[] }>(
      `/memories/?user_id=${encodeURIComponent(scopeKey)}&agent_id=${encodeURIComponent(this.orgId || "openclaw")}`,
      "GET",
    );

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
 * Store a learning from user correction
 * Learnings are org-level so all users benefit
 */
export async function storeLearning(
  trigger: string,
  lesson: string,
  tenant: TenantContext,
): Promise<boolean> {
  const client = getMem0Client();
  if (!client) {
    return false;
  }

  try {
    // Store at organization level so all users benefit
    await client.addMemory(`When user mentions "${trigger}": ${lesson}`, {
      tenant,
      scopeLevel: "organization",
      metadata: {
        type: "learning",
        trigger: trigger.toLowerCase(),
        lesson,
        learned_at: new Date().toISOString(),
      },
    });
    console.log(`[learning] Stored: "${trigger}" → "${lesson}" for org ${tenant.organizationId}`);
    return true;
  } catch (err) {
    console.error("[learning] Failed to store learning:", err);
    return false;
  }
}

/**
 * Retrieve learnings relevant to a query
 * Searches for learnings that match trigger words in the query
 */
export async function getLearnings(
  query: string,
  tenant: TenantContext,
  limit: number = 5,
): Promise<string[]> {
  const client = getMem0Client();
  if (!client) {
    return [];
  }

  try {
    // Search for relevant learnings at organization level
    const results = await client.searchMemories(query, {
      tenant,
      scopeLevels: ["organization"],
      limit,
    });

    // Filter to only learnings (type="learning" in metadata)
    const learnings = results
      .filter((r) => r.metadata?.type === "learning")
      .map((r) => {
        const lesson = r.metadata?.lesson;
        return typeof lesson === "string" ? lesson : r.memory;
      });

    if (learnings.length > 0) {
      console.log(
        `[learning] Retrieved ${learnings.length} learnings for query: "${query.substring(0, 50)}..."`,
      );
    }

    return learnings;
  } catch (err) {
    console.error("[learning] Failed to retrieve learnings:", err);
    return [];
  }
}
