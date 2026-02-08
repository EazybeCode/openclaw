import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import {
  buildMemoryContext,
  storeMemory,
  storeLearning,
  getLearnings,
} from "../memory/mem0-client.js";
import { defaultRuntime } from "../runtime.js";
import {
  extractTenantFromRequest,
  validateTenant,
  getAllScopeKeys,
  tenantToString,
  buildTenantSystemContext,
  hasTenantHeaders,
  type TenantContext,
} from "../tenant/index.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import { getBearerToken, resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";

// REV AGENT URL for planning and orchestration
const REV_AGENT_URL = process.env.REV_AGENT_URL || "http://localhost:8001";

/**
 * Call REV AGENT for planning and orchestration
 */
async function callRevAgent(
  query: string,
  orgId: string,
  workspaceId: string,
  userId: string,
): Promise<{ response: string; reasoning_trace?: string[] } | null> {
  try {
    console.log(`[rev-agent] Calling ${REV_AGENT_URL}/api/v1/chat`);

    const response = await fetch(`${REV_AGENT_URL}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        org_id: orgId,
        workspace_id: workspaceId,
        user_id: parseInt(userId, 10) || 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(`[rev-agent] HTTP ${response.status}: ${response.statusText} - ${errorBody}`);
      return null;
    }

    const result = await response.json();
    if (result.response) {
      console.log(`[rev-agent] Success: ${result.response.substring(0, 100)}...`);
      return { response: result.response, reasoning_trace: result.reasoning_trace };
    }

    console.warn(
      `[rev-agent] No response field in result:`,
      JSON.stringify(result).substring(0, 200),
    );
    return null;
  } catch (err) {
    console.warn(`[rev-agent] Error: ${err}`);
    return null;
  }
}

/**
 * Search Qdrant knowledge base for relevant information
 */
async function searchQdrant(query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, 10000);

    try {
      const child = spawn("python3", ["/app/skills/qdrant-mcp/scripts/qdrant.py", "search", query]);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          console.warn(`[qdrant] Search failed: ${stderr || "no output"}`);
          resolve(null);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        console.warn(`[qdrant] Spawn error: ${err.message}`);
        resolve(null);
      });
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[qdrant] Error: ${err}`);
      resolve(null);
    }
  });
}

/**
 * Check if the message should trigger a Qdrant knowledge base search.
 * Skip for analytics/comparison queries that should use BigQuery instead.
 */
function shouldSearchKnowledgeBase(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Skip Qdrant for analytics/metrics/comparison queries - these should use BigQuery
  const analyticsPatterns = [
    /compare\s+\w+\s+(and|vs|with)\s+\w+/i, // "compare X and Y"
    /performance|metrics|analytics|stats/i,
    /response\s*time|avg\s*response/i,
    /message\s*count|total\s*messages/i,
    /how\s+(many|much)|count|sum|average/i,
    /top\s+\d+|best|worst|fastest|slowest/i,
    /last\s+(week|month|day|\d+\s*days)/i,
  ];

  if (analyticsPatterns.some((p) => p.test(lowerMessage))) {
    return false; // Don't search Qdrant for analytics queries
  }

  // Search Qdrant for general knowledge questions
  return true;
}

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
  // Multi-tenant fields
  workspace_id?: unknown;
  org_id?: unknown;
  source?: unknown;
};

// TenantContext is now imported from ../tenant/index.js

// ============================================
// SELF-IMPROVEMENT: CORRECTION DETECTION
// ============================================

interface CorrectionResult {
  isCorrection: boolean;
  trigger?: string;
  lesson?: string;
}

/**
 * Detect if the current message is a correction to a previous failed response
 * Patterns detected:
 * - "check X instead"
 * - "look in Y"
 * - "not there, try Z"
 * - "you should have checked X"
 * - "actually, it's in Y"
 * - "use X for that"
 */
function detectCorrection(
  currentMessage: string,
  previousMessages: OpenAiChatMessage[],
): CorrectionResult {
  // Pattern definitions with capture groups for trigger/lesson extraction
  const correctionPatterns: Array<{
    pattern: RegExp;
    extractLesson: (
      match: RegExpMatchArray,
      original: string,
    ) => { trigger?: string; lesson: string };
  }> = [
    {
      // "check hubspot notes" or "check X instead"
      pattern: /^check\s+(.+?)(?:\s+instead)?[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Also check ${match[1]}`,
      }),
    },
    {
      // "look in hubspot" or "look at X"
      pattern: /^look\s+(?:in|at)\s+(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Look in ${match[1]}`,
      }),
    },
    {
      // "not there, try hubspot" or "not there, check X"
      pattern: /^not\s+there[,.]?\s+(?:try|check)\s+(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Also check ${match[1]}`,
      }),
    },
    {
      // "you should have checked hubspot"
      pattern: /^you\s+should\s+(?:have\s+)?check(?:ed)?\s+(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Should check ${match[1]}`,
      }),
    },
    {
      // "actually, it's in hubspot" or "actually it's in X"
      pattern: /^actually[,.]?\s+(?:it'?s?|they(?:'re)?|that'?s?)\s+(?:in|on|at)\s+(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Check ${match[1]}`,
      }),
    },
    {
      // "use hubspot for that" or "use X"
      pattern: /^use\s+(.+?)(?:\s+for\s+that)?[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Use ${match[1]}`,
      }),
    },
    {
      // "try hubspot" or "try looking in X"
      pattern: /^try\s+(?:looking\s+(?:in|at)\s+)?(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Try ${match[1]}`,
      }),
    },
    {
      // "it's in hubspot notes" or "they're in X"
      pattern: /^(?:it'?s?|they(?:'re)?|that'?s?)\s+(?:in|on|at)\s+(.+?)[!.]?$/i,
      extractLesson: (match, _original) => ({
        lesson: `Check ${match[1]}`,
      }),
    },
  ];

  // Try to match correction patterns
  for (const { pattern, extractLesson } of correctionPatterns) {
    const match = currentMessage.match(pattern);
    if (match) {
      const { lesson } = extractLesson(match, currentMessage);

      // Extract trigger from previous user message context
      const trigger = extractTriggerFromHistory(previousMessages);

      if (trigger && lesson) {
        return {
          isCorrection: true,
          trigger,
          lesson,
        };
      }
    }
  }

  return { isCorrection: false };
}

/**
 * Extract the main topic/trigger from recent conversation history
 * Looks at the last user message before a failed assistant response
 */
function extractTriggerFromHistory(messages: OpenAiChatMessage[]): string | undefined {
  // Look for the pattern: user question -> assistant response -> user correction
  // We want to extract keywords from the original user question

  const lastUserMessages: string[] = [];

  for (let i = messages.length - 1; i >= 0 && lastUserMessages.length < 3; i--) {
    const msg = messages[i];
    if (msg?.role === "user") {
      const content = extractTextContent(msg.content);
      if (content) {
        lastUserMessages.unshift(content);
      }
    }
  }

  if (lastUserMessages.length < 2) {
    return undefined;
  }

  // The trigger is likely from the second-to-last user message (the original query)
  const originalQuery = lastUserMessages[lastUserMessages.length - 2];

  // Extract key nouns/topics from the query
  const triggerWords = extractKeyTerms(originalQuery);

  return triggerWords.length > 0 ? triggerWords[0] : undefined;
}

/**
 * Extract key terms from a query that could serve as trigger words
 */
function extractKeyTerms(query: string): string[] {
  const lowerQuery = query.toLowerCase();

  // Common topic patterns to look for
  const topicPatterns = [
    /meeting(?:s)?/i,
    /call(?:s)?/i,
    /note(?:s)?/i,
    /deal(?:s)?/i,
    /contact(?:s)?/i,
    /task(?:s)?/i,
    /performance/i,
    /analytics/i,
    /response\s*time/i,
    /message(?:s)?/i,
    /customer(?:s)?/i,
    /lead(?:s)?/i,
    /sales/i,
    /report(?:s)?/i,
    /schedule/i,
    /calendar/i,
    /appointment(?:s)?/i,
    /reminder(?:s)?/i,
    /follow[\s-]?up(?:s)?/i,
    /pipeline/i,
    /revenue/i,
    /team/i,
    /agent(?:s)?/i,
  ];

  const terms: string[] = [];

  for (const pattern of topicPatterns) {
    const match = lowerQuery.match(pattern);
    if (match) {
      terms.push(match[0].replace(/\s+/g, " ").trim());
    }
  }

  return terms;
}

/**
 * Build enriched query with past learnings appended
 */
function buildEnrichedQuery(query: string, learnings: string[]): string {
  if (learnings.length === 0) {
    return query;
  }

  return `${query}

## Past Learnings (apply these):
${learnings.map((l) => `- ${l}`).join("\n")}`;
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: Array<{ role: "user" | "assistant" | "tool"; entry: HistoryEntry }> =
    [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const content = extractTextContent(msg.content).trim();
    if (!role || !content) {
      continue;
    }
    if (role === "system" || role === "developer") {
      systemParts.push(content);
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: content },
    });
  }

  let message = "";
  if (conversationEntries.length > 0) {
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) {
      currentIndex = conversationEntries.length - 1;
    }
    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/chat/completions") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? 1024 * 1024);
  if (body === undefined) {
    return true;
  }

  const payload = coerceRequest(body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  // Extract tenant context from headers and body
  const tenant = extractTenantFromRequest(req.headers, body as Record<string, unknown>);
  const tenantValidation = validateTenant(tenant);
  const hasTenant = hasTenantHeaders(req.headers);

  // Log tenant info if present
  if (hasTenant) {
    console.log(`[openai-http] Tenant: ${tenantToString(tenant)}`);
    console.log(`[openai-http] Role: ${tenant.role}`);
    console.log(`[openai-http] Scopes: ${getAllScopeKeys(tenant).join(", ")}`);
  }

  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);

  // Add tenant context and memories to system prompt if tenant is valid
  let extraSystemPrompt = prompt.extraSystemPrompt || "";
  if (hasTenant && tenantValidation.ok) {
    const tenantContext = buildTenantSystemContext(tenant);
    extraSystemPrompt = tenantContext + (extraSystemPrompt ? "\n\n" + extraSystemPrompt : "");

    // Retrieve relevant memories from Mem0
    try {
      const memoryContext = await buildMemoryContext(prompt.message, tenant, 5);
      if (memoryContext) {
        extraSystemPrompt = extraSystemPrompt + "\n\n" + memoryContext;
        console.log(`[openai-http] Mem0: Retrieved memories for ${tenantToString(tenant)}`);
      }
    } catch (err) {
      console.warn(`[openai-http] Mem0 error:`, err);
    }

    // RAG: Search Qdrant knowledge base for relevant context
    if (shouldSearchKnowledgeBase(prompt.message)) {
      console.log(`[openai-http] Qdrant: Searching for "${prompt.message.substring(0, 50)}..."`);
      try {
        const qdrantResults = await searchQdrant(prompt.message);
        if (qdrantResults) {
          extraSystemPrompt =
            extraSystemPrompt +
            `\n\n## Knowledge Base Search Results\n\nThe following are REAL conversations and documentation from Eazybe. Extract relevant information to answer the user's question. These are authoritative sources - use them confidently:\n\n${qdrantResults}\n\n---\nBased on the above search results, synthesize a helpful answer. Do NOT say you couldn't find information if the results contain relevant data.`;
          console.log(`[openai-http] Qdrant: Found ${qdrantResults.length} chars of results`);
        } else {
          console.log(`[openai-http] Qdrant: No results found`);
        }
      } catch (err) {
        console.warn(`[openai-http] Qdrant error:`, err);
      }
    }
  }
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();

  if (!stream) {
    try {
      let content: string;

      // Route ALL tenant queries to REV AGENT for planning
      if (hasTenant && tenantValidation.ok) {
        console.log(`[learning] ========== LEARNING FLOW START ==========`);
        console.log(`[learning] Query: "${prompt.message.substring(0, 100)}..."`);
        console.log(`[learning] Org: ${tenant.organizationId}`);

        // SELF-IMPROVEMENT: Retrieve learnings and enrich query
        let enrichedMessage = prompt.message;
        try {
          console.log(`[learning] Calling getLearnings...`);
          const learnings = await getLearnings(prompt.message, tenant, 5);
          console.log(`[learning] getLearnings returned ${learnings.length} learnings`);

          if (learnings.length > 0) {
            enrichedMessage = buildEnrichedQuery(prompt.message, learnings);
            console.log(`[learning] Applied ${learnings.length} learnings to query`);
            console.log(`[learning] Enriched query:\n${enrichedMessage.substring(0, 300)}...`);
          } else {
            console.log(`[learning] No learnings found, using original query`);
          }
        } catch (err) {
          console.warn(`[learning] Failed to retrieve learnings:`, err);
        }

        console.log(`[openai-http] REV AGENT: Routing query for planning`);
        const revAgentResult = await callRevAgent(
          enrichedMessage,
          tenant.organizationId,
          tenant.workspaceId,
          tenant.userId,
        );

        if (revAgentResult?.response) {
          content = revAgentResult.response;
          console.log(`[openai-http] REV AGENT: Got response`);
        } else {
          // Fallback to OpenClaw if REV AGENT unavailable
          console.log(`[openai-http] REV AGENT: Unavailable, falling back to OpenClaw`);
          const result = await agentCommand(
            {
              message: enrichedMessage,
              extraSystemPrompt,
              sessionKey,
              runId,
              deliver: false,
              messageChannel: "webchat",
              bestEffortDeliver: false,
            },
            defaultRuntime,
            deps,
          );

          const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
          content =
            Array.isArray(payloads) && payloads.length > 0
              ? payloads
                  .map((p) => (typeof p.text === "string" ? p.text : ""))
                  .filter(Boolean)
                  .join("\n\n")
              : "No response from OpenClaw.";
        }

        // SELF-IMPROVEMENT: Detect and store corrections
        // Extract raw last user message (not the formatted prompt.message which includes history)
        console.log(`[learning] ========== CORRECTION DETECTION ==========`);
        const allMessages = asMessages(payload.messages);
        const lastUserMsg = allMessages.filter((m) => m.role === "user").pop();
        const rawLastUserMessage = lastUserMsg ? extractTextContent(lastUserMsg.content) : "";

        console.log(`[learning] Raw last user message: "${rawLastUserMessage}"`);
        console.log(`[learning] Total messages in conversation: ${allMessages.length}`);

        if (rawLastUserMessage) {
          const correction = detectCorrection(rawLastUserMessage, allMessages);
          console.log(`[learning] Correction detected: ${correction.isCorrection}`);
          if (correction.isCorrection) {
            console.log(`[learning] Trigger: "${correction.trigger}"`);
            console.log(`[learning] Lesson: "${correction.lesson}"`);
          }

          if (correction.isCorrection && correction.trigger && correction.lesson) {
            console.log(`[learning] Storing learning at USER level...`);
            // Store at user level by default (personal learning)
            // Can be promoted to org level later if needed
            storeLearning(correction.trigger, correction.lesson, tenant, "user")
              .then((stored) => {
                if (stored) {
                  console.log(
                    `[learning] SUCCESS: Stored USER correction: "${correction.trigger}" → "${correction.lesson}"`,
                  );
                } else {
                  console.log(`[learning] FAILED: Could not store correction`);
                }
              })
              .catch((err) => {
                console.warn(`[learning] ERROR: Failed to store correction:`, err);
              });
          } else {
            console.log(`[learning] No correction detected in this message`);
          }
        } else {
          console.log(`[learning] No raw user message found`);
        }
        console.log(`[learning] ========== LEARNING FLOW END ==========`);
      } else {
        // No tenant = direct OpenClaw
        const result = await agentCommand(
          {
            message: prompt.message,
            extraSystemPrompt,
            sessionKey,
            runId,
            deliver: false,
            messageChannel: "webchat",
            bestEffortDeliver: false,
          },
          defaultRuntime,
          deps,
        );

        const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
        content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from OpenClaw.";
      }

      // Store conversation to Mem0 - it automatically extracts relevant memories
      if (hasTenant && tenantValidation.ok) {
        storeMemory(prompt.message, tenant, "user")
          .then((stored) => {
            if (stored) {
              console.log(`[openai-http] Mem0: Stored memory for ${tenantToString(tenant)}`);
            }
          })
          .catch((err) => {
            console.warn(`[openai-http] Mem0 store error:`, err);
          });
      }

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err), type: "api_error" },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" } }],
        });
      }

      sawAssistantDelta = true;
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: null,
          },
        ],
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          extraSystemPrompt,
          sessionKey,
          runId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      if (closed) {
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeSse(res, {
            id: runId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: "assistant" } }],
          });
        }

        const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from OpenClaw.";

        sawAssistantDelta = true;
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        });
      }
    } catch (err) {
      if (closed) {
        return;
      }
      writeSse(res, {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: `Error: ${String(err)}` },
            finish_reason: "stop",
          },
        ],
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
