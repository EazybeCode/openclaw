import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { getAgentConfig, initAgentRegistry } from "../agent/agent-config-registry.js";
import { getCustomAgent, toAgentConfig } from "../agent/custom-agent-service.js";
import {
  processMessage as omnisProcessMessage,
  handleCorrection as omnisHandleCorrection,
  type OmnisMessage,
} from "../agent/omnis.js";
import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { storeMemory, buildMemoryContext, getLearnings } from "../memory/mem0-client.js";
import { defaultRuntime } from "../runtime.js";
import {
  extractTenantFromRequest,
  validateTenant,
  getAllScopeKeys,
  tenantToString,
  hasTenantHeaders,
  buildTenantSystemContext,
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

// Initialize agent config registry at module load (loads from markdown + enriches from MongoDB)
await initAgentRegistry();

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

// NOTE: Qdrant search removed - REV AGENT handles knowledge base search via MCP tools

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
  // Agent customization
  agentType?: unknown;
};

// TenantContext is now imported from ../tenant/index.js
// Correction detection is now handled by Omnis Agent (src/agent/omnis.ts)

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

  // Resolve agent type from header or body
  // Checks built-in agents first, then custom agents from MongoDB
  const agentTypeRaw =
    (typeof req.headers["x-agent-type"] === "string" ? req.headers["x-agent-type"] : undefined) ||
    (typeof payload.agentType === "string" ? payload.agentType : undefined);

  let agentConfig = agentTypeRaw ? getAgentConfig(agentTypeRaw) : undefined;

  // If not found in built-in registry, check custom agents in MongoDB
  if (agentTypeRaw && !agentConfig && hasTenant) {
    try {
      const customAgent = await getCustomAgent(agentTypeRaw, tenant.organizationId);
      if (customAgent) {
        agentConfig = toAgentConfig(customAgent) as typeof agentConfig;
        console.log(
          `[openai-http] Custom agent from DB: ${customAgent.agent_id} (${customAgent.agent_name})`,
        );
      }
    } catch (err) {
      console.warn(`[openai-http] Failed to load custom agent "${agentTypeRaw}" from DB:`, err);
    }
  }

  if (agentTypeRaw) {
    if (agentConfig) {
      console.log(`[openai-http] Agent type: ${agentConfig.id} (${agentConfig.name})`);
    } else {
      console.warn(
        `[openai-http] Unknown agent type "${agentTypeRaw}" – falling back to default Omnis`,
      );
    }
  }

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

    // NOTE: Qdrant search removed - REV AGENT handles this via MCP tools
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

      // Route ALL tenant queries through OMNIS AGENT (unified agent with memory + learnings + GPT + tools)
      // Fallback chain: OMNIS → REV AGENT → OpenClaw
      if (hasTenant && tenantValidation.ok) {
        console.log(
          `\n[omnis-gateway] ╔════════════════════════════════════════════════════════════╗`,
        );
        console.log(
          `[omnis-gateway] ║           ${agentConfig ? `${agentConfig.name.toUpperCase()} - CUSTOM AGENT` : "OMNIS AGENT - UNIFIED PROCESSING"}                 ║`,
        );
        console.log(
          `[omnis-gateway] ╚════════════════════════════════════════════════════════════╝`,
        );
        console.log(`[omnis-gateway] Query: "${prompt.message.substring(0, 100)}..."`);
        console.log(`[omnis-gateway] Tenant: ${tenantToString(tenant)}`);
        console.log(`[omnis-gateway] Role: ${tenant.role}`);

        // Build conversation history from previous messages
        const allMessages = asMessages(payload.messages);
        const conversationHistory: OmnisMessage[] = allMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: extractTextContent(m.content),
          }))
          .slice(0, -1); // Exclude the current message

        // STEP 1: Try OMNIS AGENT first
        console.log(
          `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
        );
        console.log(
          `[omnis-gateway] STEP 1: Trying OMNIS AGENT (GPT + Memory + Learnings + Tools)`,
        );
        console.log(
          `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
        );

        const omnisResult = await omnisProcessMessage(
          prompt.message,
          conversationHistory,
          tenant,
          agentConfig,
        );

        if (omnisResult.success && omnisResult.response) {
          content = omnisResult.response;
          console.log(`[omnis-gateway] ✅ OMNIS SUCCESS`);
          console.log(`[omnis-gateway]    - Memories used: ${omnisResult.memoriesUsed}`);
          console.log(`[omnis-gateway]    - Learnings applied: ${omnisResult.learningsApplied}`);
          console.log(
            `[omnis-gateway]    - Tools used: ${omnisResult.toolsUsed.join(", ") || "none"}`,
          );
          console.log(`[omnis-gateway]    - Response length: ${content.length} chars`);
        } else {
          // STEP 2: Fallback to REV AGENT
          console.log(
            `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
          );
          console.log(`[omnis-gateway] ⚠️  OMNIS FAILED: ${omnisResult.error || "Unknown error"}`);
          console.log(`[omnis-gateway] STEP 2: FALLBACK to REV AGENT`);
          console.log(
            `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
          );

          // Get learnings to enrich query for REV AGENT
          let enrichedMessage = prompt.message;
          try {
            const learnings = await getLearnings(prompt.message, tenant, 5);
            if (learnings.length > 0) {
              enrichedMessage = buildEnrichedQuery(prompt.message, learnings);
              console.log(
                `[omnis-gateway] Applied ${learnings.length} learnings to REV AGENT query`,
              );
            }
          } catch (err) {
            console.warn(`[omnis-gateway] Failed to retrieve learnings for fallback:`, err);
          }

          const revAgentResult = await callRevAgent(
            enrichedMessage,
            tenant.organizationId,
            tenant.workspaceId,
            tenant.userId,
          );

          if (revAgentResult?.response) {
            content = revAgentResult.response;
            console.log(`[omnis-gateway] ✅ REV AGENT SUCCESS (fallback)`);
            console.log(`[omnis-gateway]    - Response length: ${content.length} chars`);
          } else {
            // STEP 3: Fallback to OpenClaw
            console.log(
              `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
            );
            console.log(`[omnis-gateway] ⚠️  REV AGENT FAILED`);
            console.log(`[omnis-gateway] STEP 3: FALLBACK to OpenClaw (base agent)`);
            console.log(
              `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
            );

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

            console.log(`[omnis-gateway] ✅ OpenClaw SUCCESS (fallback)`);
            console.log(`[omnis-gateway]    - Response length: ${content.length} chars`);
          }
        }

        // SELF-IMPROVEMENT: Detect and store corrections using Omnis handler
        console.log(
          `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
        );
        console.log(`[omnis-gateway] CORRECTION DETECTION`);
        console.log(
          `[omnis-gateway] ─────────────────────────────────────────────────────────────`,
        );

        const lastUserMsg = allMessages.filter((m) => m.role === "user").pop();
        const rawLastUserMessage = lastUserMsg ? extractTextContent(lastUserMsg.content) : "";

        if (rawLastUserMessage) {
          console.log(
            `[omnis-gateway] Checking for correction in: "${rawLastUserMessage.substring(0, 50)}..."`,
          );

          // Use Omnis correction handler
          omnisHandleCorrection(rawLastUserMessage, conversationHistory, tenant)
            .then((wasCorrection) => {
              if (wasCorrection) {
                console.log(`[omnis-gateway] ✅ Correction detected and stored`);
              } else {
                console.log(`[omnis-gateway] No correction detected`);
              }
            })
            .catch((err) => {
              console.warn(`[omnis-gateway] Correction handling error:`, err);
            });
        }

        console.log(
          `[omnis-gateway] ╔════════════════════════════════════════════════════════════╗`,
        );
        console.log(
          `[omnis-gateway] ║           OMNIS PROCESSING COMPLETE                        ║`,
        );
        console.log(
          `[omnis-gateway] ╚════════════════════════════════════════════════════════════╝\n`,
        );
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
