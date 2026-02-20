// AgentMemory v2 — Tokenizer with jieba Chinese segmentation
// Uses @node-rs/jieba for proper Chinese word segmentation,
// falls back to CJK bigram splitting if jieba unavailable.

import { readFileSync } from "fs";
import { createRequire } from "module";

interface JiebaInstance {
  cutForSearch(text: string): string[];
}

let _jieba: JiebaInstance | null | undefined; // undefined = not tried yet

/**
 * Lazily initialize jieba with built-in dictionary.
 * Returns null if @node-rs/jieba is not installed.
 */
function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;

  try {
    // Use createRequire to resolve from this package's node_modules
    const req = createRequire(import.meta.url);
    const { Jieba } = req("@node-rs/jieba");
    const dictPath = req.resolve("@node-rs/jieba/dict.txt");
    const dictBuf = readFileSync(dictPath);
    _jieba = Jieba.withDict(dictBuf) as JiebaInstance;
  } catch {
    _jieba = null;
  }
  return _jieba;
}

// Common Chinese stopwords to filter out
const STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人",
  "都", "一", "个", "上", "也", "到", "他", "没", "这", "要",
  "会", "对", "说", "而", "去", "之", "被", "她", "把", "那",
]);

/**
 * Tokenize text for FTS5 queries.
 * - Latin/numeric words: split on whitespace, filter len > 1
 * - CJK text: use jieba cutForSearch, fallback to unigram + bigram
 * Returns deduplicated token array, max 30 tokens.
 */
export function tokenize(text: string): string[] {
  const cleaned = text.replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]/g, " ");
  const tokens: string[] = [];

  // Extract Latin/numeric words
  const latinWords = cleaned
    .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  tokens.push(...latinWords);

  // Extract CJK portions
  const cjkChunks = cleaned.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g);
  if (cjkChunks && cjkChunks.length > 0) {
    const jieba = getJieba();
    for (const chunk of cjkChunks) {
      if (jieba) {
        // Use jieba for proper segmentation
        const words = jieba.cutForSearch(chunk).filter((w: string) => w.length >= 1);
        tokens.push(...words);
      } else {
        // Fallback: unigrams + bigrams
        for (const ch of chunk) {
          tokens.push(ch);
        }
        for (let i = 0; i < chunk.length - 1; i++) {
          tokens.push(chunk[i] + chunk[i + 1]);
        }
      }
    }
  }

  // Deduplicate, filter stopwords, limit
  const unique = [...new Set(tokens)]
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .slice(0, 30);

  return unique;
}

/**
 * Tokenize content for FTS5 indexing.
 * Segments CJK text and joins all tokens with spaces so FTS5's unicode61
 * tokenizer can index each word separately.
 * This ensures query-side and index-side tokenization match.
 */
export function tokenizeForIndex(text: string): string {
  const tokens = tokenize(text);
  // Also keep the original text so exact substrings still work via LIKE fallback
  return tokens.join(" ");
}