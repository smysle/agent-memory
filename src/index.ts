// AgentMemory v2 — Main library entry point
export { openDatabase, type DbOptions } from "./core/db.js";
export {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  recordAccess,
  countMemories,
  contentHash,
  type Memory,
  type MemoryType,
  type Priority,
  type CreateMemoryInput,
  type UpdateMemoryInput,
} from "./core/memory.js";
export {
  createPath,
  getPath,
  getPathByUri,
  getPathsByMemory,
  getPathsByDomain,
  getPathsByPrefix,
  deletePath,
  parseUri,
  type Path,
} from "./core/path.js";
export {
  createLink,
  getLinks,
  getOutgoingLinks,
  traverse,
  deleteLink,
  type Link,
  type RelationType,
} from "./core/link.js";
export {
  createSnapshot,
  getSnapshots,
  getSnapshot,
  rollback,
  type Snapshot,
  type SnapshotAction,
} from "./core/snapshot.js";
export { guard, type GuardResult, type GuardAction } from "./core/guard.js";
