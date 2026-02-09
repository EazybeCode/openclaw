# Agent Customization (Phase 6)

## Overview

The agent customization system lets you define multiple agent personas (Sales, Support, Analytics, etc.) via a markdown config file. Each agent gets a custom system prompt, selectively enabled tools, and configurable behaviors. The gateway routes to the right agent based on a request header.

---

## Architecture

```
src/agent/
├── agent-config.ts          # Types, SkillName, BehaviorName, SKILL_TO_TOOLS mapping
├── agent-config-parser.ts   # Parses agents.md markdown into AgentConfig[]
├── agent-config-registry.ts # Singleton registry - loads once, lookup by ID
├── agents.md                # Agent definitions (edit this to add/modify agents)
├── omnis.ts                 # Main agent - accepts optional AgentConfig
└── AGENT-CUSTOMIZATION.md   # This file

src/gateway/
└── openai-http.ts           # Reads x-agent-type header, passes AgentConfig to omnis
```

---

## Request Flow

```
Client                         Gateway (openai-http.ts)              Registry                  Omnis (omnis.ts)
──────                         ────────────────────────              ────────                  ────────────────
POST /v1/chat/completions
Headers:
  x-agent-type: sales-agent
  x-org-id: 902
  ...
                          ───→ 1. Extract tenant from headers
                               2. Read x-agent-type header
                                  (or agentType from body)
                                                                ───→ 3. getAgentConfig("sales-agent")
                                                                     Looks up in Map loaded
                                                                     from agents.md at startup
                                                                ←─── Returns AgentConfig
                                                                       {
                                                                         id: "sales-agent",
                                                                         skills: [hubspot, bigquery, team, memory],
                                                                         behaviors: [log_interactions, ...],
                                                                         systemPromptTemplate: "You are a Sales..."
                                                                       }
                          ───→ 4. Pass agentConfig to
                                  omnisProcessMessage()
                                                                                          ───→ 5. Check skills:
                                                                                               - memory in skills? → search memories & learnings
                                                                                               - Build custom system prompt (template + tool docs)
                                                                                               - Filter TOOLS array by skills
                                                                                               - Call GPT with filtered tools
                                                                                               - Run behavior hooks
                                                                                          ←─── Return response
                          ←─── 6. Send OpenAI-compatible JSON response
```

**No `x-agent-type` header?** → `agentConfig` is `undefined` → everything works exactly like before (default Omnis with all tools). 100% backwards compatible.

**Unknown agent type?** → Logs a warning, falls back to default Omnis.

---

## How to Create a New Agent

Edit `src/agent/agents.md` and add a new `## ` section:

```markdown
## Onboarding Agent

### System Prompt

You are an Onboarding Agent for Eazybe.

## Current User Context

- Organization ID: {{org_id}}
- Workspace ID: {{workspace_id}}
- Team ID: {{team_id}}
- User ID: {{user_id}}
- Role: {{role}}
- Surface: {{surface}}

## Your Role

You help new customers get set up. You answer product questions
from the knowledge base and help them understand their team structure.

### Skills

- qdrant
- team
- memory

### Behaviors

- log_interactions
```

That's it. After rebuild/restart:

- The parser auto-generates the ID `onboarding-agent` from the name
- It gets `search_knowledge_base` + `get_team_member` tools (no HubSpot, no BigQuery)
- Call it with `x-agent-type: onboarding-agent`

### Markdown Format Rules

- Each agent starts with `## Agent Name` (H2 heading)
- The ID is auto-generated as kebab-case from the name (e.g. "Sales Agent" → `sales-agent`)
- Required section: `### System Prompt` — the custom prompt template
- Optional section: `### Skills` — bullet list or comma-separated
- Optional section: `### Behaviors` — bullet list or comma-separated
- Template variables: `{{org_id}}`, `{{workspace_id}}`, `{{team_id}}`, `{{user_id}}`, `{{role}}`, `{{surface}}`

---

## Available Skills

| Skill      | GPT Tools Enabled                     | Purpose                           |
| ---------- | ------------------------------------- | --------------------------------- |
| `hubspot`  | `search_crm_objects`, `search_owners` | CRM data (deals, contacts)        |
| `bigquery` | `query_bigquery`                      | Analytics queries                 |
| `qdrant`   | `search_knowledge_base`               | Knowledge base search             |
| `team`     | `get_team_member`                     | Team member lookup                |
| `memory`   | _(none — controls Mem0 client)_       | Memory search, learnings, storage |

The mapping lives in `SKILL_TO_TOOLS` in `agent-config.ts`. To add a new skill:

1. Add to the `SkillName` type
2. Add to `SKILL_TO_TOOLS`
3. Add to `KNOWN_SKILLS`
4. Add the tool definition to `TOOLS` array in `omnis.ts`
5. Add the tool execution handler in `executeTool()` in `omnis.ts`

---

## Available Behaviors

| Behavior                      | What It Does                                         |
| ----------------------------- | ---------------------------------------------------- |
| `log_interactions`            | Logs agent/tenant/tools info after each response     |
| `proactive_reminders`         | Hook point for proactive follow-up suggestions       |
| `escalate_negative_sentiment` | Flags messages with negative keywords for escalation |

To add a new behavior:

1. Add to the `BehaviorName` type in `agent-config.ts`
2. Add to `KNOWN_BEHAVIORS` in `agent-config.ts`
3. Add the `case` handler in the behavior hooks section of `processMessage()` in `omnis.ts`

---

## API Usage

### Via Header (recommended)

```
POST /v1/chat/completions
Headers:
  x-agent-type: sales-agent
  x-org-id: 902
  x-workspace-id: 12839
  Authorization: Bearer <token>

Body:
  { "messages": [{ "role": "user", "content": "Show me latest deals" }] }
```

### Via Body Field (alternative)

```json
{
  "agentType": "sales-agent",
  "messages": [{ "role": "user", "content": "Show me latest deals" }]
}
```

### Default (no agent type)

```
POST /v1/chat/completions
Headers:
  x-org-id: 902
  ...

Body:
  { "messages": [{ "role": "user", "content": "Show me latest deals" }] }
```

This uses the default Omnis agent with all tools — same as before Phase 6.

---

## Current Agents (in agents.md)

| Agent           | ID                | Skills                          | Behaviors                                     |
| --------------- | ----------------- | ------------------------------- | --------------------------------------------- |
| Sales Agent     | `sales-agent`     | hubspot, bigquery, team, memory | log_interactions, proactive_reminders         |
| Support Agent   | `support-agent`   | hubspot, qdrant, memory         | log_interactions, escalate_negative_sentiment |
| Analytics Agent | `analytics-agent` | bigquery, team, memory          | log_interactions                              |

---

## Configuration

| Env Variable        | Default                               | Purpose                             |
| ------------------- | ------------------------------------- | ----------------------------------- |
| `AGENT_CONFIG_PATH` | `src/agent/agents.md` (auto-resolved) | Override path to agents config file |

---

## File Responsibilities

| File                       | What It Does                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-config.ts`          | Types (`AgentConfig`, `SkillName`, `BehaviorName`), `SKILL_TO_TOOLS` mapping, `resolveToolNames()`                                    |
| `agent-config-parser.ts`   | Parses markdown → `AgentConfig[]`. Splits on H2, extracts H3 sections, validates skills/behaviors                                     |
| `agent-config-registry.ts` | Singleton Map. Loads from `agents.md` on first access. `getAgentConfig(id)`, `listAgentTypes()`                                       |
| `agents.md`                | The actual agent definitions. Edit this file to add/modify agents                                                                     |
| `omnis.ts`                 | `filterToolsBySkills()`, `buildToolDocumentation()`, `substituteTemplateVars()`, updated `buildSystemPrompt()` and `processMessage()` |
| `openai-http.ts`           | Reads `x-agent-type` header, resolves config, passes to `processMessage()`                                                            |
