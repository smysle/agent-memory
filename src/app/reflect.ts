import type Database from "better-sqlite3";
import {
  runReflectOrchestrator,
  type ReflectOptions,
  type ReflectRunResult,
  type ReflectRunners,
} from "../sleep/orchestrator.js";
import type { MaintenancePhase, ReflectStep } from "../sleep/jobs.js";

export interface ReflectProgressEvent {
  status: "started" | "phase-completed" | "completed" | "failed";
  phase: MaintenancePhase | ReflectStep;
  progress: number;
  jobId?: string;
  detail?: unknown;
}

export interface ReflectInput {
  phase: MaintenancePhase;
  agent_id?: string;
  jobId?: string;
  resume?: boolean;
  runners?: Partial<ReflectRunners>;
  onProgress?: (event: ReflectProgressEvent) => void;
}

export async function reflectMemories(
  db: Database.Database,
  input: ReflectInput,
): Promise<ReflectRunResult> {
  const options: ReflectOptions = {
    phase: input.phase,
    agent_id: input.agent_id,
    jobId: input.jobId,
    resume: input.resume,
    runners: input.runners,
    onProgress: input.onProgress,
  };

  return runReflectOrchestrator(db, options);
}
