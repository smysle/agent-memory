import type Database from "better-sqlite3";
import { runDecay } from "./decay.js";
import { runTidy } from "./tidy.js";
import { runGovern } from "./govern.js";
import {
  completeMaintenanceJob,
  createInitialCheckpoint,
  createMaintenanceJob,
  failMaintenanceJob,
  findResumableMaintenanceJob,
  getMaintenanceJob,
  type MaintenancePhase,
  type MaintenanceJob,
  type ReflectCheckpoint,
  type ReflectStep,
  updateMaintenanceCheckpoint,
} from "./jobs.js";

export interface ReflectStats {
  total: number;
  avgVitality: number;
}

export interface ReflectRunners {
  decay: (db: Database.Database, opts?: { agent_id?: string }) => unknown | Promise<unknown>;
  tidy: (db: Database.Database, opts?: { agent_id?: string }) => unknown | Promise<unknown>;
  govern: (db: Database.Database, opts?: { agent_id?: string }) => unknown | Promise<unknown>;
}

export interface ReflectProgressEvent {
  status: "started" | "phase-completed" | "completed" | "failed";
  phase: MaintenancePhase | ReflectStep;
  progress: number;
  jobId?: string;
  detail?: unknown;
}

export interface ReflectOptions {
  phase: MaintenancePhase;
  agent_id?: string;
  jobId?: string;
  resume?: boolean;
  runners?: Partial<ReflectRunners>;
  onProgress?: (event: ReflectProgressEvent) => void;
}

export interface ReflectRunResult {
  job: MaintenanceJob;
  jobId: string;
  phase: MaintenancePhase;
  resumed: boolean;
  checkpoint: ReflectCheckpoint;
  results: Partial<Record<ReflectStep, unknown>>;
  before: ReflectStats;
  after: ReflectStats;
}

const DEFAULT_RUNNERS: ReflectRunners = {
  decay: (db, opts) => runDecay(db, opts),
  tidy: (db, opts) => runTidy(db, opts),
  govern: (db, opts) => runGovern(db, opts),
};

const PHASE_SEQUENCE: ReflectStep[] = ["decay", "tidy", "govern"];

function getSummaryStats(db: Database.Database, agentId?: string): ReflectStats {
  const row = agentId
    ? db.prepare("SELECT COUNT(*) as total, COALESCE(AVG(vitality), 0) as avg FROM memories WHERE agent_id = ?").get(agentId) as { total: number; avg: number }
    : db.prepare("SELECT COUNT(*) as total, COALESCE(AVG(vitality), 0) as avg FROM memories").get() as { total: number; avg: number };

  return {
    total: row.total,
    avgVitality: row.avg,
  };
}

function getPhaseSequence(phase: MaintenancePhase): ReflectStep[] {
  return phase === "all" ? [...PHASE_SEQUENCE] : [phase];
}

function resolveJob(db: Database.Database, opts: ReflectOptions): { job: MaintenanceJob; resumed: boolean } {
  if (opts.jobId) {
    const job = getMaintenanceJob(db, opts.jobId);
    if (!job) {
      throw new Error(`Maintenance job not found: ${opts.jobId}`);
    }
    if (job.phase !== opts.phase) {
      throw new Error(`Maintenance job ${opts.jobId} phase mismatch: expected ${opts.phase}, got ${job.phase}`);
    }
    return { job, resumed: true };
  }

  if (opts.resume !== false) {
    const resumable = findResumableMaintenanceJob(db, opts.phase);
    if (resumable) {
      return { job: resumable, resumed: true };
    }
  }

  return {
    job: createMaintenanceJob(db, opts.phase),
    resumed: false,
  };
}

function nextPhase(current: ReflectStep, requested: MaintenancePhase): ReflectStep | null {
  if (requested !== "all") return null;
  const index = PHASE_SEQUENCE.indexOf(current);
  return PHASE_SEQUENCE[index + 1] ?? null;
}

export async function runReflectOrchestrator(
  db: Database.Database,
  opts: ReflectOptions,
): Promise<ReflectRunResult> {
  const runners: ReflectRunners = {
    ...DEFAULT_RUNNERS,
    ...opts.runners,
  };

  const before = getSummaryStats(db, opts.agent_id);
  const { job: baseJob, resumed } = resolveJob(db, opts);
  let checkpoint = baseJob.checkpoint ?? createInitialCheckpoint(opts.phase);
  const jobId = baseJob.job_id;

  const orderedPhases = getPhaseSequence(opts.phase);
  const startPhase = checkpoint.nextPhase ?? orderedPhases[orderedPhases.length - 1] ?? "decay";
  const startIndex = Math.max(0, orderedPhases.indexOf(startPhase));
  const phasesToRun = checkpoint.nextPhase === null ? [] : orderedPhases.slice(startIndex);
  const totalPhases = Math.max(orderedPhases.length, 1);

  opts.onProgress?.({
    status: "started",
    phase: opts.phase,
    progress: checkpoint.completedPhases.length / totalPhases,
    jobId,
    detail: {
      resumed,
      nextPhase: checkpoint.nextPhase,
    },
  });

  try {
    for (const phase of phasesToRun) {
      const result = await Promise.resolve(runners[phase](db, { agent_id: opts.agent_id }));
      checkpoint = {
        ...checkpoint,
        completedPhases: [...new Set([...checkpoint.completedPhases, phase])],
        phaseResults: {
          ...checkpoint.phaseResults,
          [phase]: result,
        },
        nextPhase: nextPhase(phase, opts.phase),
      };
      updateMaintenanceCheckpoint(db, jobId, checkpoint);
      opts.onProgress?.({
        status: "phase-completed",
        phase,
        progress: checkpoint.completedPhases.length / totalPhases,
        jobId,
        detail: result,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = failMaintenanceJob(db, jobId, message, checkpoint) ?? baseJob;
    opts.onProgress?.({
      status: "failed",
      phase: checkpoint.nextPhase ?? opts.phase,
      progress: checkpoint.completedPhases.length / totalPhases,
      jobId,
      detail: { error: message },
    });
    throw Object.assign(new Error(message), { job: failed, checkpoint });
  }

  const completedCheckpoint: ReflectCheckpoint = {
    ...checkpoint,
    nextPhase: null,
  };
  const job = completeMaintenanceJob(db, jobId, completedCheckpoint) ?? baseJob;
  const after = getSummaryStats(db, opts.agent_id);

  opts.onProgress?.({
    status: "completed",
    phase: opts.phase,
    progress: 1,
    jobId,
    detail: completedCheckpoint.phaseResults,
  });

  return {
    job,
    jobId,
    phase: opts.phase,
    resumed,
    checkpoint: completedCheckpoint,
    results: completedCheckpoint.phaseResults,
    before,
    after,
  };
}
