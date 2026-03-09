import type { CreateMemoryInput, Memory, MemoryType } from "./memory.js";

export interface MergePlan {
  strategy: "replace" | "append_evidence" | "synthesize" | "compact_timeline";
  content: string;
  aliases?: string[];
  notes?: string[];
}

export interface MergeContext {
  existing: Memory;
  incoming: Pick<CreateMemoryInput, "content" | "type" | "source"> & { observed_at?: string | null };
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function splitClauses(content: string): string[] {
  return content
    .split(/[\n；;。.!?！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mergeAliases(existing: string, incoming: string, content: string): string[] | undefined {
  const aliases = uniqueNonEmpty([
    existing !== content ? existing : undefined,
    incoming !== content ? incoming : undefined,
  ]);
  return aliases.length > 0 ? aliases : undefined;
}

function replaceIdentity(context: MergeContext): MergePlan {
  const content = context.incoming.content.trim();
  return {
    strategy: "replace",
    content,
    aliases: mergeAliases(context.existing.content, context.incoming.content, content),
    notes: ["identity canonicalized to the newest authoritative phrasing"],
  };
}

function appendEmotionEvidence(context: MergeContext): MergePlan {
  const lines = uniqueNonEmpty([
    ...context.existing.content.split(/\n+/),
    context.incoming.content,
  ]);

  const content = lines.length <= 1
    ? lines[0] ?? context.incoming.content.trim()
    : [lines[0], "", ...lines.slice(1).map((line) => `- ${line.replace(/^-\s*/, "")}`)].join("\n");

  return {
    strategy: "append_evidence",
    content,
    aliases: mergeAliases(context.existing.content, context.incoming.content, content),
    notes: ["emotion evidence appended to preserve timeline without duplicating identical lines"],
  };
}

function synthesizeKnowledge(context: MergeContext): MergePlan {
  const clauses = uniqueNonEmpty([
    ...splitClauses(context.existing.content),
    ...splitClauses(context.incoming.content),
  ]);

  const content = clauses.length <= 1 ? clauses[0] ?? context.incoming.content.trim() : clauses.join("；");

  return {
    strategy: "synthesize",
    content,
    aliases: mergeAliases(context.existing.content, context.incoming.content, content),
    notes: ["knowledge statements synthesized into a canonical summary"],
  };
}

function compactEventTimeline(context: MergeContext): MergePlan {
  const points = uniqueNonEmpty([
    ...context.existing.content.split(/\n+/),
    context.incoming.content,
  ]).map((line) => line.replace(/^-\s*/, ""));

  const content = points.length <= 1
    ? points[0] ?? context.incoming.content.trim()
    : ["Timeline:", ...points.map((line) => `- ${line}`)].join("\n");

  return {
    strategy: "compact_timeline",
    content,
    aliases: mergeAliases(context.existing.content, context.incoming.content, content),
    notes: ["event observations compacted into a single timeline window"],
  };
}

export function buildMergePlan(context: MergeContext): MergePlan {
  const type = (context.incoming.type ?? context.existing.type) as MemoryType;

  switch (type) {
    case "identity":
      return replaceIdentity(context);
    case "emotion":
      return appendEmotionEvidence(context);
    case "knowledge":
      return synthesizeKnowledge(context);
    case "event":
      return compactEventTimeline(context);
  }
}
