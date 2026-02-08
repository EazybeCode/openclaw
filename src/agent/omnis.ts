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
        "Query BigQuery for analytics data like response times, message counts, performance metrics",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to execute against BigQuery",
          },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_hubspot",
      description: "Search HubSpot CRM for deals, contacts, notes, meetings",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search_deals", "search_contacts", "get_notes", "get_meetings"],
            description: "The HubSpot action to perform",
          },
          query: {
            type: "string",
            description: "Optional search query or filter",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_team_member",
      description: "Get team member info or find user_id from name",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["find", "list"],
            description: "'find' to search by name, 'list' to get all members",
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

      case "search_hubspot": {
        const action = args.action as string;
        const query = (args.query as string) || "";
        const result = await executePythonTool("/app/skills/hubspot-mcp/scripts/hubspot.py", [
          "--org-id",
          tenant.organizationId,
          "--workspace-id",
          tenant.workspaceId,
          "call",
          `hubspot_${action}`,
          ...(query ? [query] : []),
        ]);
        console.log(`[omnis] HubSpot result: ${result.substring(0, 200)}...`);
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

## Your Capabilities
You have access to these tools:
1. **query_bigquery** - Get analytics data (response times, message counts, performance)
2. **search_hubspot** - Search CRM for deals, contacts, notes, meetings
3. **get_team_member** - Find team members by name or list all
4. **search_knowledge_base** - Search product documentation and past conversations

## Guidelines
- Always use tools to get real data before answering
- For comparisons (e.g., "compare A and B"), get data for both first
- When searching for people, use get_team_member to find their user_id first
- Be concise and data-driven in your responses
- Format data in tables when appropriate
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
