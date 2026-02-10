// ============================================
// CUSTOM TOOLS HTTP API
// ============================================
// CRUD endpoints for user-created tools.
//
// POST   /v1/tools           → create tool
// GET    /v1/tools           → list tools (query: org_id, workspace_id)
// GET    /v1/tools/:id       → get tool  (query: org_id)
// PUT    /v1/tools/:id       → update tool (query: org_id)
// DELETE /v1/tools/:id       → delete tool (query: org_id)
// ============================================

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCustomTool,
  listCustomTools,
  getCustomTool,
  updateCustomTool,
  deleteCustomTool,
} from "../agent/custom-tool-service.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";

const TOOLS_PREFIX = "/v1/tools";

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
 * Extract tool_id from URL path: /v1/tools/:id
 */
function extractToolId(pathname: string): string | undefined {
  if (!pathname.startsWith(TOOLS_PREFIX + "/")) return undefined;
  const rest = pathname.slice(TOOLS_PREFIX.length + 1).replace(/\/+$/, "");
  return rest || undefined;
}

export async function handleCustomToolsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  // Only handle /v1/tools and /v1/tools/:id
  if (!pathname.startsWith(TOOLS_PREFIX)) return false;

  const toolId = extractToolId(pathname);
  const isCollection = pathname === TOOLS_PREFIX || pathname === TOOLS_PREFIX + "/";
  const isItem = !!toolId;

  if (!isCollection && !isItem) return false;

  // ── POST /v1/tools ─ Create ───────────────────────────────────────────
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

    const toolName = typeof b.tool_name === "string" ? b.tool_name.trim() : "";
    const description = typeof b.description === "string" ? b.description : "";
    const executionType = typeof b.execution_type === "string" ? b.execution_type : "api";
    const parameters = Array.isArray(b.parameters) ? b.parameters : [];
    const apiUrl = typeof b.api_url === "string" ? b.api_url : undefined;
    const apiHeaders =
      typeof b.api_headers === "object" && b.api_headers !== null
        ? (b.api_headers as Record<string, string>)
        : undefined;
    const mcpServerUrl = typeof b.mcp_server_url === "string" ? b.mcp_server_url : undefined;
    const mcpToolName = typeof b.mcp_tool_name === "string" ? b.mcp_tool_name : undefined;
    const createdBy = typeof b.created_by === "string" ? b.created_by : undefined;

    if (!toolName) {
      sendJson(res, 400, {
        error: { message: "tool_name is required", type: "invalid_request_error" },
      });
      return true;
    }
    if (!description) {
      sendJson(res, 400, {
        error: { message: "description is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const tool = await createCustomTool({
        tool_name: toolName,
        description,
        parameters,
        execution_type: executionType,
        api_url: apiUrl,
        api_headers: apiHeaders,
        mcp_server_url: mcpServerUrl,
        mcp_tool_name: mcpToolName,
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: createdBy,
      });
      console.log(`[custom-tools] Created tool "${tool.tool_id}" for org=${orgId}`);
      sendJson(res, 201, { success: true, tool });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 409, { error: { message, type: "conflict" } });
    }
    return true;
  }

  // ── GET /v1/tools ─ List ──────────────────────────────────────────────
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
      const tools = await listCustomTools(orgId, workspaceId || undefined);
      sendJson(res, 200, { success: true, tools, count: tools.length });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── GET /v1/tools/:id ─ Get ───────────────────────────────────────────
  if (isItem && req.method === "GET") {
    const orgId = getOrgId(req, url);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const tool = await getCustomTool(toolId, orgId);
      if (!tool) {
        sendJson(res, 404, { error: { message: `Tool "${toolId}" not found`, type: "not_found" } });
        return true;
      }
      sendJson(res, 200, { success: true, tool });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── PUT /v1/tools/:id ─ Update ────────────────────────────────────────
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
      const tool = await updateCustomTool(toolId, orgId, {
        tool_name: typeof b.tool_name === "string" ? b.tool_name : undefined,
        description: typeof b.description === "string" ? b.description : undefined,
        parameters: Array.isArray(b.parameters) ? b.parameters : undefined,
        execution_type: typeof b.execution_type === "string" ? b.execution_type : undefined,
        api_url: typeof b.api_url === "string" ? b.api_url : undefined,
        api_headers:
          typeof b.api_headers === "object" && b.api_headers !== null
            ? (b.api_headers as Record<string, string>)
            : undefined,
        mcp_server_url: typeof b.mcp_server_url === "string" ? b.mcp_server_url : undefined,
        mcp_tool_name: typeof b.mcp_tool_name === "string" ? b.mcp_tool_name : undefined,
        is_active: typeof b.is_active === "boolean" ? b.is_active : undefined,
      });
      if (!tool) {
        sendJson(res, 404, { error: { message: `Tool "${toolId}" not found`, type: "not_found" } });
        return true;
      }
      console.log(`[custom-tools] Updated tool "${toolId}" for org=${orgId}`);
      sendJson(res, 200, { success: true, tool });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // ── DELETE /v1/tools/:id ─ Delete ─────────────────────────────────────
  if (isItem && req.method === "DELETE") {
    const orgId = getOrgId(req, url);
    if (!orgId) {
      sendJson(res, 400, {
        error: { message: "org_id is required", type: "invalid_request_error" },
      });
      return true;
    }

    try {
      const deleted = await deleteCustomTool(toolId, orgId);
      if (!deleted) {
        sendJson(res, 404, { error: { message: `Tool "${toolId}" not found`, type: "not_found" } });
        return true;
      }
      console.log(`[custom-tools] Deleted tool "${toolId}" for org=${orgId}`);
      sendJson(res, 200, { success: true, message: `Tool "${toolId}" deleted` });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err), type: "api_error" } });
    }
    return true;
  }

  // Method not supported for this path
  sendJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  return true;
}
