// lib/onboarding/license-lookup.ts
//
// The REAL-ESTATE license verification ladder.
//
// There is no national real-estate license API, so we verify against the state
// regulator registry when it can be reached (ZenRows scrape + AI extraction),
// and fall to the human review queue — the FLOOR of the ladder — everywhere else.
//
// Honesty rules baked in:
//  - A verification result is only ever derived from what the state page shows.
//  - Ambiguity, low confidence, scrape failure, AI failure → needs_manual_review.
//  - An adverse registry status (expired/revoked/…) → 'flagged', which ALSO goes
//    to the human queue. This module never rejects an agent — only humans do.

import {
  getStateLicenseSource,
  resolveLookupUrl,
} from "@/lib/onboarding/state-license-registry"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface RealEstateLicenseLookupParams {
  state: string
  licenseNumber: string
  lastName?: string
  brokerageId?: string
}

/** What the AI extracted from the state registry page — evidence, never a verdict. */
export interface RegistryEvidence {
  found: boolean
  licenseeName: string | null
  licenseStatus: string | null
  licenseType: string | null
  expirationDate: string | null
  /** Extractor's own 0-1 confidence that the fields above match the page. */
  confidence: number
  /** The exact state-registry URL the evidence came from. */
  sourceUrl: string
  boardName: string
}

export type RealEstateLicenseVerdict =
  | {
      status: "verified"
      method: "state_registry_scrape"
      evidence: RegistryEvidence
    }
  | {
      status: "flagged"
      method: "state_registry_scrape"
      evidence: RegistryEvidence
      reason: string
      /** Same page, for the human reviewer's one click. */
      portalUrl: string
    }
  | {
      status: "needs_manual_review"
      method: "state_registry_scrape" | "state_portal_manual" | "none"
      reason: string
      /** One-click link for the reviewer when we know the state portal. */
      portalUrl?: string
      /** Partial evidence when a scrape ran but didn't clear the bar. */
      evidence?: RegistryEvidence
    }

// ─── STATUS CLASSIFICATION (pure) ─────────────────────────────────────────────

const ADVERSE_STATUS =
  /(inactive|expired|revok|suspend|surrender|cancel|terminat|lapsed|denied|delinquent|void|restrict|probation)/i
// Anchored so "inactive" (checked first anyway) can never read as active.
const ACTIVE_LIKE = /^(active|current|licensed|valid|clear|good standing|active licensed)/i

export type LicenseStatusClass = "active_like" | "adverse" | "ambiguous"

/** Classify a raw registry status string. Exported for the simulator. PURE. */
export function classifyLicenseStatus(raw: string | null | undefined): LicenseStatusClass {
  const s = (raw ?? "").trim()
  if (!s) return "ambiguous"
  if (ADVERSE_STATUS.test(s)) return "adverse"
  if (ACTIVE_LIKE.test(s)) return "active_like"
  return "ambiguous"
}

/** Confidence floor below which a scrape result cannot auto-verify. */
export const VERIFY_CONFIDENCE_FLOOR = 0.8

// ─── HTML → text (keep the AI prompt small and honest) ────────────────────────

function htmlToText(html: string, maxChars = 16000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/tr|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
  return text.slice(0, maxChars)
}

// ─── THE LADDER ───────────────────────────────────────────────────────────────

export async function verifyRealEstateLicense(
  params: RealEstateLicenseLookupParams
): Promise<RealEstateLicenseVerdict> {
  const licenseNumber = params.licenseNumber?.trim()
  if (!licenseNumber) {
    return {
      status: "needs_manual_review",
      method: "none",
      reason: "no_license_number",
    }
  }

  // a. Resolve the state registry entry.
  const source = getStateLicenseSource(params.state)
  if (!source) {
    return {
      status: "needs_manual_review",
      method: "none",
      reason: `no_registry_source_for_state_${(params.state ?? "").trim().toUpperCase() || "unknown"}`,
    }
  }

  const portalUrl = resolveLookupUrl(source.lookupUrl, {
    license: licenseNumber,
    lastName: params.lastName,
  })

  if (source.method === "manual_portal") {
    return {
      status: "needs_manual_review",
      method: "state_portal_manual",
      portalUrl,
      reason: "state_portal_not_scrapeable",
    }
  }

  // b. Scrape the state registry page through ZenRows.
  let pageText: string
  try {
    const { scrapeWithZenRows } = await import("@/lib/external/zenrows-client")
    const scraped = await scrapeWithZenRows(portalUrl, { jsRender: true, premiumProxy: true })
    pageText = htmlToText(scraped.body)
    if (!pageText) {
      return {
        status: "needs_manual_review",
        method: "state_registry_scrape",
        portalUrl,
        reason: "scrape_returned_empty_page",
      }
    }
  } catch (err) {
    return {
      status: "needs_manual_review",
      method: "state_registry_scrape",
      portalUrl,
      reason: `scrape_failed: ${err instanceof Error ? err.message : "unknown error"}`,
    }
  }

  // AI-extract the record — extraction only, never judgment.
  let extracted: {
    found: boolean
    licenseeName: string | null
    licenseStatus: string | null
    licenseType: string | null
    expirationDate: string | null
    confidence: number
  }
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({
      feature: "license_verification",
      brokerageId: params.brokerageId ?? null,
      temperature: 0,
      maxTokens: 500,
      prompt:
        `You are reading a page from the ${source.boardName} public real-estate license registry.\n` +
        `We searched for license number "${licenseNumber}"` +
        (params.lastName ? ` (licensee last name "${params.lastName}")` : "") +
        `.\n\nPAGE TEXT:\n"""\n${pageText}\n"""\n\n` +
        `Extract ONLY what the page actually shows about that exact license. Do not infer, guess, or fill in missing values.\n` +
        `Rules:\n` +
        `- found=true ONLY if the page clearly shows a license record matching license number ${licenseNumber}.\n` +
        `- If the page is a search form, an error, a "no results" page, shows a different license number, or is in any way ambiguous: found=false.\n` +
        `- licenseStatus must be the registry's own wording (e.g. "Active", "Expired", "Revoked"), verbatim.\n` +
        `- expirationDate in YYYY-MM-DD if shown, else null.\n` +
        `- confidence is 0-1: how certain you are the extracted fields are exactly what the page shows for this license.\n\n` +
        `Return JSON ONLY:\n` +
        `{ "found": true|false, "licenseeName": "string or null", "licenseStatus": "string or null", "licenseType": "string or null", "expirationDate": "YYYY-MM-DD or null", "confidence": 0.0-1.0 }`,
    })
    const cleaned = text.replace(/```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) {
      return {
        status: "needs_manual_review",
        method: "state_registry_scrape",
        portalUrl,
        reason: "ai_extraction_returned_no_json",
      }
    }
    const parsed = JSON.parse(match[0])
    extracted = {
      found: parsed.found === true,
      licenseeName: typeof parsed.licenseeName === "string" ? parsed.licenseeName : null,
      licenseStatus: typeof parsed.licenseStatus === "string" ? parsed.licenseStatus : null,
      licenseType: typeof parsed.licenseType === "string" ? parsed.licenseType : null,
      expirationDate: typeof parsed.expirationDate === "string" ? parsed.expirationDate : null,
      confidence:
        typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : 0,
    }
  } catch (err) {
    return {
      status: "needs_manual_review",
      method: "state_registry_scrape",
      portalUrl,
      reason: `ai_extraction_failed: ${err instanceof Error ? err.message : "unknown error"}`,
    }
  }

  const evidence: RegistryEvidence = {
    ...extracted,
    sourceUrl: portalUrl,
    boardName: source.boardName,
  }

  // c. Verdict mapping — d. never auto-fail: everything non-verified routes to humans.
  return mapRegistryVerdict(evidence, portalUrl)
}

/** Pure verdict mapping from extracted evidence — exported for the simulator. */
export function mapRegistryVerdict(
  evidence: RegistryEvidence,
  portalUrl: string
): RealEstateLicenseVerdict {
  if (!evidence.found) {
    return {
      status: "needs_manual_review",
      method: "state_registry_scrape",
      portalUrl,
      reason: "license_not_found_on_state_registry",
      evidence,
    }
  }

  const statusClass = classifyLicenseStatus(evidence.licenseStatus)

  if (statusClass === "adverse") {
    // Adverse registry status is a real finding — but only humans reject.
    return {
      status: "flagged",
      method: "state_registry_scrape",
      evidence,
      portalUrl,
      reason: `registry_status_${(evidence.licenseStatus ?? "unknown").toLowerCase().replace(/\s+/g, "_")}`,
    }
  }

  if (statusClass === "active_like" && evidence.confidence >= VERIFY_CONFIDENCE_FLOOR) {
    return { status: "verified", method: "state_registry_scrape", evidence }
  }

  return {
    status: "needs_manual_review",
    method: "state_registry_scrape",
    portalUrl,
    reason:
      statusClass === "active_like"
        ? `low_confidence_${evidence.confidence.toFixed(2)}`
        : `ambiguous_registry_status_${(evidence.licenseStatus ?? "none").toLowerCase().replace(/\s+/g, "_")}`,
    evidence,
  }
}
