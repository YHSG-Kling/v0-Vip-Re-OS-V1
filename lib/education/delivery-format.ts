// lib/education/delivery-format.ts
//
// DELIVERY FORMAT — baked into the business process: not every lesson should be a video. The FORMAT is
// chosen by the MATERIAL (an emotional/complex explainer earns a video; a procedural step-list is a
// checklist; a comparative decision is a guide), and for CONTACTS it is then gauged by AGE GROUP (younger
// cohorts favor video, older favor checklists/guides — the existing DELIVERY_MATRIX). The VOICE follows
// the audience: a contact-facing video speaks in the AGENT's own voice; an agent-facing video in their
// ASSISTANT's voice. All pure — the authors set the channel from the material format; the delivery layer
// adapts to the contact's age; the video renderer reads the voice. Reuses lib/kernel/education (no drift).

import { getEducationDelivery, type AgeSegment } from "@/lib/kernel/education"
import type { EducationFormat } from "@/lib/kernel/types"

/** Which authored materials genuinely warrant an explainer VIDEO — emotional, complex, or reassurance
 *  moments where a face + voice lands better than text. Everything else stays lighter-weight. */
const VIDEO_WORTHY = new Set<string>([
  // client — high-anxiety / emotional moments
  "buyer_offer_accepted", "buyer_appraisal_low", "persona_first_time", "persona_senior_downsizing", "persona_lifetime_equity", "seller_listing_live",
  // agent — orientation + skill demonstration
  "platform_tour", "working_with_managers", "negotiation_tactics", "persona_playbook",
])
/** Materials that are inherently a step-list. */
const CHECKLIST_WORTHY = new Set<string>([
  "buyer_closed", "seller_repairs", "buyer_inspection",
])

/**
 * PURE: the format a MATERIAL warrants, from its topic. Video for the emotional/complex moments,
 * checklist for procedural step-lists, guide for everything else (comparative/analytical prose).
 */
export function resolveMaterialFormat(input: { topicKey?: string | null }): EducationFormat {
  const key = (input.topicKey ?? "").split(":").pop() ?? input.topicKey ?? ""
  if (VIDEO_WORTHY.has(key)) return "video"
  if (CHECKLIST_WORTHY.has(key)) return "checklist"
  return "guide"
}

/** PURE: learning_modules.channels for a format — only a video format renders on the video channel. */
export function channelsForFormat(fmt: EducationFormat): string[] {
  return fmt === "video" ? ["video"] : ["article"]
}

/** PURE: is this a video-format module (the explainer-render pipeline consumes these). */
export function isVideoFormat(fmt: EducationFormat | null | undefined): boolean {
  return fmt === "video"
}

export type EduVoice = "agent_own" | "assistant"

/**
 * PURE: whose voice a video should speak in. A CONTACT-facing video (audience 'customer') uses the
 * AGENT's own cloned voice — it's their relationship; an AGENT-facing video uses the ASSISTANT voice.
 */
export function voiceForAudience(audienceRoles: string[] | null | undefined): EduVoice {
  return (audienceRoles ?? []).includes("customer") ? "agent_own" : "assistant"
}

/**
 * PURE: gauge the DELIVERED format for a contact by their age group. The material has an inherent format;
 * if that format already suits the cohort (its primary or secondary preference) we keep it, otherwise we
 * adapt to the cohort's preferred format. Unknown age → the material's own format unchanged.
 */
export function resolveContactDeliveryFormat(ageSegment: AgeSegment | null | undefined, materialFmt: EducationFormat): EducationFormat {
  if (!ageSegment) return materialFmt
  const cfg = getEducationDelivery({ ageSegment })
  if (materialFmt === cfg.primaryFormat || materialFmt === cfg.secondaryFormat) return materialFmt
  return cfg.primaryFormat
}
