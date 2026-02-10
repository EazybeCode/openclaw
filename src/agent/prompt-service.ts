// ============================================
// PROMPT SERVICE - Load prompts from MongoDB
// ============================================
// Connects to eazybe-ai.system-prompts collection
// and fetches prompt content by prompt_name.
// ============================================

import { MongoClient, type Collection, type Document } from "mongodb";

const MONGODB_URL =
  process.env.MONGODB_URL ||
  "mongodb+srv://akshayvats:bfXzOD0hUH12wg9rxi4l@mongodb-99e99061-o95a30e35.database.cloud.ovh.us/admin?replicaSet=replicaset&tls=true";

const DATABASE = "eazybe-ai";
const COLLECTION = "system-prompts";

let client: MongoClient | undefined;
let collection: Collection<Document> | undefined;

function getCollection(): Collection<Document> {
  if (!collection) {
    client = new MongoClient(MONGODB_URL);
    const db = client.db(DATABASE);
    collection = db.collection(COLLECTION);
  }
  return collection;
}

/**
 * Fetch a prompt's description from MongoDB by prompt_name.
 * Returns the description string, or undefined if not found / on error.
 */
export async function getPrompt(promptName: string): Promise<string | undefined> {
  try {
    const coll = getCollection();
    const doc = await coll.findOne({ prompt_name: promptName });
    if (doc?.description && typeof doc.description === "string") {
      console.log(`[prompt-service] Loaded prompt from DB: ${promptName}`);
      return doc.description.trim();
    }
    console.log(`[prompt-service] Prompt not found in DB: ${promptName}`);
    return undefined;
  } catch (err) {
    console.warn(`[prompt-service] Failed to load prompt '${promptName}':`, err);
    return undefined;
  }
}

/**
 * Close the MongoDB connection (call on shutdown).
 */
export async function closePromptService(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // ignore
    }
    client = undefined;
    collection = undefined;
  }
}
