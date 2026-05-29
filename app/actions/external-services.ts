"use server"

/**
 * EXTERNAL SERVICES (thin wrappers)
 * All API calls are delegated to lib/providers/*.
 * This file preserves existing function signatures for backward compatibility.
 */

import { sendSMS, sendEmail } from "@/lib/providers/messaging"
import { createTransfer } from "@/lib/providers/payment"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// HEYGEN VIDEO GENERATION
// HeyGen is a video-specific provider — kept inline until lib/providers/video is created.
export async function generateHeyGenVideo(params: {
  avatarId: string
  voiceId: string
  script: string
  contactId?: string
}) {
  const apiKey = process.env.HEYGEN_API_KEY

  if (!apiKey) {
    return {
      success: false,
      error: "HeyGen API key not configured. Add HEYGEN_API_KEY to environment variables.",
      requiresConfiguration: true,
    }
  }

  try {
    const response = await callConnector<{ data?: { video_id?: string } }>({
      connector: "heygen",
      baseUrl: "https://api.heygen.com",
      path: "/v2/video/generate",
      method: "POST",
      auth: { style: "header", name: "X-Api-Key", value: apiKey },
      body: {
        video_inputs: [
          {
            character: {
              type: "avatar",
              avatar_id: params.avatarId,
              avatar_style: "normal",
            },
            voice: {
              type: "text",
              input_text: params.script,
              voice_id: params.voiceId,
            },
          },
        ],
        dimension: { width: 1920, height: 1080 },
      },
    })

    if (!response.ok) {
      throw new Error(response.error || "HeyGen API error")
    }

    return { success: true, videoId: response.data?.data?.video_id, status: "processing" }
  } catch (error: any) {
    console.error("[External Services] HeyGen error:", error)
    return { success: false, error: error.message }
  }
}

export async function getHeyGenVideoStatus(videoId: string) {
  const apiKey = process.env.HEYGEN_API_KEY

  if (!apiKey) {
    return { success: false, error: "HeyGen API key not configured" }
  }

  const response = await callConnector<{ data?: { status?: string; video_url?: string } }>({
    connector: "heygen",
    baseUrl: "https://api.heygen.com",
    path: "/v1/video_status.get",
    method: "GET",
    query: { video_id: videoId },
    auth: { style: "header", name: "X-Api-Key", value: apiKey },
  })

  if (!response.ok) {
    return { success: false, error: response.error ?? "HeyGen status error" }
  }
  return {
    success: true,
    status: response.data?.data?.status,
    videoUrl: response.data?.data?.video_url,
  }
}

// TWILIO SMS — delegates to lib/providers/messaging
export async function sendTwilioSMS(params: {
  to: string
  message: string
  contactId?: string
}) {
  try {
    return await sendSMS(params)
  } catch (error: any) {
    console.error("[External Services] Twilio error:", error)
    return { success: false, error: error.message }
  }
}

// SENDGRID EMAIL — delegates to lib/providers/messaging
export async function sendSendGridEmail(params: {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  contactId?: string
}) {
  try {
    return await sendEmail(params)
  } catch (error: any) {
    console.error("[External Services] SendGrid error:", error)
    return { success: false, error: error.message }
  }
}

// STRIPE — delegates to lib/providers/payment
export async function createStripeTransfer(params: {
  amount: number
  destinationAccountId: string
  description?: string
  transactionId?: string
}) {
  try {
    return await createTransfer(params)
  } catch (error: any) {
    console.error("[External Services] Stripe error:", error)
    return { success: false, error: error.message }
  }
}
