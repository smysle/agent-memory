// AgentMemory — Markdown ingest and structured extraction
import type Database from "better-sqlite3";
import { syncOne } from "../sleep/sync.js";
import type { MemoryType } from "../core/memory.js";

export interface IngestExtractedItem {
  index: number;
  type: MemoryType;
  uri?: string;
  content: string;
}

export interface IngestRunOptions {
  text: string;
  source?: string;
  dryRun?: boolean;
  agentId?: string;
}

export interface IngestWriteDetail {
  index: number;
  type: MemoryType;
  uri?: string;
  preview?: string;
  action?: "added" | "updated" | "merged" | "skipped";
  reason?: string;
  memoryId?: string;
}

export interface IngestResult {
  extracted: number;
  written: number;
  skipped: number;
  dry_run: boolean;
  details: IngestWriteDetail[];
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

export function classifyIngestType(title: string): MemoryType {
  const normalized = title.toLowerCase();
  if (normalized.includes("情感") || normalized.includes("emotion")) return "emotion";
  if (normalized.includes("事件") || normalized.includes("event") || normalized.includes("journal")) return "event";
  if (normalized.includes("身份") || normalized.includes("identity") || normalized.includes("about")) return "identity";
  return "knowledge";
}

export function splitIngestBlocks(text: string): Array<{ title: string; body: string }> {
  const sections = text.split(/^##\s+/m).filter((section) => section.trim());
  if (sections.length === 0) {
    return [{ title: "knowledge", body: text.trim() }];
  }

  return sections.map((section) => {
    const [titleLine, ...rest] = section.split("\n");
    return {
      title: titleLine?.trim() || "knowledge",
      body: rest.join("\n").trim(),
    };
  }).filter((section) => section.body.length > 0);
}

export function extractIngestItems(text: string, source?: string): IngestExtractedItem[] {
  const blocks = splitIngestBlocks(text);
  const items: IngestExtractedItem[] = [];
  let index = 0;

  for (const block of blocks) {
    const type = classifyIngestType(block.title);
    const bulletItems = block.body
      .split(/\n+/)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    const lines = bulletItems.length > 0 ? bulletItems : [block.body.trim()];

    for (const line of lines) {
      // Skip low-value status observations that pollute the memory store
      if (isIngestNoise(line)) continue;

      index += 1;
      const uri = type === "identity"
        ? `core://ingest/${slugify(block.title)}/${index}`
        : `${type}://${slugify(source ?? "ingest")}/${index}`;

      items.push({
        index,
        type,
        uri,
        content: line,
      });
    }
  }

  return items;
}

/**
 * Noise filter: skip heartbeat observations, status dumps, and other
 * ephemeral status lines that should stay in daily markdown, not in
 * the curated memory store.
 */
const NOISE_PATTERNS: RegExp[] = [
  /HEARTBEAT_OK/i,
  /安静模式/,
  /安静待命/,
  /不打扰/,
  /无新.{0,4}(delta|变化|事项|进展)/,
  /无变化/,
  /无紧急/,
  /深夜时段/,
  /继续安静/,
  /openclaw (status|gateway status|security audit|update status)/i,
  /session_status/,
  /危险区协议/,
  /没有紧急/,
  /没有新增状态变化/,
  /仍为.*critical/,
  /基线(未变|不变|仍)/,
  /PR\s*#\d+\s*(无变化|状态无变化)/,
  /距上次心跳/,
  /轻量复查/,
  /cron 会话.*\d+k/,
];

function isIngestNoise(content: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(content));
}

export async function ingestText(db: Database.Database, options: IngestRunOptions): Promise<IngestResult> {
  const extracted = extractIngestItems(options.text, options.source);
  const dryRun = options.dryRun ?? false;
  const agentId = options.agentId ?? "default";

  if (dryRun) {
    return {
      extracted: extracted.length,
      written: 0,
      skipped: extracted.length,
      dry_run: true,
      details: extracted.map((item) => ({
        index: item.index,
        type: item.type,
        uri: item.uri,
        preview: item.content.slice(0, 80),
      })),
    };
  }

  let written = 0;
  let skipped = 0;
  const details: IngestWriteDetail[] = [];

  for (const item of extracted) {
    const result = await syncOne(db, {
      content: item.content,
      type: item.type,
      uri: item.uri,
      source: `auto:${options.source ?? "ingest"}`,
      agent_id: agentId,
    });

    if (result.action === "added" || result.action === "updated" || result.action === "merged") {
      written += 1;
    } else {
      skipped += 1;
    }

    details.push({
      index: item.index,
      type: item.type,
      uri: item.uri,
      action: result.action,
      reason: result.reason,
      memoryId: result.memoryId,
    });
  }

  return {
    extracted: extracted.length,
    written,
    skipped,
    dry_run: false,
    details,
  };
}
