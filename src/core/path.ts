// AgentMemory v2 — URI path system (from nocturne's Content-Path separation)
import type Database from "better-sqlite3";
import { newId, now } from "./db.js";

export interface Path {
  id: string;
  memory_id: string;
  agent_id: string;
  uri: string;
  alias: string | null;
  domain: string;
  created_at: string;
}

// Valid domains (extensible)
const DEFAULT_DOMAINS = new Set(["core", "emotion", "knowledge", "event", "system"]);

export function parseUri(uri: string): { domain: string; path: string } {
  const match = uri.match(/^([a-z]+):\/\/(.+)$/);
  if (!match) throw new Error(`Invalid URI: ${uri}. Expected format: domain://path`);
  return { domain: match[1], path: match[2] };
}

export function createPath(
  db: Database.Database,
  memoryId: string,
  uri: string,
  alias?: string,
  validDomains?: Set<string>,
  agent_id?: string,
): Path {
  const { domain } = parseUri(uri);
  const domains = validDomains ?? DEFAULT_DOMAINS;
  if (!domains.has(domain)) {
    throw new Error(`Invalid domain "${domain}". Valid: ${[...domains].join(", ")}`);
  }

  const memoryAgent = (db.prepare("SELECT agent_id FROM memories WHERE id = ?").get(memoryId) as { agent_id: string } | undefined)?.agent_id;
  if (!memoryAgent) throw new Error(`Memory not found: ${memoryId}`);
  if (agent_id && agent_id !== memoryAgent) {
    throw new Error(`Agent mismatch for path: memory agent_id=${memoryAgent}, requested agent_id=${agent_id}`);
  }
  const agentId = agent_id ?? memoryAgent;

  // Check URI uniqueness
  const existing = db.prepare("SELECT id FROM paths WHERE agent_id = ? AND uri = ?").get(agentId, uri) as
    | { id: string }
    | undefined;
  if (existing) {
    throw new Error(`URI already exists: ${uri}`);
  }

  const id = newId();
  db.prepare(
    "INSERT INTO paths (id, memory_id, agent_id, uri, alias, domain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, memoryId, agentId, uri, alias ?? null, domain, now());

  return getPath(db, id)!;
}

export function getPath(db: Database.Database, id: string): Path | null {
  return (db.prepare("SELECT * FROM paths WHERE id = ?").get(id) as Path) ?? null;
}

export function getPathByUri(db: Database.Database, uri: string, agent_id = "default"): Path | null {
  return (db.prepare("SELECT * FROM paths WHERE agent_id = ? AND uri = ?").get(agent_id, uri) as Path) ?? null;
}

export function getPathsByMemory(db: Database.Database, memoryId: string): Path[] {
  return db.prepare("SELECT * FROM paths WHERE memory_id = ?").all(memoryId) as Path[];
}

export function getPathsByDomain(db: Database.Database, domain: string, agent_id = "default"): Path[] {
  return db
    .prepare("SELECT * FROM paths WHERE agent_id = ? AND domain = ? ORDER BY uri")
    .all(agent_id, domain) as Path[];
}

export function getPathsByPrefix(db: Database.Database, prefix: string, agent_id = "default"): Path[] {
  return db
    .prepare("SELECT * FROM paths WHERE agent_id = ? AND uri LIKE ? ORDER BY uri")
    .all(agent_id, `${prefix}%`) as Path[];
}

export function deletePath(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM paths WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deletePathsByMemory(db: Database.Database, memoryId: string): number {
  const result = db.prepare("DELETE FROM paths WHERE memory_id = ?").run(memoryId);
  return result.changes;
}
