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
