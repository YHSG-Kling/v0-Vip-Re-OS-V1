// Email and Phone Validation Client
// Uses ZeroBounce for email, Twilio Lookup for phone validation

export class ContactValidationClient {
  private zeroBounceKey: string
  private twilioSid: string
  private twilioToken: string

  constructor() {
    this.zeroBounceKey = process.env.ZEROBOUNCE_API_KEY || ""
    this.twilioSid = process.env.TWILIO_ACCOUNT_SID || ""
    this.twilioToken = process.env.TWILIO_AUTH_TOKEN || ""
  }

  async validateEmail(email: string): Promise<{
    valid: boolean
    status: string
    disposable: boolean
    toxic: boolean
    catch_all: boolean
    suggested_correction?: string
  }> {
    if (!email) return { valid: false, status: "missing", disposable: false, toxic: false, catch_all: false }

    // Basic format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return { valid: false, status: "invalid_format", disposable: false, toxic: false, catch_all: false }
    }

    // If ZeroBounce API key is configured, do deep validation
    if (this.zeroBounceKey) {
      try {
        const response = await fetch(
          `https://api.zerobounce.net/v2/validate?api_key=${this.zeroBounceKey}&email=${encodeURIComponent(email)}`,
        )

        if (response.ok) {
          const result = await response.json()
          return {
            valid: result.status === "valid",
            status: result.status,
            disposable: result.sub_status === "disposable",
            toxic: result.sub_status === "toxic",
            catch_all: result.sub_status === "catch_all",
            suggested_correction: result.did_you_mean || undefined,
          }
        }
      } catch (error) {
        console.error("[ContactValidation] ZeroBounce error:", error)
      }
    }

    // Fallback: basic validation passed
    return { valid: true, status: "format_valid", disposable: false, toxic: false, catch_all: false }
  }

  async validatePhone(phone: string): Promise<{
    valid: boolean
    formatted: string
    type: string // mobile, landline, voip
    carrier?: string
    country?: string
  }> {
    if (!phone) return { valid: false, formatted: "", type: "unknown" }

    // Clean phone number
    const cleaned = phone.replace(/\D/g, "")
    if (cleaned.length < 10) {
      return { valid: false, formatted: phone, type: "invalid" }
    }

    // Format US phone number
    const formatted = cleaned.length === 10 ? `+1${cleaned}` : cleaned.startsWith("1") ? `+${cleaned}` : `+1${cleaned}`

    // If Twilio is configured, do carrier lookup
    if (this.twilioSid && this.twilioToken) {
      try {
        const auth = Buffer.from(`${this.twilioSid}:${this.twilioToken}`).toString("base64")
        const response = await fetch(
          `https://lookups.twilio.com/v2/PhoneNumbers/${formatted}?Fields=line_type_intelligence`,
          {
            headers: { Authorization: `Basic ${auth}` },
          },
        )

        if (response.ok) {
          const result = await response.json()
          return {
            valid: result.valid,
            formatted: result.phone_number,
            type: result.line_type_intelligence?.type || "unknown",
            carrier: result.line_type_intelligence?.carrier_name,
            country: result.country_code,
          }
        }
      } catch (error) {
        console.error("[ContactValidation] Twilio error:", error)
      }
    }

    // Fallback: basic validation
    return { valid: true, formatted, type: "unknown" }
  }

  async validateContact(contact: { email?: string; phone?: string }): Promise<{
    email_valid: boolean
    email_status: string
    phone_valid: boolean
    phone_formatted: string
    phone_type: string
    overall_valid: boolean
  }> {
    const [emailResult, phoneResult] = await Promise.all([
      contact.email
        ? this.validateEmail(contact.email)
        : Promise.resolve({ valid: false, status: "missing", disposable: false, toxic: false, catch_all: false }),
      contact.phone
        ? this.validatePhone(contact.phone)
        : Promise.resolve({ valid: false, formatted: "", type: "missing" }),
    ])

    return {
      email_valid: emailResult.valid,
      email_status: emailResult.status,
      phone_valid: phoneResult.valid,
      phone_formatted: phoneResult.formatted,
      phone_type: phoneResult.type,
      overall_valid: emailResult.valid || phoneResult.valid, // At least one valid contact method
    }
  }
}

const validationClient = new ContactValidationClient()

export async function validateEmail(email: string) {
  return validationClient.validateEmail(email)
}

export async function validatePhone(phone: string) {
  return validationClient.validatePhone(phone)
}

export async function validateContact(contact: { email?: string; phone?: string }) {
  return validationClient.validateContact(contact)
}
