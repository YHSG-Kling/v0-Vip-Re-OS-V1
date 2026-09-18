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
 * Wave 71A: routes through the official `lob` SDK adapter
 * (lib/providers/lob/client.ts) instead of the connector-gateway — see that
 * file's header for the official-SDK reasoning.
 */

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

  // Official SDK adapter (wave 71A) — see lib/providers/lob/client.ts. The
  // already-installed `lob@^6.6.3` SDK (used by lib/providers/dispatch.ts for
  // postcard/letter sends) now covers verification too; Basic auth (key as
  // username, empty password) is handled inside the SDK itself.
  const { verifyUsAddress } = await import("@/lib/providers/lob/client")
  const res = await verifyUsAddress(key, address)

  // Transient failure (timeout, 5xx, network) — return data:null so callers DON'T overwrite a
  // previously-verified address with a synthetic `verified:false`. A real Lob 'undeliverable'
  // response (res.ok=true with deliverability=undeliverable) IS authoritative and DOES write false.
  if (!res.ok || !res.data) {
    return { data: null, cost }
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
        city:           (d.components as { city?: string } | undefined)?.city,
        state:          (d.components as { state?: string } | undefined)?.state,
        zip_code:       (d.components as { zip_code?: string } | undefined)?.zip_code,
      },
      components: d.components,
      raw: d,
      error: null,
    },
    cost,
  }
}
