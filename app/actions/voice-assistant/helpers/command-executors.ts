// app/actions/voice-assistant/helpers/command-executors.ts
// ─────────────────────────────────────────────────────────────────────────────
// STATIC voice-command dispatch registry. The old dispatch did a RUNTIME-STRING dynamic import of a
// '@/'-aliased module path (import(mapping.module_path)) — which does NOT resolve on Vercel (the '@'
// alias is build-time only, and a data-driven path is never bundled into the serverless function). So
// the voice agent parsed + validated commands but the EXECUTION silently failed in production. This
// replaces it with explicit, build-validated static imports — each command's action is bundled and
// called with its correct signature. tsc now guarantees every mapped command resolves to a real action.

import { generateCMA } from "@/app/actions/cma-presentation/cma-generator"
import { generateNetSheet } from "@/app/actions/cma-presentation/net-sheet-calculator"
import { assemblePresentation } from "@/app/actions/cma-presentation/presentation-assembler"
import {
  scheduleListingAppointment, scheduleMediaCapture, approveMedia, activateComingSoon,
  submitToMLSAdmin, activateMLS, scheduleOpenHouse, approveOpenHouseMarketing,
} from "@/app/actions/seller-listing/execution-engine"
import {
  getBuyerJourney, agentConfigureBuyerSearch, lenderConfirmBuyerFinancials, adminOverrideFinancialVerification,
} from "@/app/actions/buyer-execution"
import { getListingCurrentStage } from "@/app/actions/listing-lifecycle-core"
import type { COMMAND_MAP } from "./command-map"

type Params = Record<string, any>
export type CommandExecutor = (p: Params) => Promise<any>

// Keyed by COMMAND_MAP target_action. Typed as Record<keyof typeof COMMAND_MAP, ...> so tsc ENFORCES
// 1:1 coverage at compile time — a mapped command with no executor (or an orphan executor) is a build
// error, not a silent runtime "not mapped". Params arrive already param-mapped (listing_id → listingId)
// by buildActionParams; each executor adapts to its action's real signature (object vs positional).
export const COMMAND_EXECUTORS: Record<keyof typeof COMMAND_MAP, CommandExecutor> = {
  generate_cma:                 (p) => generateCMA(p as any),
  generate_net_sheet:           (p) => generateNetSheet(p as any),
  generate_presentation:        (p) => assemblePresentation(p as any),
  schedule_appointment:         (p) => scheduleListingAppointment(p as any),
  schedule_media:               (p) => scheduleMediaCapture(p as any),
  approve_media:                (p) => approveMedia(p as any),
  activate_coming_soon:         (p) => activateComingSoon(p as any),
  submit_to_mls:                (p) => submitToMLSAdmin(p as any),
  activate_mls:                 (p) => activateMLS(p as any),
  schedule_open_house:          (p) => scheduleOpenHouse(p as any),
  approve_open_house_marketing: (p) => approveOpenHouseMarketing(p as any),
  query_buyer_stage:            (p) => getBuyerJourney({ contactId: p.contactId ?? p.buyer_id, userId: p.userId ?? p.user_id }),
  configure_buyer_search:       (p) => agentConfigureBuyerSearch(p as any),
  lender_confirm_financials:    (p) => lenderConfirmBuyerFinancials(p as any),
  admin_override_financial_gate:(p) => adminOverrideFinancialVerification(p as any),
  // Positional signature: getListingCurrentStage(listingId) — NOT an object.
  query_listing_status:         (p) => getListingCurrentStage(p.listingId ?? p.listing_id),
}
