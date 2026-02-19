/**
 * AgentMemory — Sleep-Cycle Memory Architecture for AI Agents
 * 
 * Inspired by human sleep-cycle memory consolidation:
 *   Awake    → instant journaling (write events as they happen)
 *   Light    → periodic sync (scan recent logs, extract highlights)
 *   Deep     → compress & distill (archive old dailies, update long-term memory)
 *   Recall   → semantic search across all memory layers
 * 
 * Zero external dependencies. Pure Node.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  baseDir: '.agent-memory',
  longTermFile: 'MEMORY.md',
  dailyDir: 'daily',
  weeklyDir: 'weekly',
  archiveDir: 'archive',
  longTermMaxLines: 80,
  syncIntervalMs: 4 * 60 * 60 * 1000,  // 4 hours (light sleep)
  tidyIntervalMs: 24 * 60 * 60 * 1000, // 24 hours (deep sleep)
  maxDailyAgeDays: 7,
  distillCriteria: ['decision', 'lesson', 'preference', 'important'],
};

// ── Utilities ───────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readFileOr(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return fallback; }
}

function countLines(text) {
  return text.split('\n').filter(l => l.trim()).length;
}

// ── Core: AgentMemory ───────────────────────────────────────────────────────

class AgentMemory {
  /**
   * @param {object} config — override any DEFAULT_CONFIG keys
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.baseDir = path.resolve(this.config.baseDir);
    this.dailyDir = path.join(this.baseDir, this.config.dailyDir);
    this.weeklyDir = path.join(this.baseDir, this.config.weeklyDir);
    this.archiveDir = path.join(this.baseDir, this.config.archiveDir);
    this.longTermPath = path.join(this.baseDir, this.config.longTermFile);

    // Ensure directories
    ensureDir(this.baseDir);
    ensureDir(this.dailyDir);
    ensureDir(this.weeklyDir);
    ensureDir(this.archiveDir);

    // Initialize long-term memory if missing
    if (!fs.existsSync(this.longTermPath)) {
      fs.writeFileSync(this.longTermPath, `# Long-Term Memory\n\n_Distilled from daily notes_\n\n---\n\n`, 'utf-8');
    }

    this._syncTimer = null;
    this._tidyTimer = null;
  }

  // ── Phase 1: Awake — Instant Journaling ─────────────────────────────────

  /**
   * Write an entry to today's daily note. Like jotting something down immediately.
   * @param {string} entry — markdown text to append
   * @param {object} opts — { category: string, tags: string[] }
   */
  journal(entry, opts = {}) {
    const dailyPath = this._dailyPath(today());
    const category = opts.category || 'general';
    const tags = opts.tags ? ` [${opts.tags.join(', ')}]` : '';
    const timestamp = now();

    if (!fs.existsSync(dailyPath)) {
      fs.writeFileSync(dailyPath, `# ${today()} — Daily Notes\n\n`, 'utf-8');
    }

    const formatted = `\n## [${timestamp}] ${category}${tags}\n${entry}\n`;
    fs.appendFileSync(dailyPath, formatted, 'utf-8');

    return { file: dailyPath, timestamp, category };
  }

  /**
   * Quick-journal a key decision
   */
  decision(text) {
    return this.journal(text, { category: 'decision', tags: ['decision'] });
  }

  /**
   * Quick-journal a lesson learned
   */
  lesson(text) {
    return this.journal(text, { category: 'lesson', tags: ['lesson'] });
  }

  /**
   * Quick-journal a user preference
   */
  preference(text) {
    return this.journal(text, { category: 'preference', tags: ['preference'] });
  }

  // ── Phase 2: Light Sleep — Sync / Consolidate ───────────────────────────

  /**
   * Scan recent daily notes and extract highlights.
   * Like light sleep — organizing recent memories.
   * @param {number} days — how many days back to scan (default: 2)
   * @returns {object} — { scanned, highlights, written }
   */
  sync(days = 2) {
    const highlights = [];
    const dailyFiles = this._listDailyFiles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let scanned = 0;
    for (const file of dailyFiles) {
      const date = path.basename(file, '.md');
      if (new Date(date) < cutoff) continue;
      scanned++;

      const content = readFileOr(file);
      const entries = this._parseEntries(content);

      for (const entry of entries) {
        // Check if entry matches distill criteria
        const text = entry.body.toLowerCase();
        const matchedCriteria = this.config.distillCriteria.filter(c => 
          text.includes(c) || (entry.tags && entry.tags.some(t => t.includes(c)))
        );

        if (matchedCriteria.length > 0 || entry.category === 'decision' || entry.category === 'lesson') {
          highlights.push({
            date,
            timestamp: entry.timestamp,
            category: entry.category,
            body: entry.body.trim(),
            criteria: matchedCriteria,
          });
        }
      }
    }

    return { scanned, highlights, count: highlights.length };
  }

  // ── Phase 3: Deep Sleep — Tidy / Compress ───────────────────────────────

  /**
   * Deep memory consolidation:
   * 1. Compress old dailies (>7 days) into weekly summaries
   * 2. Distill highlights into long-term memory
   * 3. Archive compressed files
   * Like deep sleep — consolidating important memories, forgetting noise.
   * @returns {object} — { archived, distilled, longTermLines }
   */
  tidy() {
    const result = { archived: 0, distilled: 0, longTermLines: 0 };

    // Step 1: Archive old daily files
    const dailyFiles = this._listDailyFiles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.maxDailyAgeDays);

    const oldFiles = [];
    for (const file of dailyFiles) {
      const date = path.basename(file, '.md');
      if (new Date(date) < cutoff) {
        oldFiles.push(file);
      }
    }

    // Group by week and create weekly summary
    const weekGroups = {};
    for (const file of oldFiles) {
      const date = new Date(path.basename(file, '.md'));
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);

      if (!weekGroups[weekKey]) weekGroups[weekKey] = [];
      weekGroups[weekKey].push(file);
    }

    for (const [weekKey, files] of Object.entries(weekGroups)) {
      const weekPath = path.join(this.weeklyDir, `week-${weekKey}.md`);
      let summary = `# Week of ${weekKey}\n\n`;

      for (const file of files) {
        const content = readFileOr(file);
        const entries = this._parseEntries(content);
        const date = path.basename(file, '.md');
        
        if (entries.length > 0) {
          summary += `## ${date}\n`;
          for (const entry of entries) {
            summary += `- [${entry.category}] ${entry.body.trim().split('\n')[0]}\n`;
          }
          summary += '\n';
        }

        // Move to archive
        const archivePath = path.join(this.archiveDir, path.basename(file));
        fs.renameSync(file, archivePath);
        result.archived++;
      }

      fs.writeFileSync(weekPath, summary, 'utf-8');
    }

    // Step 2: Distill highlights into long-term memory
    const { highlights } = this.sync(this.config.maxDailyAgeDays);
    if (highlights.length > 0) {
      let longTerm = readFileOr(this.longTermPath);
      const currentLines = countLines(longTerm);

      // Only add if under line limit
      if (currentLines < this.config.longTermMaxLines) {
        const budget = this.config.longTermMaxLines - currentLines;
        const toAdd = highlights.slice(0, budget);

        for (const h of toAdd) {
          longTerm += `- [${h.date}] [${h.category}] ${h.body.split('\n')[0]}\n`;
          result.distilled++;
        }

        fs.writeFileSync(this.longTermPath, longTerm, 'utf-8');
      }

      result.longTermLines = countLines(readFileOr(this.longTermPath));
    }

    return result;
  }

  // ── Phase 4: Recall — Search Memory ─────────────────────────────────────

  /**
   * Search across all memory layers for relevant content.
   * Uses keyword matching (TF-IDF-like scoring).
   * @param {string} query
   * @param {object} opts — { maxResults: number, layers: string[] }
   * @returns {Array<{ source, date, score, snippet }>}
   */
  recall(query, opts = {}) {
    const maxResults = opts.maxResults || 5;
    const layers = opts.layers || ['longterm', 'daily', 'weekly'];
    const queryTerms = this._tokenize(query);
    const results = [];

    // Search long-term memory
    if (layers.includes('longterm')) {
      const content = readFileOr(this.longTermPath);
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      for (const line of lines) {
        const score = this._relevanceScore(queryTerms, line);
        if (score > 0) {
          results.push({ source: 'longterm', date: null, score, snippet: line.trim() });
        }
      }
    }

    // Search daily notes
    if (layers.includes('daily')) {
      for (const file of this._listDailyFiles()) {
        const date = path.basename(file, '.md');
        const content = readFileOr(file);
        const entries = this._parseEntries(content);
        for (const entry of entries) {
          const score = this._relevanceScore(queryTerms, entry.body);
          if (score > 0) {
            results.push({
              source: 'daily',
              date,
              score,
              snippet: entry.body.trim().slice(0, 200),
              category: entry.category,
            });
          }
        }
      }
    }

    // Search weekly summaries
    if (layers.includes('weekly')) {
      const weeklyDir = this.weeklyDir;
      if (fs.existsSync(weeklyDir)) {
        for (const file of fs.readdirSync(weeklyDir).filter(f => f.endsWith('.md'))) {
          const content = readFileOr(path.join(weeklyDir, file));
          const lines = content.split('\n').filter(l => l.trim() && l.startsWith('- '));
          for (const line of lines) {
            const score = this._relevanceScore(queryTerms, line);
            if (score > 0) {
              results.push({ source: 'weekly', date: file.replace('.md', ''), score, snippet: line.trim() });
            }
          }
        }
      }
    }

    // Sort by score descending, return top N
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  // ── Selective Forgetting ────────────────────────────────────────────────

  /**
   * Remove entries matching criteria from long-term memory.
   * Like intentional forgetting — decluttering old irrelevant memories.
   */
  forget(pattern) {
    let content = readFileOr(this.longTermPath);
    const lines = content.split('\n');
    const regex = new RegExp(pattern, 'i');
    const filtered = lines.filter(l => !regex.test(l));
    const removed = lines.length - filtered.length;
    fs.writeFileSync(this.longTermPath, filtered.join('\n'), 'utf-8');
    return { removed, remaining: countLines(filtered.join('\n')) };
  }

  // ── Auto-Scheduling (Daemon Mode) ──────────────────────────────────────

  /**
   * Start automatic memory cycles.
   * Like having a natural sleep cycle.
   */
  startCycles() {
    if (this._syncTimer) return;

    this._syncTimer = setInterval(() => {
      try { this.sync(); } catch (e) { console.error('[AgentMemory] sync error:', e.message); }
    }, this.config.syncIntervalMs);

    this._tidyTimer = setInterval(() => {
      try { this.tidy(); } catch (e) { console.error('[AgentMemory] tidy error:', e.message); }
    }, this.config.tidyIntervalMs);

    return this;
  }

  /**
   * Stop automatic cycles.
   */
  stopCycles() {
    if (this._syncTimer) clearInterval(this._syncTimer);
    if (this._tidyTimer) clearInterval(this._tidyTimer);
    this._syncTimer = null;
    this._tidyTimer = null;
    return this;
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  /**
   * Get memory statistics.
   */
  stats() {
    const dailyFiles = this._listDailyFiles();
    const weeklyFiles = fs.existsSync(this.weeklyDir) 
      ? fs.readdirSync(this.weeklyDir).filter(f => f.endsWith('.md')) 
      : [];
    const archiveFiles = fs.existsSync(this.archiveDir)
      ? fs.readdirSync(this.archiveDir).filter(f => f.endsWith('.md'))
      : [];
    const longTerm = readFileOr(this.longTermPath);

    let totalEntries = 0;
    for (const file of dailyFiles) {
      totalEntries += this._parseEntries(readFileOr(file)).length;
    }

    return {
      dailyFiles: dailyFiles.length,
      weeklyFiles: weeklyFiles.length,
      archivedFiles: archiveFiles.length,
      totalEntries,
      longTermLines: countLines(longTerm),
      longTermMaxLines: this.config.longTermMaxLines,
      longTermUsage: `${Math.round((countLines(longTerm) / this.config.longTermMaxLines) * 100)}%`,
      oldestDaily: dailyFiles.length > 0 ? path.basename(dailyFiles[0], '.md') : null,
      newestDaily: dailyFiles.length > 0 ? path.basename(dailyFiles[dailyFiles.length - 1], '.md') : null,
    };
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  _dailyPath(date) {
    return path.join(this.dailyDir, `${date}.md`);
  }

  _listDailyFiles() {
    if (!fs.existsSync(this.dailyDir)) return [];
    return fs.readdirSync(this.dailyDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => path.join(this.dailyDir, f));
  }

  _parseEntries(content) {
    const entries = [];
    const blocks = content.split(/^## /m).slice(1);

    for (const block of blocks) {
      const firstLine = block.split('\n')[0];
      const body = block.split('\n').slice(1).join('\n');
      
      // Parse: [2026-02-19 14:30:00] category [tag1, tag2]
      const match = firstLine.match(/^\[([^\]]+)\]\s*(\w+)(?:\s*\[([^\]]*)\])?/);
      if (match) {
        entries.push({
          timestamp: match[1],
          category: match[2],
          tags: match[3] ? match[3].split(',').map(t => t.trim()) : [],
          body: body.trim(),
        });
      }
    }

    return entries;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  _relevanceScore(queryTerms, text) {
    const docTerms = this._tokenize(text);
    if (docTerms.length === 0) return 0;

    let matches = 0;
    for (const qt of queryTerms) {
      for (const dt of docTerms) {
        if (dt.includes(qt) || qt.includes(dt)) {
          matches++;
          break;
        }
      }
    }

    return matches / queryTerms.length;
  }
}

module.exports = { AgentMemory, DEFAULT_CONFIG };
