export { MemoryIndexManager } from "./manager.js";
export type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";
export { getMemorySearchManager, type MemorySearchManagerResult } from "./search-manager.js";

// Mem0 cloud memory with tenant scoping
export {
  Mem0Client,
  getMem0Client,
  buildMemoryContext,
  storeMemory,
  type Mem0Config,
  type Mem0Memory,
  type Mem0SearchResult,
} from "./mem0-client.js";
