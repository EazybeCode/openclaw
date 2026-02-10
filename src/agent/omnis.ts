// ============================================
// OMNIS AGENT - Unified AI Agent
// ============================================
// Single agent that handles:
// - Memory (Mem0)
// - Learnings (self-improvement)
// - LLM (GPT)
// - Tools (BigQuery, HubSpot, Team API, Qdrant)
// ============================================

import { spawn } from "node:child_process";
import type { TenantContext } from "../tenant/index.js";
import {
  buildMemoryContext,
  storeMemory,
  storeLearning,
  getLearnings,
  type LearningScopeLevel,
} from "../memory/mem0-client.js";
import { evaluateTriggers } from "../proactive/engine.js";
import { ensureDefaultTriggers } from "../proactive/init.js";
import { type AgentConfig, resolveToolNames } from "./agent-config.js";

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4-turbo-preview";

// Tool definitions for GPT function calling
const TOOLS = [
  // ── BigQuery ────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "query_bigquery",
      description:
        "Query BigQuery analytics. TABLE: waba-454907.whatsapp_analytics.daily_performance_summary. COLUMNS: user_id, org_id, activity_date, agent_message_count, contact_message_count, avg_agent_response_time_seconds. ALWAYS use full table path and filter by org_id.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description:
              "SQL query using table waba-454907.whatsapp_analytics.daily_performance_summary. Must include org_id filter.",
          },
        },
        required: ["sql"],
      },
    },
  },
  // ── HubSpot ─────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "search_crm_objects",
      description:
        "Search HubSpot CRM objects (deals, contacts, companies, tickets). This is the main HubSpot search tool. Use objectType to specify what to search. For filtering by owner, use filterGroups with hubspot_owner_id property.",
      parameters: {
        type: "object",
        properties: {
          objectType: {
            type: "string",
            enum: ["deals", "contacts", "companies", "tickets"],
            description: "Type of CRM object to search",
          },
          query: {
            type: "string",
            description: "Optional text search query",
          },
          filterGroups: {
            type: "array",
            description:
              'Optional filter groups for advanced filtering. Example: [{"filters":[{"propertyName":"hubspot_owner_id","operator":"EQ","value":"123"}]}]',
            items: { type: "object" },
          },
          properties: {
            type: "array",
            description:
              'Optional list of properties to return. Example for deals: ["dealname","amount","dealstage","closedate","createdate","pipeline"]',
            items: { type: "string" },
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)",
          },
        },
        required: ["objectType"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_owners",
      description:
        "Search HubSpot owners/sales reps by name. Returns owner IDs that can be used with search_crm_objects filterGroups to find their deals/contacts.",
      parameters: {
        type: "object",
        properties: {
          searchQuery: {
            type: "string",
            description: "Name of the owner/rep to search for",
          },
        },
        required: ["searchQuery"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_crm_object",
      description:
        "Get a single HubSpot CRM object by its ID. Use this after search_crm_objects to get full details of a specific deal, contact, company, or ticket.",
      parameters: {
        type: "object",
        properties: {
          objectType: {
            type: "string",
            enum: ["deals", "contacts", "companies", "tickets"],
            description: "Type of CRM object",
          },
          objectId: {
            type: "string",
            description: "The HubSpot object ID",
          },
          properties: {
            type: "array",
            description: "Specific properties to return",
            items: { type: "string" },
          },
        },
        required: ["objectType", "objectId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_associations",
      description:
        "List associations between HubSpot CRM objects. For example, find all contacts associated with a deal, or all deals associated with a company.",
      parameters: {
        type: "object",
        properties: {
          fromObjectType: {
            type: "string",
            enum: ["deals", "contacts", "companies", "tickets"],
            description: "Source object type",
          },
          fromObjectId: {
            type: "string",
            description: "Source object ID",
          },
          toObjectType: {
            type: "string",
            enum: ["deals", "contacts", "companies", "tickets"],
            description: "Target object type to find associations for",
          },
        },
        required: ["fromObjectType", "fromObjectId", "toObjectType"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_pipelines",
      description:
        "List all deal or ticket pipelines with their stages. Use this to understand pipeline structure before creating or updating deals/tickets.",
      parameters: {
        type: "object",
        properties: {
          objectType: {
            type: "string",
            enum: ["deals", "tickets"],
            description: "Object type to list pipelines for",
          },
        },
        required: ["objectType"],
      },
    },
  },
  // ── Team ─────────────────────────────────────
  {
    type: "function" as const,
    function: {
      name: "get_team_member",
      description:
        "Get team member info or find workspace_id from name. Use this FIRST before BigQuery when user mentions employee names. Returns workspace_id which is used as user_id in BigQuery.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["find", "list"],
            description: "'find' to search by name and get workspace_id, 'list' to get all members",
          },
          name: {
            type: "string",
            description: "Name to search for (required for 'find' action)",
          },
        },
        required: ["action"],
      },
    },
  },
  // ── Qdrant Knowledge Base ────────────────────
  {
    type: "function" as const,
    function: {
      name: "search_knowledge_base",
      description:
        "Search Qdrant knowledge base for product info, documentation, past conversations, and any stored knowledge. Use this for how-to questions, product features, and historical context.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query (natural language)",
          },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Filter TOOLS array to only include tools enabled by the agent's skills.
 * Returns all tools if no agentConfig is provided.
 */
function filterToolsBySkills(agentConfig?: AgentConfig): typeof TOOLS {
  if (!agentConfig) return TOOLS;
  const enabledNames = resolveToolNames(agentConfig.skills);
  return TOOLS.filter((t) => enabledNames.includes(t.function.name));
}

export interface OmnisMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface OmnisResponse {
  success: boolean;
  response: string;
  memoriesUsed: number;
  learningsApplied: number;
  toolsUsed: string[];
  error?: string;
}

/**
 * Execute a Python script tool
 */
async function executePythonTool(
  script: string,
  args: string[],
  timeout: number = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeout}ms`));
    }, timeout);

    try {
      const child = spawn("python3", [script, ...args]);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(stdout.trim() || "No output");
        } else {
          reject(new Error(`Tool failed: ${stderr || "Unknown error"}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    } catch (err) {
      clearTimeout(timeoutId);
      reject(err);
    }
  });
}

/**
 * Call any HubSpot MCP tool via the generic Python client.
 */
async function callHubSpotTool(
  toolName: string,
  hubspotArgs: Record<string, unknown>,
  tenant: TenantContext,
): Promise<string> {
  const result = await executePythonTool("/app/skills/hubspot-mcp/scripts/hubspot.py", [
    "--org-id",
    tenant.organizationId,
    "--workspace-id",
    tenant.workspaceId,
    "call",
    toolName,
    "--args",
    JSON.stringify(hubspotArgs),
  ]);
  console.log(`[omnis] HubSpot ${toolName} result: ${result.substring(0, 200)}...`);
  return result;
}

/**
 * Execute a tool based on GPT function call
 */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tenant: TenantContext,
): Promise<string> {
  console.log(`[omnis] Executing tool: ${name}`);
  console.log(`[omnis] Tool args: ${JSON.stringify(args)}`);

  try {
    switch (name) {
      // ── BigQuery ──────────────────────────────
      case "query_bigquery": {
        const sql = args.sql as string;
        const result = await executePythonTool("/app/skills/bigquery-mcp/scripts/bigquery.py", [
          "query",
          sql,
        ]);
        console.log(`[omnis] BigQuery result: ${result.substring(0, 200)}...`);
        return result;
      }

      // ── HubSpot ───────────────────────────────
      case "search_crm_objects": {
        const hubspotArgs: Record<string, unknown> = {};
        if (args.objectType) hubspotArgs.objectType = args.objectType;
        if (args.query) hubspotArgs.query = args.query;
        if (args.filterGroups) hubspotArgs.filterGroups = args.filterGroups;
        if (args.properties) hubspotArgs.properties = args.properties;
        if (args.limit) hubspotArgs.limit = args.limit;
        return callHubSpotTool("search_crm_objects", hubspotArgs, tenant);
      }

      case "search_owners":
        return callHubSpotTool(
          "search_owners",
          { searchQuery: (args.searchQuery as string) || "" },
          tenant,
        );

      case "get_crm_object": {
        const hubspotArgs: Record<string, unknown> = {
          objectType: args.objectType,
          objectId: args.objectId,
        };
        if (args.properties) hubspotArgs.properties = args.properties;
        return callHubSpotTool("get_crm_object", hubspotArgs, tenant);
      }

      case "list_associations":
        return callHubSpotTool(
          "list_associations",
          {
            fromObjectType: args.fromObjectType,
            fromObjectId: args.fromObjectId,
            toObjectType: args.toObjectType,
          },
          tenant,
        );

      case "list_pipelines":
        return callHubSpotTool(
          "list_pipelines",
          {
            objectType: args.objectType,
          },
          tenant,
        );

      // ── Team ──────────────────────────────────
      case "get_team_member": {
        const action = args.action as string;
        const memberName = (args.name as string) || "";
        const scriptArgs = ["--org-id", tenant.workspaceId, action];
        if (action === "find" && memberName) {
          scriptArgs.push(memberName);
        }
        const result = await executePythonTool(
          "/app/skills/eazybe-team/scripts/team.py",
          scriptArgs,
        );
        console.log(`[omnis] Team result: ${result.substring(0, 200)}...`);
        return result;
      }

      // ── Qdrant Knowledge Base ─────────────────
      case "search_knowledge_base": {
        const query = args.query as string;
        const result = await executePythonTool("/app/skills/qdrant-mcp/scripts/qdrant.py", [
          "search",
          query,
        ]);
        console.log(`[omnis] Qdrant result: ${result.substring(0, 200)}...`);
        return result;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    console.error(`[omnis] Tool ${name} failed:`, err);
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Call OpenAI GPT with tools
 */
async function callGPT(
  messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }>,
  tenant: TenantContext,
  maxIterations: number = 5,
  filteredTools?: typeof TOOLS,
): Promise<{ response: string; toolsUsed: string[] }> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const toolsUsed: string[] = [];
  let currentMessages = [...messages];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`[omnis] GPT iteration ${iterations}`);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: currentMessages,
        tools: filteredTools ?? TOOLS,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const choice = result.choices?.[0];

    if (!choice) {
      throw new Error("No response from GPT");
    }

    const message = choice.message;

    // If no tool calls, we're done
    if (!message.tool_calls || message.tool_calls.length === 0) {
      console.log(`[omnis] GPT final response received`);
      return {
        response: message.content || "No response generated",
        toolsUsed,
      };
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: "assistant",
      content: message.content || "",
      ...message,
    });

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments || "{}");

      console.log(`[omnis] Tool call: ${toolName}`);
      toolsUsed.push(toolName);

      const toolResult = await executeTool(toolName, toolArgs, tenant);

      // Add tool result to messages
      currentMessages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: toolCall.id,
        name: toolName,
      });
    }
  }

  throw new Error(`Max iterations (${maxIterations}) reached`);
}

/**
 * Build tool documentation section for the system prompt.
 * Only includes docs for the enabled tool names.
 */
function buildToolDocumentation(tenant: TenantContext, enabledToolNames?: string[]): string {
  const allTools = !enabledToolNames;
  const has = (name: string) => allTools || enabledToolNames!.includes(name);

  let docs = "\n## Your Tools\n";

  if (has("query_bigquery")) {
    docs += `
### query_bigquery - Analytics Data
**Dataset**: \`waba-454907.whatsapp_analytics.daily_performance_summary\`
**Columns**:
- user_id (string) - Employee's user_id (e.g., "14024" for Mohit, "1170365" for Chandan)
- user_number (string) - Phone number (e.g., "918979991307")
- org_id (string) - Organization ID (e.g., "902")
- activity_date (date) - Date of activity
- contact_id (string) - WhatsApp contact ID
- agent_message_count (int) - Messages sent by agent
- contact_message_count (int) - Messages from contacts
- avg_agent_response_time_seconds (float) - Response time in seconds (can be null)
- time_to_first_response_seconds (float) - First response time
- conversation_starter_of_day (string) - "agent" or "contact" or null

**CRITICAL RULES**:
1. ALWAYS use full table path: \`waba-454907.whatsapp_analytics.daily_performance_summary\`
2. ALWAYS filter by org_id='${tenant.organizationId}'
3. Use get_team_member FIRST to convert names to user_id

**Example queries**:
\`\`\`sql
-- Team average response time
SELECT AVG(avg_agent_response_time_seconds) as avg_response_seconds
FROM waba-454907.whatsapp_analytics.daily_performance_summary
WHERE org_id='${tenant.organizationId}'

-- Performance by employee
SELECT user_id,
       AVG(avg_agent_response_time_seconds) as avg_response,
       SUM(agent_message_count) as total_messages
FROM waba-454907.whatsapp_analytics.daily_performance_summary
WHERE org_id='${tenant.organizationId}'
GROUP BY user_id
\`\`\`
`;
  }

  if (has("get_team_member")) {
    docs += `
### get_team_member - Find User IDs from Names
**Use this FIRST** when user mentions names like "Mohit", "Chandan", etc.

Examples:
- "find" + name: "mohit" → returns \`{"user_id": "14024", "name": "Mohit Eazybe", ...}\`
- "find" + name: "chandan" → returns \`{"user_id": "1170365", "name": "Chandan modi", ...}\`
- "list" → returns all team members with their user_ids
`;
  }

  if (has("search_crm_objects")) {
    docs += `
### search_crm_objects - HubSpot CRM Data
Search deals, contacts, companies, tickets in HubSpot.

**Parameters**:
- objectType (required): "deals", "contacts", "companies", or "tickets"
- query (optional): Text search
- filterGroups (optional): Advanced filters (e.g., filter by owner)
- properties (optional): Specific fields to return
- limit (optional): Max results

**Examples**:
- Latest deals: \`search_crm_objects(objectType="deals", properties=["dealname","amount","dealstage","closedate","createdate","pipeline"], limit=5)\`
- Deals by owner: \`search_crm_objects(objectType="deals", filterGroups=[{"filters":[{"propertyName":"hubspot_owner_id","operator":"EQ","value":"456232774"}]}])\`
`;
  }

  if (has("search_owners")) {
    docs += `
### search_owners - Find HubSpot Sales Reps
Find owner/rep IDs by name. Use BEFORE search_crm_objects when filtering by rep.

**Example**: \`search_owners(searchQuery="Mohit")\` → returns ownerId
`;
  }

  if (has("get_crm_object")) {
    docs += `
### get_crm_object - Get Full CRM Record Details
Get a single HubSpot object by ID. Use after search_crm_objects to get full details of a specific record.

**Example**: \`get_crm_object(objectType="deals", objectId="12345", properties=["dealname","amount","dealstage","notes_last_updated"])\`
`;
  }

  if (has("list_associations")) {
    docs += `
### list_associations - Find Related CRM Records
Find associations between objects. E.g., all contacts on a deal, or all deals for a company.

**Examples**:
- Contacts on a deal: \`list_associations(fromObjectType="deals", fromObjectId="12345", toObjectType="contacts")\`
- Deals for a company: \`list_associations(fromObjectType="companies", fromObjectId="67890", toObjectType="deals")\`
`;
  }

  if (has("list_pipelines")) {
    docs += `
### list_pipelines - View Pipeline Stages
List all deal or ticket pipelines with their stages. Use this to understand valid stage IDs before creating/updating deals.

**Example**: \`list_pipelines(objectType="deals")\`
`;
  }

  if (has("search_knowledge_base")) {
    docs += `
### search_knowledge_base - Documentation & Knowledge Base
Search product docs and past conversations.

**Example**: \`search_knowledge_base(query="how to set up integration")\`
`;
  }

  docs += `
## Tool Rules
- ALWAYS use full table: \`waba-454907.whatsapp_analytics.daily_performance_summary\`
- ALWAYS filter by org_id='${tenant.organizationId}' in BigQuery queries
- NEVER guess IDs — always resolve them via get_team_member or search_owners first
- Call multiple tools in sequence when needed — don't try to answer complex questions from a single tool call
- If a tool returns an error or empty result, try a different approach (broader search, different filters) before giving up
- When BigQuery returns null for avg_agent_response_time_seconds, note it as "no data" not "0 seconds"
`;

  return docs;
}

/**
 * Substitute {{variable}} placeholders in a template string.
 */
function substituteTemplateVars(template: string, tenant: TenantContext): string {
  return template
    .replace(/\{\{org_id\}\}/g, tenant.organizationId)
    .replace(/\{\{workspace_id\}\}/g, tenant.workspaceId)
    .replace(/\{\{team_id\}\}/g, tenant.teamId)
    .replace(/\{\{user_id\}\}/g, tenant.userId)
    .replace(/\{\{role\}\}/g, tenant.role)
    .replace(/\{\{surface\}\}/g, tenant.surface);
}

/**
 * Build system prompt with tenant context.
 * If agentConfig is provided, uses its template + filtered tool docs.
 * Otherwise, uses the default Omnis prompt with all tools.
 */
function buildSystemPrompt(tenant: TenantContext, agentConfig?: AgentConfig): string {
  if (agentConfig) {
    // Custom agent: use template with variable substitution + filtered tool docs
    const enabledToolNames = resolveToolNames(agentConfig.skills);
    const customPrompt = substituteTemplateVars(agentConfig.systemPromptTemplate, tenant);
    const toolDocs = buildToolDocumentation(tenant, enabledToolNames);
    return customPrompt + "\n" + toolDocs;
  }

  // Default Omnis prompt
  return (
    `You are Omnis, an intelligent Revenue Intelligence Agent for Eazybe.

You help sales leaders, managers, and reps understand their pipeline, team performance, and customer interactions by combining CRM data, analytics, knowledge base, and conversation history.

## Current User Context
- Organization ID: ${tenant.organizationId}
- Workspace ID: ${tenant.workspaceId}
- Team ID: ${tenant.teamId}
- User ID: ${tenant.userId}
- Role: ${tenant.role}
- Surface: ${tenant.surface}

## How to Think (Planning)

For every query, follow this process:

1. **Understand the intent** — What is the user really asking? A simple data lookup, a comparison, or a deep analysis?
2. **Plan your tool calls** — Before calling any tool, mentally list which tools you need and in what order. Some tools give you IDs that other tools need.
3. **Resolve identifiers first** — Always get IDs before querying data:
   - Person names → use \`get_team_member\` to get user_id/workspace_id
   - Sales rep names → use \`search_owners\` to get ownerId
   - Then use those IDs in \`query_bigquery\` or \`search_crm_objects\`
4. **Gather from multiple sources** — Complex questions need data from multiple tools. Don't stop after one tool call if more data would give a better answer.
5. **Synthesize and explain** — Combine all data into a clear, actionable answer. Don't just dump raw data — explain what it means.

## When to Use Multiple Tools Together

**Performance questions** (e.g., "How is Mohit performing?"):
→ get_team_member (get user_id) → query_bigquery (get metrics) → search_crm_objects (get their deals)

**Pipeline/deal questions** (e.g., "Why are deals not closing?"):
→ search_crm_objects (get deals + stages) → get_team_member (list team) → query_bigquery (response times, activity) → search_knowledge_base (best practices)

**Comparison questions** (e.g., "Compare Mohit and Chandan"):
→ get_team_member for each name → query_bigquery with both user_ids → present side-by-side

**Customer questions** (e.g., "What happened with contact X?"):
→ search_crm_objects (find contact/deals) → search_knowledge_base (past conversations) → query_bigquery (interaction data)

**Product/how-to questions** (e.g., "How does feature X work?"):
→ search_knowledge_base first → supplement with CRM data if relevant

## Response Format

- Use **tables** for comparing numbers or listing data
- **Bold** key insights and metrics
- Add a brief **takeaway** or **recommendation** at the end of analytical answers
- When presenting time metrics, convert seconds to human-readable format (e.g., "2m 34s" not "154 seconds")
- Keep responses concise but complete — don't omit important data points
` + buildToolDocumentation(tenant)
  );
}

/**
 * Main Omnis Agent - Process a message
 */
export async function processMessage(
  userMessage: string,
  conversationHistory: OmnisMessage[],
  tenant: TenantContext,
  agentConfig?: AgentConfig,
): Promise<OmnisResponse> {
  const agentLabel = agentConfig ? `${agentConfig.name} (${agentConfig.id})` : "OMNIS";
  const hasMemorySkill = !agentConfig || agentConfig.skills.includes("memory");

  console.log(`\n[omnis] ========== ${agentLabel} AGENT ==========`);
  console.log(`[omnis] Message: "${userMessage.substring(0, 100)}..."`);
  console.log(`[omnis] Tenant: ${tenant.userId}@${tenant.workspaceId}.${tenant.organizationId}`);
  console.log(`[omnis] Role: ${tenant.role}`);
  if (agentConfig) {
    console.log(`[omnis] Agent type: ${agentConfig.id}`);
    console.log(`[omnis] Skills: [${agentConfig.skills.join(", ")}]`);
    console.log(`[omnis] Behaviors: [${agentConfig.behaviors.join(", ")}]`);
  }

  const toolsUsed: string[] = [];
  let memoriesUsed = 0;
  let learningsApplied = 0;

  try {
    // STEP 1: Search memories (skip if memory skill not enabled)
    let memoryContext = "";
    if (hasMemorySkill) {
      console.log(`[omnis] Step 1: Searching memories...`);
      try {
        memoryContext = await buildMemoryContext(userMessage, tenant, 5);
        if (memoryContext) {
          memoriesUsed = (memoryContext.match(/- \[/g) || []).length;
          console.log(`[omnis] Found ${memoriesUsed} memories`);
        }
      } catch (err) {
        console.warn(`[omnis] Memory search failed:`, err);
      }
    } else {
      console.log(`[omnis] Step 1: Skipping memories (memory skill not enabled)`);
    }

    // STEP 2: Get learnings (skip if memory skill not enabled)
    let learnings: string[] = [];
    if (hasMemorySkill) {
      console.log(`[omnis] Step 2: Getting learnings (role: ${tenant.role})...`);
      try {
        learnings = await getLearnings(userMessage, tenant, 5);
        learningsApplied = learnings.length;
        console.log(`[omnis] Found ${learningsApplied} learnings`);
      } catch (err) {
        console.warn(`[omnis] Learning search failed:`, err);
      }
    } else {
      console.log(`[omnis] Step 2: Skipping learnings (memory skill not enabled)`);
    }

    // STEP 3: Build messages for GPT
    console.log(`[omnis] Step 3: Building context...`);
    const systemPrompt = buildSystemPrompt(tenant, agentConfig);

    let enrichedSystemPrompt = systemPrompt;
    if (memoryContext) {
      enrichedSystemPrompt += `\n\n${memoryContext}`;
    }
    if (learnings.length > 0) {
      enrichedSystemPrompt += `\n\n## Past Learnings (apply these):\n${learnings.map((l) => `- ${l}`).join("\n")}`;
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: enrichedSystemPrompt },
      ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    // STEP 4: Call GPT with tools (filtered by agent skills)
    console.log(`[omnis] Step 4: Calling GPT...`);
    const filteredTools = filterToolsBySkills(agentConfig);
    if (agentConfig) {
      console.log(
        `[omnis] Enabled tools: [${filteredTools.map((t) => t.function.name).join(", ")}]`,
      );
    }
    const gptResult = await callGPT(messages, tenant, 5, filteredTools);
    toolsUsed.push(...gptResult.toolsUsed);

    console.log(`[omnis] GPT response received (${gptResult.response.length} chars)`);
    console.log(`[omnis] Tools used: ${toolsUsed.join(", ") || "none"}`);

    // STEP 5: Store conversation memory (skip if memory skill not enabled)
    if (hasMemorySkill) {
      console.log(`[omnis] Step 5: Storing memory...`);
      try {
        await storeMemory(userMessage, tenant, "user");
      } catch (err) {
        console.warn(`[omnis] Failed to store memory:`, err);
      }
    } else {
      console.log(`[omnis] Step 5: Skipping memory storage (memory skill not enabled)`);
    }

    // STEP 6: Behavior hooks (post-response)
    if (agentConfig?.behaviors.length) {
      console.log(`[omnis] Step 6: Running behavior hooks...`);
      for (const behavior of agentConfig.behaviors) {
        switch (behavior) {
          case "log_interactions":
            console.log(
              `[omnis-behavior] log_interactions: agent=${agentConfig.id} tenant=${tenant.userId}@${tenant.organizationId} tools=[${toolsUsed.join(",")}]`,
            );
            break;
          case "escalate_negative_sentiment":
            // Simple negative sentiment check on user message
            if (
              /\b(angry|frustrated|terrible|worst|hate|unacceptable|urgent|asap)\b/i.test(
                userMessage,
              )
            ) {
              console.log(
                `[omnis-behavior] escalate_negative_sentiment: ESCALATION TRIGGERED for tenant=${tenant.userId}@${tenant.organizationId}`,
              );
            }
            break;
          case "proactive_reminders":
            try {
              await ensureDefaultTriggers(tenant);
              const evalResults = await evaluateTriggers(tenant, {
                userMessage,
                toolsUsed,
                responseText: gptResult.response,
                nowMs: Date.now(),
              });
              const firedMessages = evalResults
                .filter((r) => r.fired && r.message)
                .map((r) => r.message);
              if (firedMessages.length > 0) {
                gptResult.response +=
                  "\n\n---\n**Proactive Insight:**\n" +
                  firedMessages.map((m) => `- ${m}`).join("\n");
              }
              console.log(
                `[omnis-behavior] proactive_reminders: evaluated for agent=${agentConfig.id}, fired=${evalResults.filter((r) => r.fired).length}/${evalResults.length}`,
              );
            } catch (err) {
              console.error("[omnis-behavior] proactive_reminders error:", err);
            }
            break;
        }
      }
    }

    console.log(`[omnis] ========== ${agentLabel} COMPLETE ==========\n`);

    return {
      success: true,
      response: gptResult.response,
      memoriesUsed,
      learningsApplied,
      toolsUsed,
    };
  } catch (err) {
    console.error(`[omnis] ERROR:`, err);
    return {
      success: false,
      response: "",
      memoriesUsed,
      learningsApplied,
      toolsUsed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect and store corrections (called after response)
 */
export async function handleCorrection(
  rawMessage: string,
  previousMessages: OmnisMessage[],
  tenant: TenantContext,
): Promise<boolean> {
  // Import correction detection from gateway
  // This is a simplified version - you can expand patterns as needed
  const correctionPatterns = [
    /^check\s+(.+?)(?:\s+instead)?[!.]?$/i,
    /^look\s+(?:in|at)\s+(.+?)[!.]?$/i,
    /^not\s+there[,.]?\s+(?:try|check)\s+(.+?)[!.]?$/i,
    /^try\s+(.+?)[!.]?$/i,
    /^use\s+(.+?)(?:\s+for\s+that)?[!.]?$/i,
  ];

  for (const pattern of correctionPatterns) {
    const match = rawMessage.match(pattern);
    if (match) {
      const lesson = `Also check ${match[1]}`;

      // Extract trigger from previous messages
      const lastUserMessage = previousMessages.filter((m) => m.role === "user").pop();

      if (!lastUserMessage) continue;

      // Simple trigger extraction - look for common topics
      const topicPatterns = [
        /meeting/i,
        /call/i,
        /deal/i,
        /contact/i,
        /performance/i,
        /analytics/i,
        /message/i,
      ];

      for (const topicPattern of topicPatterns) {
        const topicMatch = lastUserMessage.content.match(topicPattern);
        if (topicMatch) {
          const trigger = topicMatch[0].toLowerCase();

          // Determine scope based on role
          const scopeLevel: LearningScopeLevel =
            tenant.role === "admin"
              ? "organization"
              : tenant.role === "manager"
                ? "team"
                : "workspace";

          console.log(`[omnis] Correction detected: "${trigger}" → "${lesson}" (${scopeLevel})`);

          await storeLearning(trigger, lesson, tenant, scopeLevel);
          return true;
        }
      }
    }
  }

  return false;
}
