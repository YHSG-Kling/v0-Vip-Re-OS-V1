"use server"

import { isValidUUID } from "@/lib/validations"
import {
  launchAIISACampaignService,
  queueAIISACallService,
  handleVapiCallCompleteService,
  getAIISACampaignsService,
  getAIISACallsService,
  retryFailedCallsService,
  updateCampaignStatusService,
} from "@/lib/application/ai-isa"

/**
 * AI Inside Sales Agent (ISA) System
 * Autonomous outbound calling with Vapi.ai for lead qualification and appointment booking
 */

// Launch AI ISA campaign
export async function launchAIISACampaign(params: {
  campaignType: string
  campaignName?: string
  contactSegment: any
  loginId: string
}) {
  const { loginId } = params

  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  try {
    return await launchAIISACampaignService(params)
  } catch (error: any) {
    console.error("[AI ISA] Campaign launch failed:", error)
    return { success: false, error: error.message }
  }
}

// Queue individual AI ISA call
export async function queueAIISACall(campaignId: string, contactId: string, loginId: string) {
  try {
    return await queueAIISACallService(campaignId, contactId, loginId)
  } catch (error: any) {
    console.error("[AI ISA] Call queueing failed:", error)
    return { success: false, error: error.message }
  }
}

// Handle Vapi call completion webhook
export async function handleVapiCallComplete(payload: any) {
  try {
    return await handleVapiCallCompleteService(payload)
  } catch (error: any) {
    console.error("[AI ISA] Webhook handling failed:", error)
    return { success: false, error: error.message }
  }
}

// Get AI ISA campaign stats
export async function getAIISACampaigns(loginId: string) {
  if (!isValidUUID(loginId)) {
    return []
  }

  return await getAIISACampaignsService(loginId)
}

// Get AI ISA call history
export async function getAIISACalls(campaignId?: string, loginId?: string) {
  if (loginId && !isValidUUID(loginId)) {
    return []
  }

  return await getAIISACallsService(campaignId, loginId)
}

// Retry failed calls
export async function retryFailedCalls(loginId: string) {
  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  try {
    return await retryFailedCallsService(loginId)
  } catch (error: any) {
    console.error("[AI ISA] Retry failed calls error:", error)
    return { success: false, error: error.message }
  }
}

// Pause/resume campaign
export async function updateCampaignStatus(campaignId: string, status: "active" | "paused" | "completed") {
  if (!isValidUUID(campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  return await updateCampaignStatusService(campaignId, status)
}
