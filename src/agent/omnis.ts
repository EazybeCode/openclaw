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

// OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4-turbo-preview";

// Tool definitions for GPT function calling
const TOOLS = [
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
  {
    type: "function" as const,
    function: {
      name: "search_crm_objects",
      description:
        "Search HubSpot CRM objects (deals, contacts, companies, tickets). This is the main HubSpot tool. Use objectType to specify what to search. For filtering by owner, use filterGroups with hubspot_owner_id property.",
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
  {
    type: "function" as const,
    function: {
      name: "search_knowledge_base",
      description:
        "Search Qdrant knowledge base for product info, documentation, past conversations",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["query"],
      },
    },
  },
];

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
      case "query_bigquery": {
        const sql = args.sql as string;
        const result = await executePythonTool("/app/skills/bigquery-mcp/scripts/bigquery.py", [
          "query",
          sql,
        ]);
        console.log(`[omnis] BigQuery result: ${result.substring(0, 200)}...`);
        return result;
      }

      case "search_crm_objects": {
        // HubSpot MCP tool: search_crm_objects
        // Pass full arguments as JSON via --args flag
        const hubspotArgs: Record<string, unknown> = {};
        if (args.objectType) hubspotArgs.objectType = args.objectType;
        if (args.query) hubspotArgs.query = args.query;
        if (args.filterGroups) hubspotArgs.filterGroups = args.filterGroups;
        if (args.properties) hubspotArgs.properties = args.properties;
        if (args.limit) hubspotArgs.limit = args.limit;

        const result = await executePythonTool("/app/skills/hubspot-mcp/scripts/hubspot.py", [
          "--org-id",
          tenant.organizationId,
          "--workspace-id",
          tenant.workspaceId,
          "call",
          "search_crm_objects",
          "--args",
          JSON.stringify(hubspotArgs),
        ]);
        console.log(`[omnis] HubSpot search_crm_objects result: ${result.substring(0, 200)}...`);
        return result;
      }

      case "search_owners": {
        // HubSpot MCP tool: search_owners
        const searchQuery = (args.searchQuery as string) || "";
        const hubspotArgs = { searchQuery };

        const result = await executePythonTool("/app/skills/hubspot-mcp/scripts/hubspot.py", [
          "--org-id",
          tenant.organizationId,
          "--workspace-id",
          tenant.workspaceId,
          "call",
          "search_owners",
          "--args",
          JSON.stringify(hubspotArgs),
        ]);
        console.log(`[omnis] HubSpot search_owners result: ${result.substring(0, 200)}...`);
        return result;
      }

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
        tools: TOOLS,
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
 * Build system prompt with tenant context
 */
function buildSystemPrompt(tenant: TenantContext): string {
  return `You are Omnis, an intelligent Revenue Intelligence Agent for Eazybe.

## Current User Context
- Organization ID: ${tenant.organizationId}
- Workspace ID: ${tenant.workspaceId}
- Team ID: ${tenant.teamId}
- User ID: ${tenant.userId}
- Role: ${tenant.role}
- Surface: ${tenant.surface}

## Your Tools

### 1. query_bigquery - Analytics Data
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

-- Compare specific employees (after getting user_ids from get_team_member)
SELECT user_id,
       AVG(avg_agent_response_time_seconds) as avg_response,
       SUM(agent_message_count) as messages
FROM waba-454907.whatsapp_analytics.daily_performance_summary
WHERE org_id='${tenant.organizationId}' AND user_id IN ('14024', '1170365')
GROUP BY user_id
\`\`\`

### 2. get_team_member - Find User IDs from Names
**Use this FIRST** when user mentions names like "Mohit", "Chandan", etc.

Examples:
- "find" + name: "mohit" → returns \`{"user_id": "14024", "name": "Mohit Eazybe", ...}\`
- "find" + name: "chandan" → returns \`{"user_id": "1170365", "name": "Chandan modi", ...}\`
- "list" → returns all 37 team members with their user_ids

### 3. search_crm_objects - HubSpot CRM Data
Search deals, contacts, companies, tickets in HubSpot.

**Parameters**:
- objectType (required): "deals", "contacts", "companies", or "tickets"
- query (optional): Text search
- filterGroups (optional): Advanced filters (e.g., filter by owner)
- properties (optional): Specific fields to return
- limit (optional): Max results

**Examples**:
- Latest deals: \`search_crm_objects(objectType="deals", properties=["dealname","amount","dealstage","closedate","createdate","pipeline"], limit=5)\`
- Search contacts: \`search_crm_objects(objectType="contacts", query="John")\`
- Deals by owner: \`search_crm_objects(objectType="deals", filterGroups=[{"filters":[{"propertyName":"hubspot_owner_id","operator":"EQ","value":"456232774"}]}])\`

### 4. search_owners - Find HubSpot Sales Reps
Find owner/rep IDs by name. Use BEFORE search_crm_objects when filtering by rep.

**Example**: \`search_owners(searchQuery="Mohit")\` → returns ownerId

### 5. search_knowledge_base - Documentation
Search product docs and past conversations.

## Workflow Examples

**"Compare Mohit and Chandan performance"**:
1. get_team_member(action="find", name="mohit") → user_id: "14024"
2. get_team_member(action="find", name="chandan") → user_id: "1170365"
3. query_bigquery: SELECT user_id, AVG(avg_agent_response_time_seconds), SUM(agent_message_count) FROM waba-454907.whatsapp_analytics.daily_performance_summary WHERE org_id='${tenant.organizationId}' AND user_id IN ('14024', '1170365') GROUP BY user_id
4. Format comparison table with names

**"Give me last created deal"**:
1. search_crm_objects(objectType="deals", properties=["dealname","amount","dealstage","closedate","createdate","pipeline"], limit=5)
2. Find the most recent by createdate and present it

**"Find deals for rep Mohit"**:
1. search_owners(searchQuery="Mohit") → get ownerId
2. search_crm_objects(objectType="deals", filterGroups=[{"filters":[{"propertyName":"hubspot_owner_id","operator":"EQ","value":"<ownerId>"}]}])

**"What is the average response time?"**:
1. query_bigquery: SELECT AVG(avg_agent_response_time_seconds) FROM waba-454907.whatsapp_analytics.daily_performance_summary WHERE org_id='${tenant.organizationId}'

## Guidelines
- ALWAYS use full table: waba-454907.whatsapp_analytics.daily_performance_summary
- ALWAYS filter by org_id='${tenant.organizationId}'
- For names → get_team_member FIRST to get user_id (for BigQuery)
- For HubSpot rep filtering → search_owners FIRST to get ownerId
- Be concise, use tables for data
`;
}

/**
 * Main Omnis Agent - Process a message
 */
export async function processMessage(
  userMessage: string,
  conversationHistory: OmnisMessage[],
  tenant: TenantContext,
): Promise<OmnisResponse> {
  console.log(`\n[omnis] ========== OMNIS AGENT ==========`);
  console.log(`[omnis] Message: "${userMessage.substring(0, 100)}..."`);
  console.log(`[omnis] Tenant: ${tenant.userId}@${tenant.workspaceId}.${tenant.organizationId}`);
  console.log(`[omnis] Role: ${tenant.role}`);

  const toolsUsed: string[] = [];
  let memoriesUsed = 0;
  let learningsApplied = 0;

  try {
    // STEP 1: Search memories
    console.log(`[omnis] Step 1: Searching memories...`);
    let memoryContext = "";
    try {
      memoryContext = await buildMemoryContext(userMessage, tenant, 5);
      if (memoryContext) {
        memoriesUsed = (memoryContext.match(/- \[/g) || []).length;
        console.log(`[omnis] Found ${memoriesUsed} memories`);
      }
    } catch (err) {
      console.warn(`[omnis] Memory search failed:`, err);
    }

    // STEP 2: Get learnings (role-based)
    console.log(`[omnis] Step 2: Getting learnings (role: ${tenant.role})...`);
    let learnings: string[] = [];
    try {
      learnings = await getLearnings(userMessage, tenant, 5);
      learningsApplied = learnings.length;
      console.log(`[omnis] Found ${learningsApplied} learnings`);
    } catch (err) {
      console.warn(`[omnis] Learning search failed:`, err);
    }

    // STEP 3: Build messages for GPT
    console.log(`[omnis] Step 3: Building context...`);
    const systemPrompt = buildSystemPrompt(tenant);

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

    // STEP 4: Call GPT with tools
    console.log(`[omnis] Step 4: Calling GPT...`);
    const gptResult = await callGPT(messages, tenant);
    toolsUsed.push(...gptResult.toolsUsed);

    console.log(`[omnis] GPT response received (${gptResult.response.length} chars)`);
    console.log(`[omnis] Tools used: ${toolsUsed.join(", ") || "none"}`);

    // STEP 5: Store conversation memory
    console.log(`[omnis] Step 5: Storing memory...`);
    try {
      await storeMemory(userMessage, tenant, "user");
    } catch (err) {
      console.warn(`[omnis] Failed to store memory:`, err);
    }

    console.log(`[omnis] ========== OMNIS COMPLETE ==========\n`);

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
