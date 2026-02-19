#!/usr/bin/env node

/**
 * agent-memory CLI
 * Sleep-cycle memory for AI agents — journal, sync, tidy, recall
 */

'use strict';

const { AgentMemory } = require('../src/index.js');
const path = require('path');
const fs = require('fs');

// ── ANSI Colors ────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  purple: '\x1b[38;2;139;92;246m',
  blue: '\x1b[38;2;99;102;241m',
  cyan: '\x1b[38;2;34;211;238m',
  green: '\x1b[38;2;34;197;94m',
  yellow: '\x1b[38;2;250;204;21m',
  red: '\x1b[38;2;239;68;68m',
  gray: '\x1b[38;2;148;163;184m',
  white: '\x1b[38;2;248;250;252m',
};

function banner() {
  console.log(`
${c.purple}╔══════════════════════════════════════════════════════╗
║                                                      ║
║  ${c.white}${c.bold}  █████╗  ██████╗ ███████╗███╗   ██╗████████╗${c.purple}    ║
║  ${c.white}  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝${c.purple}    ║
║  ${c.white}  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║${c.purple}       ║
║  ${c.white}  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║${c.purple}       ║
║  ${c.white}  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║${c.purple}       ║
║  ${c.white}  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝${c.purple}       ║
║  ${c.white}${c.bold}  ███╗   ███╗███████╗███╗   ███╗${c.purple}                 ║
║  ${c.white}  ████╗ ████║██╔════╝████╗ ████║${c.purple}                 ║
║  ${c.white}  ██╔████╔██║█████╗  ██╔████╔██║${c.purple}                 ║
║  ${c.white}  ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║${c.purple}                 ║
║  ${c.white}  ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║${c.purple}                 ║
║  ${c.white}  ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝${c.purple}                 ║
║                                                      ║
║  ${c.gray}Sleep-Cycle Memory for AI Agents${c.purple}                   ║
╚══════════════════════════════════════════════════════╝${c.reset}
`);
}

function help() {
  banner();
  console.log(`${c.bold}USAGE${c.reset}
  ${c.cyan}agent-memory${c.reset} <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.green}journal${c.reset} <text>          Write an entry to today's daily note
  ${c.green}decision${c.reset} <text>         Record a decision
  ${c.green}lesson${c.reset} <text>           Record a lesson learned
  ${c.green}sync${c.reset}                    Run light-sleep consolidation (extract highlights)
  ${c.green}tidy${c.reset}                    Run deep-sleep compression (archive + distill)
  ${c.green}recall${c.reset} <query>          Search across all memory layers
  ${c.green}forget${c.reset} <pattern>        Remove matching entries from long-term memory
  ${c.green}stats${c.reset}                   Show memory statistics
  ${c.green}demo${c.reset}                    Run a full demo with sample data

${c.bold}OPTIONS${c.reset}
  ${c.yellow}--dir${c.reset} <path>            Memory directory (default: .agent-memory)
  ${c.yellow}--help, -h${c.reset}             Show this help message
  ${c.yellow}--version, -v${c.reset}          Show version number
  ${c.yellow}--json${c.reset}                 Output as JSON

${c.bold}EXAMPLES${c.reset}
  ${c.gray}# Journal an observation${c.reset}
  ${c.cyan}agent-memory journal "User prefers dark themes"${c.reset}

  ${c.gray}# Record a decision${c.reset}
  ${c.cyan}agent-memory decision "Switched from Starship to Oh My Posh"${c.reset}

  ${c.gray}# Search your memory${c.reset}
  ${c.cyan}agent-memory recall "dark theme preference"${c.reset}

  ${c.gray}# Run the full sleep cycle${c.reset}
  ${c.cyan}agent-memory tidy${c.reset}

${c.dim}  https://github.com/smysle/agent-memory${c.reset}
`);
}

// ── Demo ───────────────────────────────────────────────────────────────────

function runDemo() {
  banner();
  console.log(`${c.dim}  Running demo with temporary data...\n${c.reset}`);

  const demoDir = path.join(require('os').tmpdir(), `agent-memory-demo-${Date.now()}`);
  const mem = new AgentMemory({ baseDir: demoDir });

  // Phase 1: Awake — Journal entries
  console.log(`${c.purple}${c.bold}🌅 PHASE 1: AWAKE — Journaling${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);

  const entries = [
    { method: 'journal', args: ['Set up OpenClaw with Claude Opus 4.6 as primary model', { category: 'setup', tags: ['openclaw', 'claude'] }] },
    { method: 'decision', args: ['Use momo as API proxy — supports Claude, GPT, and Gemini'] },
    { method: 'lesson', args: ['Cache miss with 5000 key rotation costs 12x more ($1.09 vs $0.09). Use sticky sessions.'] },
    { method: 'preference', args: ['User prefers dark themes, dislikes blue-purple gradients'] },
    { method: 'journal', args: ['Installed search-layer skill — Brave + Exa + Tavily + Grok four-source parallel search', { category: 'tools' }] },
    { method: 'decision', args: ['Switch default search from Perplexity/Grok to Brave Search for speed'] },
    { method: 'lesson', args: ['exec long commands must use background mode to avoid blocking message queue'] },
    { method: 'journal', args: ['Created TokenWise project for DeveloperWeek 2026 Hackathon', { category: 'project', tags: ['hackathon', 'important'] }] },
  ];

  for (const e of entries) {
    const result = mem[e.method](...e.args);
    const icon = e.method === 'decision' ? '🎯' : e.method === 'lesson' ? '💡' : e.method === 'preference' ? '❤️' : '📝';
    console.log(`  ${icon} ${c.white}[${e.method}]${c.reset} ${e.args[0].slice(0, 70)}${e.args[0].length > 70 ? '...' : ''}`);
  }

  console.log(`\n  ${c.green}✓ ${entries.length} entries journaled${c.reset}\n`);

  // Phase 2: Light Sleep — Sync
  console.log(`${c.blue}${c.bold}🌙 PHASE 2: LIGHT SLEEP — Sync${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);

  const syncResult = mem.sync(7);
  console.log(`  ${c.white}Scanned:${c.reset}    ${c.bold}${syncResult.scanned}${c.reset} daily files`);
  console.log(`  ${c.white}Highlights:${c.reset} ${c.bold}${syncResult.count}${c.reset} entries matched distill criteria`);
  
  if (syncResult.highlights.length > 0) {
    console.log(`\n  ${c.yellow}Highlights found:${c.reset}`);
    for (const h of syncResult.highlights.slice(0, 5)) {
      console.log(`    ${c.cyan}•${c.reset} [${h.category}] ${h.body.split('\n')[0].slice(0, 60)}`);
    }
  }
  console.log();

  // Phase 3: Deep Sleep — Tidy
  console.log(`${c.purple}${c.bold}🌑 PHASE 3: DEEP SLEEP — Tidy${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);

  // Add some "old" entries to test archiving
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 10);
  const oldDateStr = oldDate.toISOString().slice(0, 10);
  const oldPath = path.join(mem.dailyDir, `${oldDateStr}.md`);
  fs.writeFileSync(oldPath, `# ${oldDateStr} — Daily Notes\n\n## [${oldDateStr} 10:00:00] decision\nDecided to use Node.js for the project\n\n## [${oldDateStr} 14:00:00] lesson\nLearned that streaming responses need special handling\n`, 'utf-8');

  const tidyResult = mem.tidy();
  console.log(`  ${c.white}Archived:${c.reset}   ${c.bold}${tidyResult.archived}${c.reset} old daily files → weekly summaries`);
  console.log(`  ${c.white}Distilled:${c.reset}  ${c.bold}${tidyResult.distilled}${c.reset} highlights → long-term memory`);
  console.log(`  ${c.white}Long-term:${c.reset}  ${c.bold}${tidyResult.longTermLines}/${mem.config.longTermMaxLines}${c.reset} lines used\n`);

  // Phase 4: Recall
  console.log(`${c.cyan}${c.bold}🔍 PHASE 4: RECALL — Semantic Search${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);

  const queries = ['cache optimization', 'dark theme', 'hackathon project'];
  for (const q of queries) {
    console.log(`\n  ${c.white}Query: "${q}"${c.reset}`);
    const results = mem.recall(q);
    if (results.length === 0) {
      console.log(`    ${c.gray}No results found${c.reset}`);
    } else {
      for (const r of results.slice(0, 3)) {
        const scoreBar = '█'.repeat(Math.round(r.score * 10)) + '░'.repeat(10 - Math.round(r.score * 10));
        console.log(`    ${c.cyan}${scoreBar}${c.reset} ${c.dim}${r.score.toFixed(2)}${c.reset} [${r.source}] ${r.snippet.slice(0, 60)}`);
      }
    }
  }

  // Stats
  console.log(`\n${c.green}${c.bold}📊 MEMORY STATS${c.reset}`);
  console.log(`${c.gray}${'─'.repeat(56)}${c.reset}`);
  const stats = mem.stats();
  console.log(`  ${c.white}Daily files:${c.reset}     ${c.bold}${stats.dailyFiles}${c.reset}`);
  console.log(`  ${c.white}Weekly files:${c.reset}    ${c.bold}${stats.weeklyFiles}${c.reset}`);
  console.log(`  ${c.white}Archived files:${c.reset}  ${c.bold}${stats.archivedFiles}${c.reset}`);
  console.log(`  ${c.white}Total entries:${c.reset}   ${c.bold}${stats.totalEntries}${c.reset}`);
  console.log(`  ${c.white}Long-term:${c.reset}       ${c.bold}${stats.longTermLines}/${stats.longTermMaxLines}${c.reset} (${stats.longTermUsage})`);
  if (stats.oldestDaily) console.log(`  ${c.white}Date range:${c.reset}      ${stats.oldestDaily} → ${stats.newestDaily}`);

  // Cleanup
  fs.rmSync(demoDir, { recursive: true, force: true });

  console.log(`\n${c.gray}${'─'.repeat(56)}${c.reset}`);
  console.log(`${c.gray}  Generated by AgentMemory • https://github.com/smysle/agent-memory${c.reset}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === '--help' || command === '-h') {
  help();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

// Parse options
const dirIndex = args.indexOf('--dir');
const baseDir = dirIndex !== -1 && args[dirIndex + 1] ? args[dirIndex + 1] : '.agent-memory';
const jsonMode = args.includes('--json');
const text = args.slice(1).filter(a => !a.startsWith('--') && a !== baseDir).join(' ');

if (command === 'demo') {
  runDemo();
  process.exit(0);
}

const mem = new AgentMemory({ baseDir });

switch (command) {
  case 'journal': {
    if (!text) { console.error('Usage: agent-memory journal <text>'); process.exit(1); }
    const result = mem.journal(text);
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`${c.green}✓${c.reset} Journaled to ${c.dim}${result.file}${c.reset}`); }
    break;
  }
  case 'decision': {
    if (!text) { console.error('Usage: agent-memory decision <text>'); process.exit(1); }
    const result = mem.decision(text);
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`${c.green}🎯${c.reset} Decision recorded`); }
    break;
  }
  case 'lesson': {
    if (!text) { console.error('Usage: agent-memory lesson <text>'); process.exit(1); }
    const result = mem.lesson(text);
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`${c.green}💡${c.reset} Lesson recorded`); }
    break;
  }
  case 'sync': {
    const result = mem.sync();
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else {
      console.log(`${c.blue}🌙 Light Sleep — Sync${c.reset}`);
      console.log(`  Scanned: ${result.scanned} files, Found: ${result.count} highlights`);
    }
    break;
  }
  case 'tidy': {
    const result = mem.tidy();
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else {
      console.log(`${c.purple}🌑 Deep Sleep — Tidy${c.reset}`);
      console.log(`  Archived: ${result.archived}, Distilled: ${result.distilled}, Long-term: ${result.longTermLines} lines`);
    }
    break;
  }
  case 'recall': {
    if (!text) { console.error('Usage: agent-memory recall <query>'); process.exit(1); }
    const results = mem.recall(text);
    if (jsonMode) { console.log(JSON.stringify(results, null, 2)); }
    else {
      console.log(`${c.cyan}🔍 Recall: "${text}"${c.reset}\n`);
      if (results.length === 0) { console.log(`  ${c.gray}No results found${c.reset}`); }
      else {
        for (const r of results) {
          console.log(`  ${c.cyan}${r.score.toFixed(2)}${c.reset} [${r.source}${r.date ? ` ${r.date}` : ''}] ${r.snippet}`);
        }
      }
    }
    break;
  }
  case 'forget': {
    if (!text) { console.error('Usage: agent-memory forget <pattern>'); process.exit(1); }
    const result = mem.forget(text);
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`${c.red}🗑️${c.reset} Removed ${result.removed} entries, ${result.remaining} remaining`); }
    break;
  }
  case 'stats': {
    const stats = mem.stats();
    if (jsonMode) { console.log(JSON.stringify(stats, null, 2)); }
    else {
      console.log(`${c.green}📊 Memory Stats${c.reset}`);
      console.log(`  Daily: ${stats.dailyFiles} | Weekly: ${stats.weeklyFiles} | Archived: ${stats.archivedFiles}`);
      console.log(`  Entries: ${stats.totalEntries} | Long-term: ${stats.longTermLines}/${stats.longTermMaxLines} (${stats.longTermUsage})`);
      if (stats.oldestDaily) console.log(`  Range: ${stats.oldestDaily} → ${stats.newestDaily}`);
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}. Run agent-memory --help`);
    process.exit(1);
}
