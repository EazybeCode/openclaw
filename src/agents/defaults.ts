// Defaults for agent metadata when upstream does not supply them.
// Model id uses OpenAI's GPT-4o for multi-tenant gateway.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-4o";
// Context window: GPT-4o supports ~128k tokens.
export const DEFAULT_CONTEXT_TOKENS = 128_000;
