// ============================================
// CUSTOM TOOL SERVICE - MongoDB CRUD
// ============================================
// Stores user-created tools in eazybe-ai.custom-tools.
// Each tool is scoped to an org_id + workspace_id.
//
// Execution types:
//   - "api"  → POST JSON to a URL, get result back
//   - "mcp"  → Call an MCP server tool
// ============================================

import { MongoClient, type Collection, type Document } from "mongodb";

const MONGODB_URL =
  process.env.MONGODB_URL ||
  "mongodb+srv://akshayvats:bfXzOD0hUH12wg9rxi4l@mongodb-99e99061-o95a30e35.database.cloud.ovh.us/admin?replicaSet=replicaset&tls=true";

const DATABASE = "eazybe-ai";
const COLLECTION = "custom-tools";

export type ToolExecutionType = "api" | "mcp";

/** JSON Schema-like parameter definition for GPT function calling. */
export interface ToolParameter {
  name: string;
  type: string; // "string" | "number" | "boolean" | "array" | "object"
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface CustomToolDoc {
  _id?: string;
  tool_name: string;
  tool_id: string; // kebab-case, auto-generated
  description: string; // shown to LLM
  parameters: ToolParameter[];
  execution_type: ToolExecutionType;
  /** For "api" type: the endpoint URL to POST to. */
  api_url?: string;
  /** For "api" type: optional headers (e.g. auth tokens). */
  api_headers?: Record<string, string>;
  /** For "mcp" type: the MCP server URL. */
  mcp_server_url?: string;
  /** For "mcp" type: the tool name on the MCP server. */
  mcp_tool_name?: string;
  org_id: string;
  workspace_id: string;
  created_by?: string;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateToolInput {
  tool_name: string;
  description: string;
  parameters?: ToolParameter[];
  execution_type: string;
  api_url?: string;
  api_headers?: Record<string, string>;
  mcp_server_url?: string;
  mcp_tool_name?: string;
  org_id: string;
  workspace_id: string;
  created_by?: string;
}

export interface UpdateToolInput {
  tool_name?: string;
  description?: string;
  parameters?: ToolParameter[];
  execution_type?: string;
  api_url?: string;
  api_headers?: Record<string, string>;
  mcp_server_url?: string;
  mcp_tool_name?: string;
  is_active?: boolean;
}

let client: MongoClient | undefined;
let collection: Collection<Document> | undefined;

function getCollection(): Collection<Document> {
  if (!collection) {
    client = new MongoClient(MONGODB_URL);
    const db = client.db(DATABASE);
    collection = db.collection(COLLECTION);
  }
  return collection;
}

function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateExecutionType(t: string): ToolExecutionType {
  if (t === "api" || t === "mcp") return t;
  return "api";
}

function validateParameters(params: unknown): ToolParameter[] {
  if (!Array.isArray(params)) return [];
  return params
    .filter(
      (p): p is ToolParameter =>
        p && typeof p === "object" && typeof p.name === "string" && typeof p.type === "string",
    )
    .map((p) => ({
      name: p.name,
      type: p.type,
      description: typeof p.description === "string" ? p.description : "",
      required: p.required === true,
      ...(Array.isArray(p.enum)
        ? { enum: p.enum.filter((e: unknown) => typeof e === "string") }
        : {}),
    }));
}

// ── CRUD ──────────────────────────────────────────────────────────────────

/** Create a new custom tool. */
export async function createCustomTool(input: CreateToolInput): Promise<CustomToolDoc> {
  const coll = getCollection();
  const toolId = toKebabCase(input.tool_name);
  const now = new Date();

  const existing = await coll.findOne({ tool_id: toolId, org_id: input.org_id });
  if (existing) {
    throw new Error(`Tool "${input.tool_name}" already exists for this organization`);
  }

  const execType = validateExecutionType(input.execution_type);

  const doc: Omit<CustomToolDoc, "_id"> = {
    tool_name: input.tool_name.trim(),
    tool_id: toolId,
    description: input.description.trim(),
    parameters: validateParameters(input.parameters),
    execution_type: execType,
    api_url: execType === "api" ? input.api_url?.trim() : undefined,
    api_headers: execType === "api" ? input.api_headers : undefined,
    mcp_server_url: execType === "mcp" ? input.mcp_server_url?.trim() : undefined,
    mcp_tool_name: execType === "mcp" ? input.mcp_tool_name?.trim() : undefined,
    org_id: input.org_id,
    workspace_id: input.workspace_id,
    created_by: input.created_by,
    is_active: true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await coll.insertOne(doc);
  return { ...doc, _id: result.insertedId.toString() };
}

/** List all custom tools for an org. */
export async function listCustomTools(
  orgId: string,
  workspaceId?: string,
): Promise<CustomToolDoc[]> {
  const coll = getCollection();
  const filter: Record<string, unknown> = { org_id: orgId, is_active: true };
  if (workspaceId) filter.workspace_id = workspaceId;

  const docs = await coll.find(filter).sort({ createdAt: -1 }).toArray();
  return docs.map(docToCustomTool);
}

/** Get a single tool by tool_id + org_id. */
export async function getCustomTool(toolId: string, orgId: string): Promise<CustomToolDoc | null> {
  const coll = getCollection();
  const doc = await coll.findOne({ tool_id: toolId, org_id: orgId, is_active: true });
  return doc ? docToCustomTool(doc) : null;
}

/** Get multiple tools by their tool_ids for an org. */
export async function getCustomToolsByIds(
  toolIds: string[],
  orgId: string,
): Promise<CustomToolDoc[]> {
  if (toolIds.length === 0) return [];
  const coll = getCollection();
  const docs = await coll
    .find({ tool_id: { $in: toolIds }, org_id: orgId, is_active: true })
    .toArray();
  return docs.map(docToCustomTool);
}

/** Update a custom tool. */
export async function updateCustomTool(
  toolId: string,
  orgId: string,
  input: UpdateToolInput,
): Promise<CustomToolDoc | null> {
  const coll = getCollection();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input.tool_name !== undefined) {
    updates.tool_name = input.tool_name.trim();
    updates.tool_id = toKebabCase(input.tool_name);
  }
  if (input.description !== undefined) updates.description = input.description.trim();
  if (input.parameters !== undefined) updates.parameters = validateParameters(input.parameters);
  if (input.execution_type !== undefined)
    updates.execution_type = validateExecutionType(input.execution_type);
  if (input.api_url !== undefined) updates.api_url = input.api_url.trim();
  if (input.api_headers !== undefined) updates.api_headers = input.api_headers;
  if (input.mcp_server_url !== undefined) updates.mcp_server_url = input.mcp_server_url.trim();
  if (input.mcp_tool_name !== undefined) updates.mcp_tool_name = input.mcp_tool_name.trim();
  if (input.is_active !== undefined) updates.is_active = input.is_active;

  const result = await coll.findOneAndUpdate(
    { tool_id: toolId, org_id: orgId },
    { $set: updates },
    { returnDocument: "after" },
  );
  return result ? docToCustomTool(result) : null;
}

/** Soft-delete a custom tool. */
export async function deleteCustomTool(toolId: string, orgId: string): Promise<boolean> {
  const coll = getCollection();
  const result = await coll.updateOne(
    { tool_id: toolId, org_id: orgId },
    { $set: { is_active: false, updatedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

// ── Execution ─────────────────────────────────────────────────────────────

/**
 * Execute a custom tool by calling its configured endpoint.
 * Returns the result as a string (for GPT tool_call response).
 */
export async function executeCustomTool(
  tool: CustomToolDoc,
  args: Record<string, unknown>,
): Promise<string> {
  console.log(`[custom-tool] Executing "${tool.tool_id}" (${tool.execution_type})`);

  try {
    if (tool.execution_type === "api") {
      return await executeApiTool(tool, args);
    }
    if (tool.execution_type === "mcp") {
      return await executeMcpTool(tool, args);
    }
    return `Unsupported execution type: ${tool.execution_type}`;
  } catch (err) {
    console.error(`[custom-tool] "${tool.tool_id}" failed:`, err);
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Call a REST API endpoint. */
async function executeApiTool(tool: CustomToolDoc, args: Record<string, unknown>): Promise<string> {
  if (!tool.api_url) return "Error: api_url not configured for this tool";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(tool.api_headers || {}),
  };

  const response = await fetch(tool.api_url, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  if (!response.ok) {
    return `API error ${response.status}: ${text.substring(0, 500)}`;
  }
  return text;
}

/** Call an MCP server tool. */
async function executeMcpTool(tool: CustomToolDoc, args: Record<string, unknown>): Promise<string> {
  if (!tool.mcp_server_url || !tool.mcp_tool_name) {
    return "Error: mcp_server_url and mcp_tool_name required for MCP tools";
  }

  // MCP tools/call endpoint
  const mcpUrl = tool.mcp_server_url.replace(/\/+$/, "");
  const response = await fetch(`${mcpUrl}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: tool.mcp_tool_name,
      arguments: args,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  if (!response.ok) {
    return `MCP error ${response.status}: ${text.substring(0, 500)}`;
  }

  // MCP returns { content: [{ type: "text", text: "..." }] }
  try {
    const result = JSON.parse(text);
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((c: { text?: string }) => c.text || "")
        .filter(Boolean)
        .join("\n");
    }
    return text;
  } catch {
    return text;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a CustomToolDoc to a GPT function calling tool definition.
 */
export function toGptToolDefinition(tool: CustomToolDoc) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of tool.parameters) {
    const prop: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    if (param.enum && param.enum.length > 0) {
      prop.enum = param.enum;
    }
    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  return {
    type: "function" as const,
    function: {
      name: tool.tool_id,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

function docToCustomTool(d: Document): CustomToolDoc {
  return {
    _id: d._id.toString(),
    tool_name: d.tool_name,
    tool_id: d.tool_id,
    description: d.description,
    parameters: d.parameters || [],
    execution_type: d.execution_type,
    api_url: d.api_url,
    api_headers: d.api_headers,
    mcp_server_url: d.mcp_server_url,
    mcp_tool_name: d.mcp_tool_name,
    org_id: d.org_id,
    workspace_id: d.workspace_id,
    created_by: d.created_by,
    is_active: d.is_active,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
