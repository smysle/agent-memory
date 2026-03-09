import type Database from "better-sqlite3";
import { newId, now } from "../core/db.js";

export type MaintenancePhase = "decay" | "tidy" | "govern" | "all";
export type MaintenanceStatus = "running" | "completed" | "failed";
export type ReflectStep = Exclude<MaintenancePhase, "all">;

export interface ReflectCheckpoint {
  requestedPhase: MaintenancePhase;
  nextPhase: ReflectStep | null;
  completedPhases: ReflectStep[];
  phaseResults: Partial<Record<ReflectStep, unknown>>;
}

export interface MaintenanceJob {
  job_id: string;
  phase: MaintenancePhase;
  status: MaintenanceStatus;
  checkpoint: ReflectCheckpoint | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface RawMaintenanceJob {
  job_id: string;
  phase: MaintenancePhase;
  status: MaintenanceStatus;
  checkpoint: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function parseCheckpoint(raw: string | null): ReflectCheckpoint | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReflectCheckpoint;
  } catch {
    return null;
  }
}

function serializeCheckpoint(checkpoint: ReflectCheckpoint | null | undefined): string | null {
  if (!checkpoint) return null;
  return JSON.stringify(checkpoint);
}

function toJob(row: RawMaintenanceJob | undefined): MaintenanceJob | null {
  if (!row) return null;
  return {
    ...row,
    checkpoint: parseCheckpoint(row.checkpoint),
  };
}

export function createInitialCheckpoint(phase: MaintenancePhase): ReflectCheckpoint {
  return {
    requestedPhase: phase,
    nextPhase: phase === "all" ? "decay" : phase,
    completedPhases: [],
    phaseResults: {},
  };
}

export function createMaintenanceJob(
  db: Database.Database,
  phase: MaintenancePhase,
  checkpoint = createInitialCheckpoint(phase),
): MaintenanceJob {
  const jobId = newId();
  const startedAt = now();

  db.prepare(
    `INSERT INTO maintenance_jobs (job_id, phase, status, checkpoint, error, started_at, finished_at)
     VALUES (?, ?, 'running', ?, NULL, ?, NULL)`,
  ).run(jobId, phase, serializeCheckpoint(checkpoint), startedAt);

  return getMaintenanceJob(db, jobId)!;
}

export function getMaintenanceJob(db: Database.Database, jobId: string): MaintenanceJob | null {
  const row = db.prepare("SELECT * FROM maintenance_jobs WHERE job_id = ?").get(jobId) as RawMaintenanceJob | undefined;
  return toJob(row);
}

export function findResumableMaintenanceJob(db: Database.Database, phase: MaintenancePhase): MaintenanceJob | null {
  const row = db.prepare(
    `SELECT *
     FROM maintenance_jobs
     WHERE phase = ?
       AND status IN ('running', 'failed')
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(phase) as RawMaintenanceJob | undefined;

  return toJob(row);
}

export function updateMaintenanceCheckpoint(
  db: Database.Database,
  jobId: string,
  checkpoint: ReflectCheckpoint,
): MaintenanceJob | null {
  db.prepare(
    `UPDATE maintenance_jobs
     SET checkpoint = ?,
         error = NULL,
         finished_at = NULL,
         status = 'running'
     WHERE job_id = ?`,
  ).run(serializeCheckpoint(checkpoint), jobId);

  return getMaintenanceJob(db, jobId);
}

export function failMaintenanceJob(db: Database.Database, jobId: string, error: string, checkpoint?: ReflectCheckpoint | null): MaintenanceJob | null {
  db.prepare(
    `UPDATE maintenance_jobs
     SET status = 'failed',
         checkpoint = COALESCE(?, checkpoint),
         error = ?,
         finished_at = ?
     WHERE job_id = ?`,
  ).run(serializeCheckpoint(checkpoint), error, now(), jobId);

  return getMaintenanceJob(db, jobId);
}

export function completeMaintenanceJob(db: Database.Database, jobId: string, checkpoint?: ReflectCheckpoint | null): MaintenanceJob | null {
  db.prepare(
    `UPDATE maintenance_jobs
     SET status = 'completed',
         checkpoint = COALESCE(?, checkpoint),
         error = NULL,
         finished_at = ?
     WHERE job_id = ?`,
  ).run(serializeCheckpoint(checkpoint), now(), jobId);

  return getMaintenanceJob(db, jobId);
}
