/**
 * System 3.5 - Action Orchestration & Follow-Up Execution Engine
 * 
 * Module Exports
 */

// Core Orchestrator
export {
  analyzeInsightsForAction,
  prioritizeActions,
  isActionDue,
  selectOptimalChannel,
  validateActionPlan,
  batchOrchestrate,
  type ActionType,
  type ActionPriority,
  type ActionPlan,
  type OrchestratorDecision
} from './orchestrator'

// Signal Monitor
export {
  pollEscalationSignals,
  pollActivitySignals,
  pollAllSignals,
  processSignals,
  monitorAndDecide,
  getLastProcessedTimestamp,
  saveCheckpoint,
  filterSignalsByPriority,
  type EscalationSignal
} from './signal-monitor'

// Execution Engine
export {
  executeAction,
  batchExecuteActions,
  type ExecutionResult
} from './execution-engine'

// Execution Logger
export {
  logExecution,
  logError,
  batchLogExecutions,
  batchLogErrors,
  logOrchestrationCycle,
  getExecutionLogs,
  getExecutionStats,
  getRecentErrors,
  type ExecutionLog
} from './execution-logger'
