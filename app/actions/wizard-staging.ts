"use server"

/**
 * Wizard Staging — auth-resolved entry points for the typed AI Copilot
 * (/api/internal/ai-chat tools).
 *
 * REFACTORED from an earlier draft that duplicated the canonical pipeline.
 * Listing + Offer staging now delegates to:
 *   - voiceDraftListing  (app/actions/voice-assistant/draft-listing-from-voice.ts)
 *   - voiceDraftOffer    (app/actions/voice-assistant/draft-offer-from-voice.ts)
 * which run the full extract → fill → generate chain (multi-turn intake via
 * workflow_intake_sessions, state-aware form-fill engine, audit trail).
 *
 * Content surfaces (newsletter / email / open house / blog / podcast / video
 * / direct mail / ad) delegate to canonical creator actions via the helpers
 * in lib/wizard-staging/content-staging.ts — which call createNewsletterCampaign,
 * createEmailCampaign, createOpenHouse, saveBlogPost, createPodcastEpisode,
 * createVideoProject, createDirectMailCampaign, createAdCampaign so feature
 * gates + brand voice + compliance + kernel events all fire.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { voiceDraftListing } from "./voice-assistant/draft-listing-from-voice"
import { voiceDraftOffer } from "./voice-assistant/draft-offer-from-voice"

export interface ListingFromVoiceParams {
  /** Free-text dictation the agent spoke or typed — the canonical extractor
   *  pulls address, price, seller, terms from this with confidence scoring. */
  voiceInput: string
  /** Continuing a prior intake session (multi-turn refinement) */
  sessionId?: string
  /** Optional contact context */
  contactId?: string
}

export interface OfferFromVoiceParams {
  voiceInput: string
  sessionId?: string
  contactId?: string
}

export interface StageWizardPacketResult {
  success: boolean
  documentId?: string
  openUrl?: string
  sessionId?: string
  /** When the intake is incomplete the canonical helper asks follow-ups
   *  instead of finalizing. The Copilot can relay these to the agent. */
  needsMoreInfo?: boolean
  spokenResponse?: string
  questions?: Array<{ field: string; question: string }>
  error?: string
}

/** Stage a listing-agreement packet from a free-text voice/typed input.
 *  Delegates to the canonical voiceDraftListing pipeline. */
export async function stageListingFromVoice(
  params: ListingFromVoiceParams,
): Promise<StageWizardPacketResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const result = await voiceDraftListing({
    voiceInput: params.voiceInput,
    sessionId: params.sessionId,
    contactId: params.contactId,
    forceFinalize: true,
  })

  if (result.kind === "error") return { success: false, error: result.error }
  if (result.kind === "needs_more_info") {
    return {
      success: false,
      needsMoreInfo: true,
      sessionId: result.sessionId,
      spokenResponse: result.spokenResponse,
      questions: result.questions,
    }
  }
  if (result.kind === "ready_to_finalize") {
    return {
      success: false,
      needsMoreInfo: true,
      sessionId: result.sessionId,
      spokenResponse: result.spokenResponse,
    }
  }
  // kind === "finalized"
  return {
    success: true,
    documentId: result.documentId,
    sessionId: result.sessionId,
    openUrl: result.formwizardUrl,
    spokenResponse: result.spokenResponse,
  }
}

/** Stage an offer packet from a free-text voice/typed input. */
export async function stageOfferFromVoice(
  params: OfferFromVoiceParams,
): Promise<StageWizardPacketResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Unauthorized" }

  const result = await voiceDraftOffer({
    voiceInput: params.voiceInput,
    sessionId: params.sessionId,
    contactId: params.contactId,
    forceFinalize: true,
  })

  if (result.kind === "error") return { success: false, error: result.error }
  if (result.kind === "needs_more_info") {
    return {
      success: false,
      needsMoreInfo: true,
      sessionId: result.sessionId,
      spokenResponse: result.spokenResponse,
      questions: result.questions,
    }
  }
  if (result.kind === "ready_to_finalize") {
    return {
      success: false,
      needsMoreInfo: true,
      sessionId: result.sessionId,
      spokenResponse: result.spokenResponse,
    }
  }
  return {
    success: true,
    documentId: result.documentId,
    sessionId: result.sessionId,
    openUrl: result.formwizardUrl,
    spokenResponse: result.spokenResponse,
  }
}
