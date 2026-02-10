// ============================================
// CUSTOM AGENTS HTTP API
// ============================================
// CRUD endpoints for user-created agents.
//
// POST   /v1/agents           → create agent
// GET    /v1/agents           → list agents (query: org_id, workspace_id)
// GET    /v1/agents/:id       → get agent  (query: org_id)
// PUT    /v1/agents/:id       → update agent (query: org_id)
// DELETE /v1/agents/:id       → delete agent (query: org_id)
// ============================================

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCustomAgent,
  listCustomAgents,
  getCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
} from "../agent/custom-agent-service.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";

const AGENTS_PREFIX = "/v1/agents";

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
}

function getOrgId(
  req: IncomingMessage,
  url: URL,
  body?: Record<string, unknown>,
): string | undefined {
  return (
    (typeof req.headers["x-org-id"] === "string" ? req.headers["x-org-id"] : undefined) ||
    url.searchParams.get("org_id") ||
    (body && typeof body.org_id === "string" ? body.org_id : undefined) ||
    undefined
  );
}

function getWorkspaceId(
  req: IncomingMessage,
  url: URL,
  body?: Record<string, unknown>,
): string | undefined {
  return (
    (typeof req.headers["x-workspace-id"] === "string"
      ? req.headers["x-workspace-id"]
      : undefined) ||
    url.searchParams.get("workspace_id") ||
    (body && typeof body.workspace_id === "string" ? body.workspace_id : undefined) ||
    undefined
  );
}

/**
 * Extract agent_id from URL path: /v1/agents/:id
 */
function extractAgentId(pathname: string): string | undefined {
  if (!pathname.startsWith(AGENTS_PREFIX + "/")) return undefined;
  const rest = pathname.slice(AGENTS_PREFIX.length + 1).replace(/\/+$/, "");
  return rest || undefined;
}

export async function handleCustomAgentsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  // Only handle /v1/agents and /v1/agents/:id
  if (!pathname.startsWith(AGENTS_PREFIX)) return false;

  const agentId = extractAgentId(pathname);
  const isCollection = pathname === AGENTS_PREFIX || pathname === AGENTS_PREFIX + "/";
  const isItem = !!agentId;

  if (!isCollection && !isItem) return false;

  // ── POST /v1/agents ─ Create ───────────────────────────────────────────
  if (isCollection && req.method === "POST") {
    const body = await readJsonBodyOrError(req, res, 512 * 1024);
    if (body === undefined) return true;

    const b = body as Record<string, unknown>;
    const orgId = getOrgId(req, url, b);
    const workspaceId = getWorkspaceId(req, url, b);

    if (!orgId || !workspaceId) {
      sendJson(res, 400, {
        error: { message: "org_id and workspace_id are required", type: "invalid_request_error" },
      });
      return true;
    }

    const agentName = typeof b.agent_name === "string" ? b.agent_name.trim() : "";
    const systemPrompt = typeof b.system_prompt === "string" ? b.system_prompt : "";
    const skills = Array.isArray(b.skills) ? b.skills : [];
    const customTools = Array.isArray(b.custom_tools) ? b.custom_tools : [];
    const description = typeof b.description === "string" ? b.description : "";
    const createdBy = typeof b.created_by === "string" ? b.created_by : undefined;

    if (!agentName) {
      sendJson(res, 400, {
        error: { message: "agent_name is required", type: "invalid_request_error" },
      });
      return true;
    }
    if (!systemPrompt) {
      sendJson(res, 400, {
        error: { message: "system_prompt is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const agent = await createCustomAgent({
        agent_name: agentName,
        description,
        system_prompt: systemPrompt,
        skills,
        custom_tools: customTools,
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: createdBy,
      });
      console.log(`[custom-agents] Created agent "${agent.agent_id}" for org=${orgId}`);
      sendJson(res, 201, { success: true, agent });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 409, { error: { message, type: "conflict" } });
    }
    return true;
  }

  // ── GET /v1/agents ─ List ──────────────────────────────────────────────
  if (isCollection && req.method === "GET") {
    const orgId = getOrgId(req, url);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }
    const workspaceId = getWorkspaceId(req, url);

    try {
      const agents = await listCustomAgents(orgId, workspaceId || undefined);
      sendJson(res, 200, { success: true, agents, count: agents.length });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── GET /v1/agents/:id ─ Get ───────────────────────────────────────────
  if (isItem && req.method === "GET") {
    const orgId = getOrgId(req, url);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const agent = await getCustomAgent(agentId, orgId);
      if (!agent) {
        sendJson(res, 404, {
          error: { message: `Agent "${agentId}" not found`, type: "not_found" },
        });
        return true;
      }
      sendJson(res, 200, { success: true, agent });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── PUT /v1/agents/:id ─ Update ────────────────────────────────────────
  if (isItem && req.method === "PUT") {
    const body = await readJsonBodyOrError(req, res, 512 * 1024);
    if (body === undefined) return true;

    const b = body as Record<string, unknown>;
    const orgId = getOrgId(req, url, b);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const agent = await updateCustomAgent(agentId, orgId, {
        agent_name: typeof b.agent_name === "string" ? b.agent_name : undefined,
        description: typeof b.description === "string" ? b.description : undefined,
        system_prompt: typeof b.system_prompt === "string" ? b.system_prompt : undefined,
        skills: Array.isArray(b.skills) ? b.skills : undefined,
        custom_tools: Array.isArray(b.custom_tools) ? b.custom_tools : undefined,
        is_active: typeof b.is_active === "boolean" ? b.is_active : undefined,
      });
      if (!agent) {
        sendJson(res, 404, {
          error: { message: `Agent "${agentId}" not found`, type: "not_found" },
        });
        return true;
      }
      console.log(`[custom-agents] Updated agent "${agentId}" for org=${orgId}`);
      sendJson(res, 200, { success: true, agent });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── DELETE /v1/agents/:id ─ Delete ─────────────────────────────────────
  if (isItem && req.method === "DELETE") {
    const orgId = getOrgId(req, url);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const deleted = await deleteCustomAgent(agentId, orgId);
      if (!deleted) {
        sendJson(res, 404, {
          error: { message: `Agent "${agentId}" not found`, type: "not_found" },
        });
        return true;
      }
      console.log(`[custom-agents] Deleted agent "${agentId}" for org=${orgId}`);
      sendJson(res, 200, { success: true, message: `Agent "${agentId}" deleted` });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // Method not supported for this path
  sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  return true;
}
