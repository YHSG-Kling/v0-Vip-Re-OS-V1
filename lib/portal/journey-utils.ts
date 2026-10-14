// Shared journey progress calculation utilities
// Used by both dashboard and journey page to ensure consistent progress display

export interface TaskCompletion {
  id: string
  contact_id: string
  task_id: string
  stage_id?: string
  completed_at: string
}

export interface StageProgress {
  id?: string
  contact_id: string
  current_stage_id?: string
  current_stage_index?: number
  stages_completed?: number
}

export interface JourneyStage {
  id: string
  name: string
  description?: string
  tasks?: Array<{
    id: string
    title: string
    required?: boolean
    completed?: boolean
  }>
}

export interface JourneyProgressResult {
  stages: JourneyStage[]
  currentStageIndex: number
  currentStageName: string
  progressPercent: number
  completedTasks: number
  totalTasks: number
  pendingTasks: Array<{ id: string; title: string; required?: boolean }>
}

/**
 * Calculate journey progress consistently across dashboard and journey pages
 */
export function calculateJourneyProgress(
  journeyStages: JourneyStage[],
  taskCompletions: TaskCompletion[],
  stageProgress: StageProgress | null | undefined,
  milestones?: Array<{ status?: string }>,
): JourneyProgressResult {
  // Create set of completed task IDs for quick lookup
  const completedTaskIds = new Set(taskCompletions.map((tc) => tc.task_id))

  // Mark tasks as completed in stages
  const stagesWithCompletions = journeyStages.map((stage, stageIdx) => ({
    ...stage,
    tasks: stage.tasks?.map((task, taskIdx) => ({
      ...task,
      completed:
        completedTaskIds.has(task.id) || completedTaskIds.has(`${stage.id}-task-${taskIdx}`),
    })),
  }))

  // Calculate total and completed tasks
  const totalTasks = stagesWithCompletions.reduce(
    (acc, stage) => acc + (stage.tasks?.length || 0),
    0,
  )
  const completedTasksCount = taskCompletions.length

  // Calculate progress percentage
  const progressPercent =
    totalTasks > 0 ? Math.round((completedTasksCount / totalTasks) * 100) : 0

  // Determine current stage index
  // Priority: 1) Database stage progress 2) Calculate from task completion 3) Milestone completion
  let currentStageIndex = 0

  if (stageProgress?.current_stage_index !== undefined && stageProgress.current_stage_index !== null) {
    // Use database-stored stage progress
    currentStageIndex = stageProgress.current_stage_index
  } else if (totalTasks > 0) {
    // Calculate from task completions
    currentStageIndex = Math.min(
      Math.floor((completedTasksCount / totalTasks) * journeyStages.length),
      journeyStages.length - 1,
    )
  } else if (milestones && milestones.length > 0) {
    // Fallback to milestone completion
    const completedMilestones = milestones.filter((m) => m.status === "completed").length
    currentStageIndex = Math.min(
      Math.floor((completedMilestones / milestones.length) * journeyStages.length),
      journeyStages.length - 1,
    )
  }

  // Ensure index is within bounds
  currentStageIndex = Math.max(0, Math.min(currentStageIndex, journeyStages.length - 1))

  // Get current stage info
  const currentStage = stagesWithCompletions[currentStageIndex]
  const currentStageName = currentStage?.name || journeyStages[0]?.name || "Getting Started"

  // Get pending tasks from current stage
  const pendingTasks =
    currentStage?.tasks?.filter((t) => !t.completed).slice(0, 3) || []

  return {
    stages: stagesWithCompletions,
    currentStageIndex,
    currentStageName,
    progressPercent,
    completedTasks: completedTasksCount,
    totalTasks,
    pendingTasks,
  }
}

/**
 * THE JOURNEY MILESTONE RULE (lane 86F2) — pure, so the emitter and its proof share it.
 *
 * Given the persona's stages (task ids in the portal's COMPOSITE form
 * `${stage.id}:${task.id}`, exactly what completeTask records as metadata.task_id),
 * the set of completed task ids AFTER a completion, and the task just completed:
 *   · `stage` — the just-completed task's stage, when that completion is the one
 *     that FINISHED it (every task of the stage is now in the set);
 *   · `allDone` — every task of every stage is now in the set.
 * `firstCompletion` must be false when the task had already been completed before
 * (a re-submission): a stage that was already finished must not finish again.
 * An unknown task id (not in any stage) finishes nothing.
 */
export function detectJourneyMilestones(
  stages: Array<{ id: string; name: string; tasks: Array<{ id: string }> }>,
  completedTaskIds: ReadonlySet<string>,
  justCompletedTaskId: string,
  firstCompletion: boolean,
): { stage: { id: string; name: string; nextName: string | null } | null; allDone: boolean } {
  const none = { stage: null, allDone: false }
  if (!firstCompletion) return none
  const idx = stages.findIndex((s) => s.tasks.some((t) => `${s.id}:${t.id}` === justCompletedTaskId))
  if (idx < 0) return none
  const done = (s: { id: string; tasks: Array<{ id: string }> }) =>
    s.tasks.length > 0 && s.tasks.every((t) => completedTaskIds.has(`${s.id}:${t.id}`))
  const s = stages[idx]
  const stage = done(s) ? { id: s.id, name: s.name, nextName: stages[idx + 1]?.name ?? null } : null
  const allDone = stages.length > 0 && stages.every((x) => x.tasks.length === 0 || done(x)) && stages.some((x) => x.tasks.length > 0)
  return { stage, allDone }
}
