import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../src/core/db.js';
import { syncOne } from '../src/sleep/sync.js';
import { searchBM25 } from '../src/search/bm25.js';
import { runDecay } from '../src/sleep/decay.js';
import { boot } from '../src/sleep/boot.js';
import { recordAccess } from '../src/core/memory.js';
import { exportMemories } from '../src/core/export.js';
import { guard } from '../src/core/guard.js';
import { unlinkSync, mkdirSync, readdirSync, rmdirSync } from 'fs';
import type Database from 'better-sqlite3';

const DB = '/tmp/test-integ-am.db';
let db: Database.Database;

beforeAll(() => { db = openDatabase({ path: DB }); });
afterAll(() => {
  db.close();
  [DB, DB+'-wal', DB+'-shm'].forEach(f => { try { unlinkSync(f); } catch {} });
});

describe('Integration', () => {
  it('stores Chinese memories', () => {
    expect(syncOne(db, { content: '我是小金管家，主人叫Jay King', type: 'identity', uri: 'core://agent/identity' }).action).toBe('added');
    expect(syncOne(db, { content: 'BTC日线VolumeBreakout实盘400U', type: 'knowledge', uri: 'knowledge://strategy/vb' }).action).toBe('added');
    expect(syncOne(db, { content: '可转债双低轮动采集系统已上线382只', type: 'event', uri: 'event://2026-02-20/cb' }).action).toBe('added');
  });

  it('searches Chinese content', () => {
    const r1 = searchBM25(db, '可转债');
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0].memory.content).toContain('可转债');

    const r2 = searchBM25(db, 'BTC');
    expect(r2.length).toBeGreaterThan(0);
  });

  it('updates last_accessed on recall', () => {
    const res = searchBM25(db, '可转债');
    const id = res[0].memory.id;
    recordAccess(db, id);
    const row = db.prepare('SELECT last_accessed, stability FROM memories WHERE id = ?').get(id) as any;
    expect(row.last_accessed).toBeTruthy();
    expect(row.stability).toBeGreaterThan(1.0);
  });

  it('decays using last_accessed', () => {
    const result = runDecay(db);
    expect(result).toHaveProperty('updated');
    expect(result).toHaveProperty('decayed');
  });

  it('boots with identity memories', () => {
    const b = boot(db);
    expect(b.identityMemories.length).toBe(1);
    expect(b.identityMemories[0].content).toContain('小金管家');
  });

  it('deduplicates via Write Guard', () => {
    const r = guard(db, { content: '我是小金管家，主人叫Jay King', type: 'identity', uri: 'core://agent/identity' });
    expect(['skip', 'update']).toContain(r.action);
  });

  it('exports to markdown', () => {
    const dir = '/tmp/test-am-export-integ';
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const exp = exportMemories(db, dir);
    expect(exp.exported).toBeGreaterThan(0);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    // cleanup
    files.forEach(f => { try { unlinkSync(dir + '/' + f); } catch {} });
    try { rmdirSync(dir); } catch {}
  });
});
