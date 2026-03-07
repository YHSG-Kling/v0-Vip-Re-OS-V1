// ─── PERSONA CONFIG ───────────────────────────────────────────────────────────
export type {
  PersonaWidget,
  JourneyStage,
  PersonaResource,
  PersonaTabConfig,
  PersonaConfig,
} from "./persona-config"
export {
  PERSONA_CONFIGS,
  getPersonaConfig,
  getPersonaWidgets,
  getPersonaJourneyStages,
  formatWidgetValue,
} from "./persona-config"

// ─── JOURNEY UTILS ────────────────────────────────────────────────────────────
export type {
  TaskCompletion,
  StageProgress,
  JourneyStage as JourneyStageProgress,
  JourneyProgressResult,
} from "./journey-utils"
export { calculateJourneyProgress } from "./journey-utils"
