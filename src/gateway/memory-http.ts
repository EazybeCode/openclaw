// ============================================
// MEMORY HTTP API
// ============================================
// Endpoints for managing Mem0 memories.
//
// DELETE /v1/memories/clear   → clear memories by scope
//   Query params:
//     org_id       (required)
//     user_id      (optional)
//     workspace_id (optional)
//     team_id      (optional)
//     agent_id     (optional) - e.g. "testing-agent", "omnis_default"
//     scope        (optional) - "user" | "team" | "workspace" | "organization" | "agent" | "all"
//
// GET /v1/memories/list       → list memories by scope
//   Same query params as above
// ============================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";

const MEM0_API_V1 = "https://api.mem0.ai/v1";

function getMem0ApiKey(): string | null {
  return process.env.MEM0_API_KEY || null;
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
}

function getParam(req: IncomingMessage, url: URL, name: string): string | undefined {
  return (
    (typeof req.headers[`x-${name.replace(/_/g, "-")}`] === "string"
      ? (req.headers[`x-${name.replace(/_/g, "-")}`] as string)
      : undefined) ||
    url.searchParams.get(name) ||
    undefined
  );
}

async function mem0Request(
  endpoint: string,
  method: "GET" | "DELETE",
  apiKey: string,
): Promise<unknown> {
  const url = `${MEM0_API_V1}${endpoint}`;
  console.log(`[memory-api] ${method} ${url}`);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Build scope keys for the given parameters
 */
function buildScopeKeys(params: {
  orgId: string;
  userId?: string;
  workspaceId?: string;
  teamId?: string;
  scope?: string;
}): string[] {
  const { orgId, userId, workspaceId, teamId, scope } = params;

  if (scope === "user" && userId) {
    return [`user:${orgId}:${userId}`];
  }
  if (scope === "team" && teamId && workspaceId) {
    return [`team:${orgId}:${workspaceId}:${teamId}`];
  }
  if (scope === "workspace" && workspaceId) {
    return [`ws:${orgId}:${workspaceId}`];
  }
  if (scope === "organization") {
    return [`org${orgId}`];
  }

  // "all" or no scope - return all possible scope keys
  const keys: string[] = [];
  if (userId) keys.push(`user:${orgId}:${userId}`);
  if (teamId && workspaceId) keys.push(`team:${orgId}:${workspaceId}:${teamId}`);
  if (workspaceId) keys.push(`ws:${orgId}:${workspaceId}`);
  keys.push(`org${orgId}`);
  return keys;
}

const MEMORY_PREFIX = "/v1/memories";

export async function handleMemoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  if (!pathname.startsWith(MEMORY_PREFIX)) return false;

  const subPath = pathname.slice(MEMORY_PREFIX.length).replace(/\/+$/, "");

  // ── DELETE /v1/memories/clear ─ Clear memories ────────────────────────
  if (subPath === "/clear" && req.method === "DELETE") {
    const apiKey = getMem0ApiKey();
    if (!apiKey) {
      sendJson(res, 500, {
        error: { message: "MEM0_API_KEY not configured", type: "config_error" },
      });
      return true;
    }

    const orgId = getParam(req, url, "org_id");
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    const userId = getParam(req, url, "user_id");
    const workspaceId = getParam(req, url, "workspace_id");
    const teamId = getParam(req, url, "team_id");
    const agentId = getParam(req, url, "agent_id");
    const scope = getParam(req, url, "scope") || "all";

    console.log(
      `[memory-api] Clear memories: org=${orgId} user=${userId} workspace=${workspaceId} team=${teamId} agent=${agentId} scope=${scope}`,
    );

    const results: Array<{ scope_key: string; agent_id?: string; result: unknown }> = [];

    // If agent_id specified and scope is "agent", delete all memories for that agent
    if (scope === "agent" && agentId) {
      const result = await mem0Request(
        `/memories/?agent_id=${encodeURIComponent(agentId)}`,
        "DELETE",
        apiKey,
      );
      results.push({ scope_key: "*", agent_id: agentId, result });
    } else {
      // Build scope keys and delete for each
      const scopeKeys = buildScopeKeys({ orgId, userId, workspaceId, teamId, scope });

      for (const scopeKey of scopeKeys) {
        try {
          let endpoint = `/memories/?user_id=${encodeURIComponent(scopeKey)}`;
          if (agentId) {
            endpoint += `&agent_id=${encodeURIComponent(agentId)}`;
          }
          const result = await mem0Request(endpoint, "DELETE", apiKey);
          results.push({ scope_key: scopeKey, agent_id: agentId, result });
        } catch (err) {
          results.push({ scope_key: scopeKey, agent_id: agentId, result: { error: String(err) } });
        }
      }
    }

    console.log(`[memory-api] Clear complete: ${results.length} scopes processed`);
    sendJson(res, 200, { success: true, cleared: results });
    return true;
  }

  // ── GET /v1/memories/list ─ List memories ─────────────────────────────
  if (subPath === "/list" && req.method === "GET") {
    const apiKey = getMem0ApiKey();
    if (!apiKey) {
      sendJson(res, 500, {
        error: { message: "MEM0_API_KEY not configured", type: "config_error" },
      });
      return true;
    }

    const orgId = getParam(req, url, "org_id");
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    const userId = getParam(req, url, "user_id");
    const workspaceId = getParam(req, url, "workspace_id");
    const teamId = getParam(req, url, "team_id");
    const agentId = getParam(req, url, "agent_id");
    const scope = getParam(req, url, "scope");

    const allMemories: Array<{ scope_key: string; memories: unknown[] }> = [];

    // If agent_id only, list by agent
    if (scope === "agent" && agentId) {
      const result = (await mem0Request(
        `/memories/?agent_id=${encodeURIComponent(agentId)}`,
        "GET",
        apiKey,
      )) as unknown[];
      allMemories.push({ scope_key: "*", memories: Array.isArray(result) ? result : [] });
    } else {
      const scopeKeys = buildScopeKeys({ orgId, userId, workspaceId, teamId, scope });

      for (const scopeKey of scopeKeys) {
        try {
          let endpoint = `/memories/?user_id=${encodeURIComponent(scopeKey)}`;
          if (agentId) {
            endpoint += `&agent_id=${encodeURIComponent(agentId)}`;
          }
          const result = (await mem0Request(endpoint, "GET", apiKey)) as unknown[];
          allMemories.push({
            scope_key: scopeKey,
            memories: Array.isArray(result) ? result : [],
          });
        } catch (err) {
          allMemories.push({ scope_key: scopeKey, memories: [] });
        }
      }
    }

    const totalCount = allMemories.reduce((sum, s) => sum + s.memories.length, 0);
    sendJson(res, 200, { success: true, total: totalCount, scopes: allMemories });
    return true;
  }

  // Not a recognized sub-path under /v1/memories
  if (subPath === "/clear" || subPath === "/list") {
    sendMethodNotAllowed(res, subPath === "/clear" ? "DELETE" : "GET");
    return true;
  }

  return false;
}
