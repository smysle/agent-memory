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
  emotion_tag?: string;
  source_session?: string;
  source_context?: string;
  observed_at?: string;
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
    emotion_tag: input.emotion_tag,
    source_session: input.source_session,
    source_context: input.source_context,
    observed_at: input.observed_at,
  });
}
