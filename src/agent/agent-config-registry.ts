// ============================================
// AGENT CONFIG REGISTRY - Singleton Registry
// ============================================

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agent-config.js";
import { parseAgentConfigs } from "./agent-config-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let registry: Map<string, AgentConfig> | undefined;

/**
 * Resolve the path to the agents config file.
 * Uses AGENT_CONFIG_PATH env var if set, otherwise checks:
 * 1. Same directory as this file (works in dev with src/)
 * 2. src/agent/agents.md relative to project root (works in bundled dist/)
 */
function resolveConfigPath(): string {
  if (process.env.AGENT_CONFIG_PATH) return process.env.AGENT_CONFIG_PATH;

  // Try same directory first (works in dev)
  const sameDirPath = resolve(__dirname, "agents.md");
  if (existsSync(sameDirPath)) return sameDirPath;

  // Try src/agent/ relative to project root (works when running from dist/)
  const srcPath = resolve(__dirname, "..", "src", "agent", "agents.md");
  if (existsSync(srcPath)) return srcPath;

  // Fallback – will fail on read but with a clear error
  return sameDirPath;
}

/**
 * Load agent configs from the markdown file.
 * Lazy-initialized – only reads the file once.
 */
function ensureLoaded(): Map<string, AgentConfig> {
  if (registry) return registry;

  registry = new Map();
  const configPath = resolveConfigPath();

  try {
    const markdown = readFileSync(configPath, "utf-8");
    const configs = parseAgentConfigs(markdown);
    for (const config of configs) {
      registry.set(config.id, config);
    }
    console.log(
      `[agent-registry] Loaded ${registry.size} agent configs from ${configPath}: [${[...registry.keys()].join(", ")}]`,
    );
  } catch (err) {
    console.warn(`[agent-registry] Failed to load agent configs from ${configPath}:`, err);
  }

  return registry;
}

/**
 * Initialize the registry eagerly. Call at startup.
 */
export function initAgentRegistry(): void {
  ensureLoaded();
}

/**
 * Get an agent config by its kebab-case ID (e.g. "sales-agent").
 * Returns undefined if not found.
 */
export function getAgentConfig(id: string): AgentConfig | undefined {
  return ensureLoaded().get(id);
}

/**
 * List all registered agent type IDs.
 */
export function listAgentTypes(): string[] {
  return [...ensureLoaded().keys()];
}
