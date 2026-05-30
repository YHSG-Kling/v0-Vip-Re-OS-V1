/**
 * lib/external/lob-address-verify.ts
 *
 * Lob US address-verification adapter. Used as the truth source for the canonical
 * `mailing_address_verified` flag before we spend on a Lob postcard/letter — verifying first
 * eliminates the most common direct-mail waste (undeliverable / deliverable-unconfirmed).
 *
 * Docs: https://docs.lob.com/#tag/US-Verifications
 *   POST https://api.lob.com/v1/us_verifications  (Basic auth, key + ":" username form)
 *
 * Routes through the canonical connector-gateway (never-throws, healer-observable).
 */
const LOB_API_URL = "https://api.lob.com/v1"

export interface LobAddressInput {
  primary_line:    string
  secondary_line?: string
  urbanization?:   string
  city?:           string
  state?:          string
  zip_code?:       string
  /** When set, Lob can verify with just `primary_line` + zip OR primary_line + city + state. */
  recipient?:      string
}

export interface LobVerificationResult {
  /** True when deliverability is 'deliverable' (the only level safe to mail to). */
  verified:        boolean
  /** Lob's deliverability bucket: 'deliverable' | 'deliverable_unnecessary_unit' |
   *  'deliverable_incorrect_unit' | 'deliverable_missing_unit' | 'undeliverable'. */
  deliverability:  string | null
  /** Standardized recipient + address parts Lob returned, ready to write back to the contact row. */
  standardized: {
    primary_line?:   string
    secondary_line?: string
    last_line?:      string
    city?:           string
    state?:          string
    zip_code?:       string
  }
  /** Component-level analysis (street_name_match, zip_in_city, etc.) for downstream confidence. */
  components?: Record<string, unknown>
  raw:             unknown
  error:           string | null
}

export async function verifyAddressViaLob(address: LobAddressInput): Promise<{ data: LobVerificationResult | null; cost: number }> {
  const key = process.env.LOB_API_KEY
  if (!key) return { data: null, cost: 0 }
  // Lob US verifications are billed at ~$0.0025/req in production; ~free in test mode.
  const isTest = key.startsWith("test_")
  const cost = isTest ? 0 : 0.0025

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "lob",
    baseUrl:   LOB_API_URL,
    path:      "us_verifications",
    method:    "POST",
    bodyType:  "form",  // Lob accepts form-encoded; gateway sets the right Content-Type
    body:      address as unknown as Record<string, string>,
    // Lob uses HTTP Basic auth with the key as username and empty password.
    auth:      { style: "basic", username: key, password: "" },
  })

  if (!res.ok || !res.data) {
    return { data: { verified: false, deliverability: null, standardized: {}, raw: res.error, error: res.error ?? "Lob unreachable" }, cost }
  }

  const d = res.data
  const deliverability = typeof d.deliverability === "string" ? d.deliverability : null
  const verified = deliverability === "deliverable"
  return {
    data: {
      verified,
      deliverability,
      standardized: {
        primary_line:   d.primary_line,
        secondary_line: d.secondary_line,
        last_line:      d.last_line,
        city:           d.components?.city,
        state:          d.components?.state,
        zip_code:       d.components?.zip_code,
      },
      components: d.components,
      raw: d,
      error: null,
    },
    cost,
  }
}
