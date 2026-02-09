// ============================================
// AGENT CONFIG PARSER - Markdown → AgentConfig[]
// ============================================

import {
  type AgentConfig,
  type SkillName,
  type BehaviorName,
  KNOWN_SKILLS,
  KNOWN_BEHAVIORS,
} from "./agent-config.js";

/**
 * Convert a name like "Sales Agent" to kebab-case "sales-agent".
 */
function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract content under a given H3 heading from a block of markdown text.
 * Returns the content between the matched H3 and the next H3 (or end of block).
 */
function extractH3Section(block: string, heading: string): string | undefined {
  const pattern = new RegExp(`^###\\s+${heading}\\s*$`, "im");
  const match = block.match(pattern);
  if (!match || match.index === undefined) return undefined;

  const start = match.index + match[0].length;
  const rest = block.slice(start);

  // Find next H3 or end
  const nextH3 = rest.search(/^###\s/m);
  const section = nextH3 >= 0 ? rest.slice(0, nextH3) : rest;
  return section.trim();
}

/**
 * Parse a comma-separated or newline-separated list of items.
 * Handles both "- item" bullet lists and "item1, item2" inline lists.
 */
function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Parse a markdown string containing agent definitions.
 * Each agent is defined under an H2 heading (## Agent Name).
 * Sub-sections are H3 headings: ### System Prompt, ### Skills, ### Behaviors
 */
export function parseAgentConfigs(markdown: string): AgentConfig[] {
  const configs: AgentConfig[] = [];

  // Split on H2 headings – each section is one agent
  const sections = markdown.split(/^##\s+/m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const name = (lines[0] ?? "").trim();
    if (!name) continue;

    const id = toKebabCase(name);
    const body = lines.slice(1).join("\n");

    // Extract sub-sections
    const systemPromptRaw = extractH3Section(body, "System Prompt");
    const skillsRaw = extractH3Section(body, "Skills");
    const behaviorsRaw = extractH3Section(body, "Behaviors");

    if (!systemPromptRaw) {
      console.warn(`[agent-config-parser] Agent "${name}" missing ### System Prompt – skipping`);
      continue;
    }

    // Parse skills
    const skills: SkillName[] = [];
    if (skillsRaw) {
      for (const item of parseList(skillsRaw)) {
        const normalized = item.toLowerCase().replace(/\s+/g, "_");
        if (KNOWN_SKILLS.has(normalized)) {
          skills.push(normalized as SkillName);
        } else {
          console.warn(`[agent-config-parser] Agent "${name}": unknown skill "${item}" – ignored`);
        }
      }
    }

    // Parse behaviors
    const behaviors: BehaviorName[] = [];
    if (behaviorsRaw) {
      for (const item of parseList(behaviorsRaw)) {
        const normalized = item.toLowerCase().replace(/\s+/g, "_");
        if (KNOWN_BEHAVIORS.has(normalized)) {
          behaviors.push(normalized as BehaviorName);
        } else {
          console.warn(
            `[agent-config-parser] Agent "${name}": unknown behavior "${item}" – ignored`,
          );
        }
      }
    }

    configs.push({
      id,
      name,
      systemPromptTemplate: systemPromptRaw,
      skills,
      behaviors,
    });

    console.log(
      `[agent-config-parser] Loaded agent "${name}" (${id}) – skills: [${skills.join(", ")}], behaviors: [${behaviors.join(", ")}]`,
    );
  }

  return configs;
}
