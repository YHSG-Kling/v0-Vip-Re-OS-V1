// lib/kernel/marketing/public-copy-rewrite.ts
//
// THE FAIR-HOUSING REWRITE LOOP FOR PUBLIC COPY — wave 142, lane 142E (owner: "any fair housing flags
// on copy ai should rewrite with those comments in mind"; "fair-housing moderation applies to PUBLIC
// housing marketing (listings, ads, public pages/videos/social/lead magnets), NOT to private CDA /
// financial records or routine internal form entry").
//
// SURVIVORS EVALUATED, REUSED — nothing here is a fourth gate:
//   · the FINDINGS come from the ONE pattern list, lib/compliance-rules/fair-housing-patterns.ts
//     (phrase + the compliant FIX + the legal reference) and from the social/ads gate
//     lib/kernel/marketing/real-estate-compliance-gate.ts realEstateComplianceGate (blockers +
//     warnings — warnings PASS THROUGH, CLAUDE.md §5: only a hard fair-housing flag escalates);
//   · the LOOP SHAPE is lib/kernel/compliance-redraft.ts runWithComplianceRedraft (draft → gate →
//     redraft fed the violations → gate), which the five spoken-script producers run. That survivor is
//     `server-only`, capped at ONE redraft and records no escalation — exactly the three things public
//     COPY needs differently (owner: cap the loop, e.g. 2 rewrites, then escalate to a human). The loop
//     body is reproduced here as a PURE function (no I/O, every collaborator a seam) so the proof
//     drives it in memory; compliance-redraft.ts keeps its contract and now names this twin.
//
// WHAT RUNS WHERE (the positive control the proof keeps): isPublicMarketingSurface decides. A listing
// remark, an ad, a landing page, a lead magnet, a book, a public video script or social post is
// public housing marketing → the loop applies. A CDA, a settlement statement, an internal form entry,
// a private note → it does NOT (those carry their own rules; a steering scan over a CDA field is noise).

import { detectFairHousingViolations, type FairHousingPattern } from "@/lib/compliance-rules/fair-housing-patterns"
import { realEstateComplianceGate } from "./real-estate-compliance-gate"
// Wave 143 (lane 143F): the "55+ / senior living" CLAIM is verified against the tenant's recorded
// housing-for-older-persons exemption, never assumed (42 U.S.C. § 3607(b); 24 CFR 100.300-100.308).
import {
  assessOlderPersonsClaim, OLDER_PERSONS_AUTHORITY,
  type OlderPersonsAssessment, type OlderPersonsVerification,
} from "@/lib/compliance/fair-housing-older-persons"

/** Where a piece of copy will be seen. Public housing marketing is moderated; private records are not. */
export type CopySurface =
  | "listing" | "ad" | "landing_page" | "lead_magnet" | "book" | "social" | "video_script" | "newsletter" | "blog"
  | "cda" | "settlement_statement" | "internal_form" | "private_note" | "financial_record"

const PUBLIC_MARKETING_SURFACES: ReadonlySet<CopySurface> = new Set<CopySurface>([
  "listing", "ad", "landing_page", "lead_magnet", "book", "social", "video_script", "newsletter", "blog",
])

/** PURE: does public-ad fair-housing moderation apply to this surface? (CDA / financial / internal → no.) */
export function isPublicMarketingSurface(surface: CopySurface): boolean {
  return PUBLIC_MARKETING_SURFACES.has(surface)
}

/** One finding the rewriter is handed — the phrase, the compliant fix, the reference. */
export interface CopyFinding {
  phrase: string
  fix: string
  reference: string
  severity: "high" | "medium" | "low" | "blocker"
}

export interface CopyScan {
  /** false when a BLOCKER / high-severity steering phrase is present. */
  ok: boolean
  findings: CopyFinding[]
  /** Warnings pass through (CLAUDE.md §5) — kept for the reviewer, never a refusal. */
  warnings: string[]
  /** Wave 143: the age-qualified-housing claim's verdict (absent on a non-public surface). The reviewer reads it. */
  olderPersons?: OlderPersonsAssessment
}

/** What a caller knows about the tenant's recorded older-persons exemptions: the records, "unreadable", or nothing checked. */
export type OlderPersonsRecords = readonly OlderPersonsVerification[] | "unreadable" | undefined

/** The gate's own content-type vocabulary, mapped from the surface (one vocabulary each side). */
function gateContentType(surface: CopySurface): "social_post" | "ad" | "listing_remarks" | "newsletter" | "blog" {
  switch (surface) {
    case "ad": return "ad"
    case "listing": return "listing_remarks"
    case "social": case "video_script": return "social_post"
    case "newsletter": return "newsletter"
    default: return "blog" // landing_page / lead_magnet / book — long-form public copy, no attribution rule
  }
}

function findingOf(p: FairHousingPattern): CopyFinding {
  return { phrase: p.phrase, fix: p.fix, reference: p.reference, severity: p.severity }
}

/**
 * PURE (async only because the gate is): scan PUBLIC copy for fair-housing findings. A high-severity
 * pattern or a gate BLOCKER makes the scan not-ok; medium/low pattern hits and the gate's warnings are
 * reported and pass through. A non-public surface is never scanned here (returns ok with a note).
 */
export async function scanPublicCopy(text: string, surface: CopySurface, opts: { brokerageName?: string | null; olderPersons?: OlderPersonsRecords; now?: Date } = {}): Promise<CopyScan> {
  if (!isPublicMarketingSurface(surface)) return { ok: true, findings: [], warnings: [`${surface} is not public housing marketing — fair-housing ad moderation does not apply`] }
  const content = text ?? ""
  const patternHits = detectFairHousingViolations(content).map(findingOf)
  const gate = await realEstateComplianceGate({ content, contentType: gateContentType(surface), brokerageName: opts.brokerageName ?? undefined, requireAttribution: false })
  const blockers: CopyFinding[] = gate.blockers
    // The gate repeats the pattern list's own phrases as "Fair Housing: avoid …" lines — those are already
    // findings above; its other blockers (protected-class descriptors, guarantees, solicitation) are new.
    .filter((b) => !/^Fair Housing: avoid "/.test(b))
    .map((b) => ({ phrase: b, fix: "Rewrite so the sentence describes the home or the service, never who should want it, and promises no outcome.", reference: "lib/kernel/marketing/real-estate-compliance-gate.ts", severity: "blocker" as const }))
  // THE AGE-QUALIFIED CLAIM (wave 143). "55+" / "senior living" / "age-restricted" is lawful only for a community that
  // meets the exemption's conditions AND is recorded as verified. No record, an unreadable read, or an unmet / stale
  // condition HOLDS the claim as a finding the AI rewrites around (then a human decides) — never auto-approved. The
  // 100.306 wordings ("adult living") are inconsistent with 55+ intent whatever the verdict ("adult community" is
  // already in the pattern list above — not repeated).
  const older = assessOlderPersonsClaim(content, opts.olderPersons, opts.now)
  const olderFindings: CopyFinding[] = []
  const reference = `${OLDER_PERSONS_AUTHORITY.statute}; ${OLDER_PERSONS_AUTHORITY.regulation}`
  if (older.status === "unverified" || older.status === "unreadable" || older.status === "conditions_unmet") {
    olderFindings.push({ phrase: older.claims.map((c) => c.phrase).join(" / "), fix: `${older.reason} ${older.fix}`.trim(), reference, severity: "high" })
  }
  for (const w of older.inconsistentWording.filter((c) => !/adult\s+community/i.test(c.phrase))) {
    olderFindings.push({ phrase: w.phrase, fix: "Say \"55+ community\" only for a community with a verified exemption; otherwise describe the home, not who may live there.", reference: "24 CFR 100.306", severity: "high" })
  }
  const findings = [...patternHits, ...blockers, ...olderFindings]
  const ok = !findings.some((f) => f.severity === "high" || f.severity === "blocker")
  return { ok, findings, warnings: gate.warnings, olderPersons: older }
}

/** The rewriter seam: given the text and the specific findings, return the rewritten text (or null = could not). */
export type CopyRewriter = (text: string, findings: CopyFinding[], attempt: number) => Promise<string | null>

export interface RewriteLoopResult {
  ok: boolean
  text: string
  /** How many REWRITES ran (0 when the first scan was clean). */
  rewrites: number
  /** The findings on the final text (empty when ok). */
  findings: CopyFinding[]
  warnings: string[]
  /** true when the cap was reached with findings still present — a HUMAN must decide. */
  escalated: boolean
  /** Every attempt's findings, oldest first — the reviewer's evidence trail. */
  trail: Array<{ attempt: number; findings: string[] }>
}

/** The owner's cap: two AI rewrites, then a human. */
export const PUBLIC_COPY_MAX_REWRITES = 2

/**
 * Render the findings as the "comments" the rewriter is given — the exact phrase, the compliant fix and the
 * reference, one line each. The prompt builders of every caller use this ONE rendering.
 */
export function renderFindingsForRewrite(findings: CopyFinding[]): string {
  return findings.map((f) => `- "${f.phrase}" → ${f.fix} (${f.reference})`).join("\n")
}

/**
 * PURE loop: scan → rewrite with the findings → rescan, at most `maxRewrites` times (default 2), then ESCALATE.
 * The gate is injectable (default: scanPublicCopy) so the proof can drive the loop without the pattern list.
 * Never throws: a rewriter that throws or returns null ends the loop with the last text and the findings.
 */
export async function rewritePublicCopyUntilCompliant(args: {
  text: string
  surface: CopySurface
  rewrite: CopyRewriter
  maxRewrites?: number
  brokerageName?: string | null
  /** Wave 143: the tenant's recorded older-persons exemptions (loadOlderPersonsVerifications) — absent = nobody checked, so a 55+ claim is held. */
  olderPersons?: OlderPersonsRecords
  gate?: (text: string) => Promise<CopyScan>
}): Promise<RewriteLoopResult> {
  const max = Math.max(0, Math.min(args.maxRewrites ?? PUBLIC_COPY_MAX_REWRITES, 5))
  const gate = args.gate ?? ((t: string) => scanPublicCopy(t, args.surface, { brokerageName: args.brokerageName, olderPersons: args.olderPersons }))
  let text = args.text
  const trail: RewriteLoopResult["trail"] = []
  let scan = await gate(text)
  trail.push({ attempt: 0, findings: scan.findings.map((f) => f.phrase) })
  let rewrites = 0
  while (!scan.ok && rewrites < max) {
    let next: string | null = null
    try { next = await args.rewrite(text, scan.findings, rewrites + 1) } catch { next = null }
    rewrites++
    if (!next || !next.trim() || next.trim() === text.trim()) {
      // The rewriter could not (or did not) change the copy — the remaining attempts would be the same ask.
      trail.push({ attempt: rewrites, findings: scan.findings.map((f) => f.phrase) })
      break
    }
    text = next.trim()
    scan = await gate(text)
    trail.push({ attempt: rewrites, findings: scan.findings.map((f) => f.phrase) })
  }
  return { ok: scan.ok, text, rewrites, findings: scan.ok ? [] : scan.findings, warnings: scan.warnings, escalated: !scan.ok, trail }
}
