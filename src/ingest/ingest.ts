import type Database from "better-sqlite3";
import type { MemoryType } from "../core/memory.js";
import { syncOne } from "../sleep/sync.js";

export interface IngestBlock {
  title: string;
  content: string;
}

export interface IngestExtractedItem {
  index: number;
  title: string;
  content: string;
  type: MemoryType;
  uri: string;
}

export interface IngestDryRunDetail {
  index: number;
  type: MemoryType;
  uri: string;
  preview: string;
}

export interface IngestWriteDetail {
  index: number;
  type: MemoryType;
  uri: string;
  action: "added" | "updated" | "merged" | "skipped";
  reason: string;
  memoryId?: string;
}

export interface IngestResult {
  extracted: number;
  written: number;
  skipped: number;
  dry_run: boolean;
  details: Array<IngestDryRunDetail | IngestWriteDetail>;
}

export interface IngestRunOptions {
  text: string;
  source?: string;
  dryRun?: boolean;
  agentId?: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64) || "item";
}

export function classifyIngestType(text: string): MemoryType {
  const lower = text.toLowerCase();

  if (/##\s*身份|\bidentity\b|\b我是\b|我是/.test(text)) {
    return "identity";
  }
  if (/##\s*情感|❤️|💕|爱你|感动|难过|开心|害怕|想念|表白/.test(text)) {
    return "emotion";
  }
  if (/##\s*决策|##\s*技术|选型|教训|\bknowledge\b|⚠️|复盘|经验/.test(text)) {
    return "knowledge";
  }
  if (/\d{4}-\d{2}-\d{2}|发生了|完成了|今天|昨日|刚刚|部署|上线/.test(text)) {
    return "event";
  }

  // Fallback: concise bullet/item memory is usually operational knowledge.
  if (lower.length <= 12) return "event";
  return "knowledge";
}

export function splitIngestBlocks(text: string): IngestBlock[] {
  const headingRegex = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(headingRegex)];
  const blocks: IngestBlock[] = [];

  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const start = match.index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
      const raw = text.slice(start, end).trim();
      const lines = raw.split("\n");
      const title = lines[0].replace(/^##\s+/, "").trim();
      const content = lines.slice(1).join("\n").trim();
      if (content) blocks.push({ title, content });
    }
    return blocks;
  }

  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);

  if (bullets.length > 0) {
    return bullets.map((content, i) => ({ title: `bullet-${i + 1}`, content }));
  }

  const plain = text.trim();
  if (!plain) return [];
  return [{ title: "ingest", content: plain }];
}

export function extractIngestItems(text: string, source?: string): IngestExtractedItem[] {
  const blocks = splitIngestBlocks(text);

  return blocks.map((block, index) => {
    const merged = `${block.title}\n${block.content}`;
    const type = classifyIngestType(merged);
    const domain = type === "identity" ? "core" : type;
    const sourcePart = slugify(source ?? "ingest");
    const uri = `${domain}://ingest/${sourcePart}/${index + 1}-${slugify(block.title)}`;

    return {
      index,
      title: block.title,
      content: block.content,
      type,
      uri,
    };
  });
}

export function ingestText(db: Database.Database, options: IngestRunOptions): IngestResult {
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
    const result = syncOne(db, {
      content: item.content,
      type: item.type,
      uri: item.uri,
      source: `auto:${options.source ?? "ingest"}`,
      agent_id: agentId,
    });

    if (result.action === "added" || result.action === "updated" || result.action === "merged") {
      written++;
    } else {
      skipped++;
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
