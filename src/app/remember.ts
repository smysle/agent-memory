import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../search/embedding.js";
import { syncOne, type SyncResult } from "../sleep/sync.js";
import type { MemoryType, Priority } from "../core/memory.js";

export interface RememberInput {
  content: string;
  type?: MemoryType;
  priority?: Priority;
  emotion_val?: number;
  uri?: string;
  source?: string;
  agent_id?: string;
  provider?: EmbeddingProvider | null;
  conservative?: boolean;
}

export async function rememberMemory(
  db: Database.Database,
  input: RememberInput,
): Promise<SyncResult> {
  return syncOne(db, {
    content: input.content,
    type: input.type,
    priority: input.priority,
    emotion_val: input.emotion_val,
    uri: input.uri,
    source: input.source,
    agent_id: input.agent_id,
    provider: input.provider,
    conservative: input.conservative,
  });
}
