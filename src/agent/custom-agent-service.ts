// ============================================
// CUSTOM AGENT SERVICE - MongoDB CRUD
// ============================================
// Stores user-created agents in eazybe-ai.custom-agents.
// Each agent is scoped to an org_id + workspace_id.
// ============================================

import { MongoClient, ObjectId, type Collection, type Document } from "mongodb";

const MONGODB_URL =
  process.env.MONGODB_URL ||
  "mongodb+srv://akshayvats:bfXzOD0hUH12wg9rxi4l@mongodb-99e99061-o95a30e35.database.cloud.ovh.us/admin?replicaSet=replicaset&tls=true";

const DATABASE = "eazybe-ai";
const COLLECTION = "custom-agents";

/** Skills/tools a user can enable on a custom agent. */
export type CustomAgentSkill = "hubspot" | "bigquery" | "qdrant" | "team" | "memory";

export interface CustomAgentDoc {
  _id?: string;
  agent_name: string;
  agent_id: string; // kebab-case, auto-generated from name
  description?: string;
  system_prompt: string;
  skills: CustomAgentSkill[];
  custom_tools: string[]; // tool_ids from custom-tools collection
  org_id: string;
  workspace_id: string;
  created_by?: string; // user_id of creator
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentInput {
  agent_name: string;
  description?: string;
  system_prompt: string;
  skills: string[];
  custom_tools?: string[]; // tool_ids from custom-tools collection
  org_id: string;
  workspace_id: string;
  created_by?: string;
}

export interface UpdateAgentInput {
  agent_name?: string;
  description?: string;
  system_prompt?: string;
  skills?: string[];
  custom_tools?: string[];
  is_active?: boolean;
}

const VALID_SKILLS = new Set(["hubspot", "bigquery", "qdrant", "team", "memory"]);

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

function validateSkills(skills: unknown[]): CustomAgentSkill[] {
  const valid: CustomAgentSkill[] = [];
  for (const s of skills) {
    if (typeof s === "string" && VALID_SKILLS.has(s)) {
      valid.push(s as CustomAgentSkill);
    }
  }
  return valid;
}

/** Create a new custom agent. */
export async function createCustomAgent(input: CreateAgentInput): Promise<CustomAgentDoc> {
  const coll = getCollection();
  const agentId = toKebabCase(input.agent_name);
  const now = new Date();

  // Check for duplicate within same org
  const existing = await coll.findOne({
    agent_id: agentId,
    org_id: input.org_id,
  });
  if (existing) {
    throw new Error(`Agent "${input.agent_name}" already exists for this organization`);
  }

  const doc: Omit<CustomAgentDoc, "_id"> = {
    agent_name: input.agent_name.trim(),
    agent_id: agentId,
    description: input.description?.trim() || "",
    system_prompt: input.system_prompt,
    skills: validateSkills(input.skills),
    custom_tools: Array.isArray(input.custom_tools)
      ? input.custom_tools.filter((t) => typeof t === "string")
      : [],
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

/** List all custom agents for an org (optionally filtered by workspace). */
export async function listCustomAgents(
  orgId: string,
  workspaceId?: string,
): Promise<CustomAgentDoc[]> {
  const coll = getCollection();
  const filter: Record<string, unknown> = { org_id: orgId, is_active: true };
  if (workspaceId) {
    filter.workspace_id = workspaceId;
  }
  const docs = await coll.find(filter).sort({ createdAt: -1 }).toArray();
  return docs.map((d) => ({
    _id: d._id.toString(),
    agent_name: d.agent_name,
    agent_id: d.agent_id,
    description: d.description,
    system_prompt: d.system_prompt,
    skills: d.skills,
    custom_tools: d.custom_tools || [],
    org_id: d.org_id,
    workspace_id: d.workspace_id,
    created_by: d.created_by,
    is_active: d.is_active,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

/** Get a single custom agent by ID within an org. */
export async function getCustomAgent(
  agentId: string,
  orgId: string,
): Promise<CustomAgentDoc | null> {
  const coll = getCollection();
  const doc = await coll.findOne({ agent_id: agentId, org_id: orgId });
  if (!doc) return null;
  return {
    _id: doc._id.toString(),
    agent_name: doc.agent_name,
    agent_id: doc.agent_id,
    description: doc.description,
    system_prompt: doc.system_prompt,
    skills: doc.skills,
    custom_tools: doc.custom_tools || [],
    org_id: doc.org_id,
    workspace_id: doc.workspace_id,
    created_by: doc.created_by,
    is_active: doc.is_active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Update a custom agent. */
export async function updateCustomAgent(
  agentId: string,
  orgId: string,
  input: UpdateAgentInput,
): Promise<CustomAgentDoc | null> {
  const coll = getCollection();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input.agent_name !== undefined) {
    updates.agent_name = input.agent_name.trim();
    updates.agent_id = toKebabCase(input.agent_name);
  }
  if (input.description !== undefined) updates.description = input.description.trim();
  if (input.system_prompt !== undefined) updates.system_prompt = input.system_prompt;
  if (input.skills !== undefined) updates.skills = validateSkills(input.skills);
  if (input.custom_tools !== undefined)
    updates.custom_tools = input.custom_tools.filter((t) => typeof t === "string");
  if (input.is_active !== undefined) updates.is_active = input.is_active;

  const result = await coll.findOneAndUpdate(
    { agent_id: agentId, org_id: orgId },
    { $set: updates },
    { returnDocument: "after" },
  );

  if (!result) return null;
  return {
    _id: result._id.toString(),
    agent_name: result.agent_name,
    agent_id: result.agent_id,
    description: result.description,
    system_prompt: result.system_prompt,
    skills: result.skills,
    custom_tools: result.custom_tools || [],
    org_id: result.org_id,
    workspace_id: result.workspace_id,
    created_by: result.created_by,
    is_active: result.is_active,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

/** Soft-delete a custom agent (sets is_active = false). */
export async function deleteCustomAgent(agentId: string, orgId: string): Promise<boolean> {
  const coll = getCollection();
  const result = await coll.updateOne(
    { agent_id: agentId, org_id: orgId },
    { $set: { is_active: false, updatedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

/**
 * Resolve a custom agent into an AgentConfig shape
 * (compatible with the existing Omnis agent system).
 */
export function toAgentConfig(doc: CustomAgentDoc) {
  return {
    id: doc.agent_id,
    name: doc.agent_name,
    systemPromptTemplate: doc.system_prompt,
    skills: doc.skills,
    customTools: doc.custom_tools || [],
    behaviors: [] as string[],
  };
}
