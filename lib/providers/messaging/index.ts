/**
 * MESSAGING PROVIDER
 * Owns all outbound messaging API calls: Twilio SMS, SendGrid Email.
 * No business logic — pure API client wrappers.
 */

// ─── TWILIO SMS ────────────────────────────────────────────────────────────────

export interface SendSMSParams {
  to: string
  message: string
  contactId?: string
}

export interface SendSMSResult {
  success: boolean
  messageId?: string
  status?: string
  error?: string
  mock?: boolean
}

export async function sendSMS(params: SendSMSParams): Promise<SendSMSResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to environment variables.",
      mock: true,
    }
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
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
    }
  )

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.message || "Twilio API error")
  }

  return {
    success: true,
    messageId: data.sid,
    status: data.status,
  }
}

// ─── TWILIO CALLS ──────────────────────────────────────────────────────────────

export interface PlaceCallParams {
  /** Phone number to call (E.164 format recommended) */
  to: string
  /** TwiML URL that Twilio will request to control the call flow */
  twimlUrl: string
}

export interface PlaceCallResult {
  success: boolean
  callSid?: string
  status?: string
  error?: string
  mock?: boolean
}

export async function placeCall(params: PlaceCallParams): Promise<PlaceCallResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to environment variables.",
      mock: true,
    }
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: params.to,
        From: fromNumber,
        Url: params.twimlUrl,
      }),
    }
  )

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.message || "Twilio Calls API error")
  }

  return {
    success: true,
    callSid: data.sid,
    status: data.status,
  }
}

// ─── TWILIO LOOKUPS ────────────────────────────────────────────────────────────

export interface LookupPhoneParams {
  /** E.164 formatted phone number, e.g. +14155551234 */
  phoneNumber: string
}

export interface LookupPhoneResult {
  success: boolean
  valid?: boolean
  formattedNumber?: string
  lineType?: string  // mobile, landline, voip, etc.
  carrierName?: string
  countryCode?: string
  error?: string
  mock?: boolean
}

export async function lookupPhone(params: LookupPhoneParams): Promise<LookupPhoneResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN

  if (!accountSid || !authToken) {
    return {
      success: false,
      error:
        "Twilio not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to environment variables.",
      mock: true,
    }
  }

  const response = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(params.phoneNumber)}?Fields=line_type_intelligence`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
    }
  )

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.message || "Twilio Lookups API error")
  }

  return {
    success: true,
    valid: data.valid,
    formattedNumber: data.phone_number,
    lineType: data.line_type_intelligence?.type,
    carrierName: data.line_type_intelligence?.carrier_name,
    countryCode: data.country_code,
  }
}

// ─── SENDGRID EMAIL ────────────────────────────────────────────────────────────

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  contactId?: string
}

export interface SendEmailResult {
  success: boolean
  status?: string
  error?: string
  mock?: boolean
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.SENDGRID_API_KEY
  const defaultFrom = process.env.SENDGRID_FROM_EMAIL || "noreply@yourdomain.com"

  if (!apiKey) {
    return {
      success: false,
      error: "SendGrid not configured. Add SENDGRID_API_KEY to environment variables.",
      mock: true,
    }
  }

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
}
