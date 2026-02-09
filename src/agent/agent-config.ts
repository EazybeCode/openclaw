// ============================================
// AGENT CONFIG - Types & Skill-to-Tool Mapping
// ============================================

export type SkillName = "hubspot" | "bigquery" | "qdrant" | "team" | "memory";

export type BehaviorName =
  | "log_interactions"
  | "proactive_reminders"
  | "escalate_negative_sentiment";

export interface AgentConfig {
  /** Kebab-case identifier, e.g. "sales-agent" */
  id: string;
  /** Human-readable name, e.g. "Sales Agent" */
  name: string;
  /** System prompt template with {{variable}} placeholders */
  systemPromptTemplate: string;
  /** Enabled skills – controls which tools are available */
  skills: SkillName[];
  /** Enabled behaviors – post-response hooks */
  behaviors: BehaviorName[];
}

/**
 * Maps each skill to the GPT tool function names it enables.
 * Memory is handled by Mem0 client, not a GPT tool.
 */
export const SKILL_TO_TOOLS: Record<SkillName, string[]> = {
  hubspot: [
    "search_crm_objects",
    "search_owners",
    "get_crm_object",
    "list_associations",
    "list_pipelines",
  ],
  bigquery: ["query_bigquery"],
  qdrant: ["search_knowledge_base"],
  team: ["get_team_member"],
  memory: [], // memory is handled by Mem0 client, not a GPT tool
};

export const KNOWN_SKILLS: ReadonlySet<string> = new Set<string>([
  "hubspot",
  "bigquery",
  "qdrant",
  "team",
  "memory",
]);

export const KNOWN_BEHAVIORS: ReadonlySet<string> = new Set<string>([
  "log_interactions",
  "proactive_reminders",
  "escalate_negative_sentiment",
]);

/**
 * Resolve skill names to the flat list of GPT tool function names.
 */
export function resolveToolNames(skills: SkillName[]): string[] {
  const names: string[] = [];
  for (const skill of skills) {
    const tools = SKILL_TO_TOOLS[skill];
    if (tools) {
      names.push(...tools);
    }
  }
  return [...new Set(names)]; // deduplicate
}
