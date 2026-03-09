import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { join, relative, resolve } from "path";
import type Database from "better-sqlite3";
import { ingestText } from "./ingest.js";

export interface AutoIngestWatcherOptions {
  db: Database.Database;
  workspaceDir: string;
  agentId: string;
  debounceMs?: number;
  initialScan?: boolean;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface AutoIngestWatcher {
  close: () => void;
}

interface WatcherStats {
  triggers: number;
  filesProcessed: number;
  extracted: number;
  written: number;
  skipped: number;
  errors: number;
}

export function runAutoIngestWatcher(options: AutoIngestWatcherOptions): AutoIngestWatcher {
  const workspaceDir = resolve(options.workspaceDir);
  const memoryDir = join(workspaceDir, "memory");
  const memoryMdPath = join(workspaceDir, "MEMORY.md");
  const debounceMs = options.debounceMs ?? 1200;
  const initialScan = options.initialScan ?? true;
  const logger = options.logger ?? console;

  const timers = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];
  const stats: WatcherStats = {
    triggers: 0,
    filesProcessed: 0,
    extracted: 0,
    written: 0,
    skipped: 0,
    errors: 0,
  };

  let stopped = false;
  let queue: Promise<void> = Promise.resolve();

  const toSource = (absPath: string): string => {
    const rel = relative(workspaceDir, absPath).replace(/\\/g, "/");
    return rel || absPath;
  };

  const isTrackedMarkdownFile = (absPath: string): boolean => {
    if (!absPath.endsWith(".md")) return false;
    if (resolve(absPath) === memoryMdPath) return true;

    const rel = relative(memoryDir, absPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel === "") return false;
    return !rel.includes("/");
  };

  const ingestFile = async (absPath: string, reason: string): Promise<void> => {
    if (stopped) return;

    if (!existsSync(absPath)) {
      logger.log(`[auto-ingest] skip missing file: ${toSource(absPath)} (reason=${reason})`);
      return;
    }

    let isFile = false;
    try {
      isFile = statSync(absPath).isFile();
    } catch (err) {
      stats.errors += 1;
      logger.warn(`[auto-ingest] stat failed for ${toSource(absPath)}: ${String(err)}`);
      return;
    }

    if (!isFile) return;

    try {
      const text = readFileSync(absPath, "utf-8");
      const source = toSource(absPath);
      const result = await ingestText(options.db, {
        text,
        source,
        agentId: options.agentId,
      });

      stats.filesProcessed += 1;
      stats.extracted += result.extracted;
      stats.written += result.written;
      stats.skipped += result.skipped;

      logger.log(
        `[auto-ingest] file=${source} reason=${reason} extracted=${result.extracted} written=${result.written} skipped=${result.skipped}`,
      );
    } catch (err) {
      stats.errors += 1;
      logger.error(`[auto-ingest] ingest failed for ${toSource(absPath)}: ${String(err)}`);
    }
  };

  const scheduleIngest = (absPath: string, reason: string): void => {
    if (stopped) return;
    if (!isTrackedMarkdownFile(absPath)) return;

    stats.triggers += 1;

    const previous = timers.get(absPath);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      timers.delete(absPath);

      queue = queue
        .then(() => ingestFile(absPath, reason))
        .catch((err) => {
          stats.errors += 1;
          logger.error(`[auto-ingest] queue error: ${String(err)}`);
        });
    }, debounceMs);

    timers.set(absPath, timer);
  };

  const safeWatch = (dir: string, onEvent: (eventType: string, filename: string) => void): void => {
    if (!existsSync(dir)) {
      logger.warn(`[auto-ingest] watch path does not exist, skipping: ${dir}`);
      return;
    }

    try {
      const watcher = watch(dir, { persistent: true }, (eventType, filename) => {
        if (!filename) return;
        onEvent(eventType, filename.toString());
      });
      watchers.push(watcher);
      logger.log(`[auto-ingest] watching ${dir}`);
    } catch (err) {
      stats.errors += 1;
      logger.error(`[auto-ingest] failed to watch ${dir}: ${String(err)}`);
    }
  };

  safeWatch(workspaceDir, (eventType, filename) => {
    if (filename === "MEMORY.md") {
      scheduleIngest(join(workspaceDir, filename), `workspace:${eventType}`);
    }
  });

  safeWatch(memoryDir, (eventType, filename) => {
    if (filename.endsWith(".md")) {
      scheduleIngest(join(memoryDir, filename), `memory:${eventType}`);
    }
  });

  if (initialScan) {
    scheduleIngest(memoryMdPath, "initial");

    if (existsSync(memoryDir)) {
      for (const file of readdirSync(memoryDir)) {
        if (file.endsWith(".md")) {
          scheduleIngest(join(memoryDir, file), "initial");
        }
      }
    }
  }

  return {
    close: () => {
      if (stopped) return;
      stopped = true;

      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();

      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }

      logger.log(
        `[auto-ingest] stopped triggers=${stats.triggers} files=${stats.filesProcessed} extracted=${stats.extracted} written=${stats.written} skipped=${stats.skipped} errors=${stats.errors}`,
      );
    },
  };
}
