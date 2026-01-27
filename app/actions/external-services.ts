"use server"

// =====================================================
// EXTERNAL SERVICE INTEGRATIONS
// =====================================================
// These are the real API calls that workflows should use

// HEYGEN VIDEO GENERATION
export async function generateHeyGenVideo(params: {
  avatarId: string
  voiceId: string
  script: string
  contactId?: string
}) {
  const apiKey = process.env.HEYGEN_API_KEY

  if (!apiKey) {
    console.warn("[External Services] HeyGen API key not configured")
    return {
      success: false,
      error: "HeyGen API key not configured. Add HEYGEN_API_KEY to environment variables.",
      requiresConfiguration: true,
    }
  }

  try {
    const response = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error?.message || "HeyGen API error")
    }

    return {
      success: true,
      videoId: data.data?.video_id,
      status: "processing",
    }
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

  try {
    const response = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
      headers: { "X-Api-Key": apiKey },
    })

    const data = await response.json()

    return {
      success: true,
      status: data.data?.status,
      videoUrl: data.data?.video_url,
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// TWILIO SMS
export async function sendTwilioSMS(params: {
  to: string
  message: string
  contactId?: string
}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    console.warn("[External Services] Twilio not configured")
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to environment variables.",
      mock: true,
    }
  }

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: params.to,
        From: fromNumber,
        Body: params.message,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || "Twilio API error")
    }

    return {
      success: true,
      messageId: data.sid,
      status: data.status,
    }
  } catch (error: any) {
    console.error("[External Services] Twilio error:", error)
    return { success: false, error: error.message }
  }
}

// SENDGRID EMAIL
export async function sendSendGridEmail(params: {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  contactId?: string
}) {
  const apiKey = process.env.SENDGRID_API_KEY
  const defaultFrom = process.env.SENDGRID_FROM_EMAIL || "noreply@yourdomain.com"

  if (!apiKey) {
    console.warn("[External Services] SendGrid not configured")
    return {
      success: false,
      error: "SendGrid not configured. Add SENDGRID_API_KEY to environment variables.",
      mock: true,
    }
  }

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: params.to }] }],
        from: { email: params.from || defaultFrom },
        subject: params.subject,
        content: [
          { type: "text/plain", value: params.text || params.html.replace(/<[^>]*>/g, "") },
          { type: "text/html", value: params.html },
        ],
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(error || "SendGrid API error")
    }

    return { success: true, status: "sent" }
  } catch (error: any) {
    console.error("[External Services] SendGrid error:", error)
    return { success: false, error: error.message }
  }
}

// STRIPE (for commission splits, etc.)
export async function createStripeTransfer(params: {
  amount: number
  destinationAccountId: string
  description?: string
  transactionId?: string
}) {
  const secretKey = process.env.STRIPE_SECRET_KEY

  if (!secretKey) {
    console.warn("[External Services] Stripe not configured")
    return {
      success: false,
      error: "Stripe not configured. Add STRIPE_SECRET_KEY to environment variables.",
      mock: true,
    }
  }

  try {
    const response = await fetch("https://api.stripe.com/v1/transfers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        amount: Math.round(params.amount * 100).toString(), // Convert to cents
        currency: "usd",
        destination: params.destinationAccountId,
        description: params.description || "Commission transfer",
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error?.message || "Stripe API error")
    }

    return {
      success: true,
      transferId: data.id,
      amount: data.amount / 100,
    }
  } catch (error: any) {
    console.error("[External Services] Stripe error:", error)
    return { success: false, error: error.message }
  }
}
