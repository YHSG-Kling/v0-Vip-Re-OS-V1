'use server'

/**
 * lib/kernel/marketing/real-estate-compliance-gate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates social posts, ads, comments, and marketing content before publish.
 *
 * Checks (in order):
 *   1. Fair housing — protected-class language
 *   2. Prohibited guarantees / misleading claims
 *   3. Required brokerage attribution
 *   4. MLS remarks restrictions
 *   5. Customer-service / public reply rules
 *
 * Return: { passed: boolean, blockers: string[], warnings: string[] }
 *
 * Callers:
 *   - social dashboard publish/create
 *   - ad creation / approval
 *   - marketing studio publish/push
 *   - AI-generated post approval
 *   - social comment / review reply assistant
 */

export interface ComplianceGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
}

// ── FAIR HOUSING — protected-class terms ──────────────────────────────────────
// HUD-protected classes: race, color, national origin, religion, sex,
// familial status, disability. These terms are prohibited in listing remarks
// and marketing content when used as descriptors of the property or area.
const FAIR_HOUSING_BLOCKERS: RegExp[] = [
  /\b(perfect for|great for|ideal for|suited for)\b.{0,40}\b(families|couples|singles|seniors|young|retirees|children|kids|no kids)\b/i,
  /\bno (children|kids|pets|section 8|students)\b/i,
  /\b(christian|jewish|muslim|catholic|spanish|hispanic|asian|white|black|african)\b.{0,20}\b(neighborhood|community|area|block)\b/i,
  /\b(exclusive|exclusive community|gated for)\b.{0,30}\b(executives|professionals only|couples only)\b/i,
]

// ── PROHIBITED GUARANTEES / MISLEADING CLAIMS ─────────────────────────────────
const MISLEADING_BLOCKERS: RegExp[] = [
  /\b(guaranteed|we guarantee|100%|you will|you'll)\b.{0,30}\b(sell|profit|return|appreciation|growth)\b/i,
  /\bguaranteed (sale|profit|price|offer)\b/i,
  /\bbest (deal|price|rate|value) in (town|the area|the state|the country)\b/i,
]

// ── WARNINGS — items to review but not hard-block ────────────────────────────
const WARNING_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(luxury|prestigious|exclusive|high-end)\b/i,
    message: 'Review "luxury/exclusive" language for fair-housing compliance with state rules.',
  },
  {
    pattern: /\b(motivated seller|must sell|price reduced|desperate)\b/i,
    message: '"Motivated seller" language can attract lowball offers — confirm agent approved.',
  },
  {
    pattern: /\b(school district|near (great|top|best) schools)\b/i,
    message: 'School proximity claims require factual backing — verify before publishing.',
  },
  {
    pattern: /\b(safe|quiet|low crime|family[-\s]?friendly neighborhood)\b/i,
    message: 'Neighborhood characterization can implicate fair housing — use objective terms.',
  },
  {
    pattern: /\bcall (me|us) now\b/i,
    message: 'Direct call CTAs require TCPA opt-in compliance when used in paid ads.',
  },
]

// ── MLS REMARKS RESTRICTIONS ─────────────────────────────────────────────────
const MLS_BLOCKERS: RegExp[] = [
  /\b(call for price|price upon request|contact agent for price)\b/i,   // most MLS boards forbid omitting price
  /\b(www\.|https?:\/\/|\.com|\.net)\b/i,   // URLs typically banned in public remarks
  /\b(text|email|call)\b.{0,10}\b[\w._%+-]+@[\w.-]+\.[a-z]{2,}\b/i, // email in remarks often MLS-prohibited
]

// MLS warnings (not hard blocks — board-dependent)
const MLS_WARNINGS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\b(showing[s]? by appointment only)\b/i,
    message: 'Some MLS boards require all lockbox/showing instructions be in ShowingTime, not public remarks.',
  },
]

interface GateParams {
  content: string
  contentType: 'social_post' | 'ad' | 'listing_remarks' | 'comment_reply' | 'newsletter' | 'blog'
  brokerageName?: string
  /** Whether brokerage attribution is required (default true for ads and social) */
  requireAttribution?: boolean
}

export async function realEstateComplianceGate(params: GateParams): Promise<ComplianceGateResult> {
  const blockers: string[] = []
  const warnings: string[] = []
  const { content, contentType } = params

  // ── 1. Fair housing ───────────────────────────────────────────────────────
  for (const pattern of FAIR_HOUSING_BLOCKERS) {
    if (pattern.test(content)) {
      blockers.push(
        `Fair Housing violation detected: content appears to describe the property or area in terms of protected classes. Review and remove before publishing.`
      )
      break  // one message per category to avoid flooding
    }
  }

  // ── 2. Misleading claims ──────────────────────────────────────────────────
  for (const pattern of MISLEADING_BLOCKERS) {
    if (pattern.test(content)) {
      blockers.push(
        `Prohibited guarantee or misleading claim detected. Remove language that promises specific financial outcomes.`
      )
      break
    }
  }

  // ── 3. Brokerage attribution ──────────────────────────────────────────────
  const needsAttribution =
    params.requireAttribution !== false &&
    (contentType === 'ad' || contentType === 'social_post')

  if (needsAttribution && params.brokerageName) {
    const nameInContent = content.toLowerCase().includes(params.brokerageName.toLowerCase())
    if (!nameInContent) {
      warnings.push(
        `Brokerage attribution: "${params.brokerageName}" does not appear in the content. Most state licensing laws require brokerage name in ads.`
      )
    }
  }

  // ── 4. MLS restrictions (listing remarks only) ────────────────────────────
  if (contentType === 'listing_remarks') {
    for (const pattern of MLS_BLOCKERS) {
      if (pattern.test(content)) {
        blockers.push(
          `MLS restriction: content contains elements typically prohibited in public remarks (hidden price, URL, or contact info). Check your MLS rules.`
        )
        break
      }
    }
    for (const mw of MLS_WARNINGS) {
      if (mw.pattern.test(content)) {
        warnings.push(mw.message)
      }
    }
  }

  // ── 5. Customer-service / public reply rules ──────────────────────────────
  if (contentType === 'comment_reply') {
    if (/\b(sue|legal action|attorney|lawyer)\b/i.test(content)) {
      blockers.push(
        'Public reply contains legal threat language. This must be handled through legal counsel, not public channels.'
      )
    }
    if (/\b(they|he|she|their)\b.{0,30}\b(lied|fraud|criminal|dishonest)\b/i.test(content)) {
      blockers.push(
        'Public reply contains language that may constitute defamation. Remove before publishing.'
      )
    }
  }

  // ── 6. General warnings for all types ────────────────────────────────────
  for (const w of WARNING_PATTERNS) {
    if (w.pattern.test(content)) {
      warnings.push(w.message)
    }
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  }
}
