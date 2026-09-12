// Email and Phone Validation Client
// Email identity-resolution via PeopleData (PDL); phone via Twilio Lookup (lib/providers/messaging).
import { lookupPhone as twilioLookupPhone } from "@/lib/providers/messaging"
import { skipTraceWithPeopleData } from "@/lib/external/peopledata-client"

// UN-EXPORTED (§1.1, 2026-08-31, lane M4): every consumer reaches this class
// through the module-level wrappers below (validateEmail / validatePhone /
// validateContact — live at lib/enrichment/contact-enrichment-core.ts and
// app/actions/data-health.ts); nothing ever constructed it directly, so the
// `export` keyword claimed a second door nobody used.
class ContactValidationClient {
  private peopleDataKey: string

  constructor() {
    this.peopleDataKey = process.env.PEOPLEDATA_API_KEY || ""
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

    // Identity resolution via PeopleData (PDL). A PDL match confirms the address belongs to a real
    // person ("verified"); no match isn't proof of invalidity, so a well-formed address stays valid
    // as "format_valid". PDL doesn't expose disposable/toxic/catch-all signals — left false.
    if (this.peopleDataKey) {
      try {
        const { data } = await skipTraceWithPeopleData({ email })
        if (data && data.emails?.some((e) => e.toLowerCase() === email.toLowerCase())) {
          return { valid: true, status: "verified", disposable: false, toxic: false, catch_all: false }
        }
      } catch {
        // PDL unavailable — fall through to format-level validation.
      }
    }

    // Format passed (no identity match or PDL not configured).
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

    // Carrier lookup via messaging provider (delegates to Twilio Lookups API)
    try {
      const result = await twilioLookupPhone({ phoneNumber: formatted })
      if (result.success && !result.mock) {
        return {
          valid: result.valid ?? true,
          formatted: result.formattedNumber ?? formatted,
          type: result.lineType ?? "unknown",
          carrier: result.carrierName,
          country: result.countryCode,
        }
      }
    } catch (error) {
      console.error("[ContactValidation] Phone lookup error:", error)
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
