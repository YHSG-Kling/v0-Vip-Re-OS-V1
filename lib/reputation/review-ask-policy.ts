// lib/reputation/review-ask-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE REVIEW-ASK POLICY — the pure half of the reputation close path (wave 143, lane 143E).
//
// OWNER RULING (wave 143): "A review is always asked at closing (reputation business process)." The lane
// brief adds: channel / consent / platform policy; NO duplicates; NO gating; NO misleading incentives.
//
// WHAT THE RULES ARE, AND WHERE THEY COME FROM (verified 2026-10-23, quoted from the sources):
//   · 16 CFR 465.4 (FTC Consumer Reviews and Testimonials Rule, 89 FR 68077): "It is an unfair or deceptive act
//     or practice … for a business to provide compensation or other incentives in exchange for, or conditioned
//     expressly or by implication on, the writing or creation of consumer reviews expressing a particular
//     sentiment, whether positive or negative". → a review ask may carry NO incentive and NO sentiment target.
//   · 16 CFR 465.7: review SUPPRESSION (threats, intimidation, false accusations to prevent or remove a review;
//     withholding reviews by rating while presenting the display as representative) is prohibited.
//   · Google contributed-content policy (support.google.com/contributionpolicy/answer/7400114): merchants may not
//     "Offer incentives – such as payment, discounts, free goods and/or services", may not "Discourage or
//     prohibit negative reviews or selectively solicit positive reviews from customers" (REVIEW GATING), and
//     may not request reviews that include specific content. Soliciting genuine experiences is permitted.
//   NOT VERIFIED (stated, not assumed): Zillow / Realtor.com / Facebook / Yelp solicitation terms, and any
//   state real-estate-commission rule on republishing a client testimonial in advertising. Asking is not
//   republishing; republishing a review as an ad is the marketing path's compliance gate, not this one.
//
// WHAT THIS MODULE DECIDES (all PURE — driven by scripts/intent-driven-followup-guard.ts):
//   · which review link a request may carry (a REAL, platform-hosted link from the tenant's
//     `reputation_profiles` policy — never a placeholder; no link = no request is sent);
//   · whether a drafted ask is clean (screenReviewAskCopy: incentive / gating / rating pressure / suppression);
//   · the send channel from what the contact has on file (consent, DNC, quiet hours and suppression stay in the
//     dispatch gate — this module never decides consent);
//   · the tenant's approval mode (auto-send, or the agent approves the draft).
// The timing stays the tenant's `review_request_delay_days` (lib/reputation/review-request-delay.ts).

export const REPUTATION_PROFILES_KEY = "reputation_profiles"

/** The platforms a review ask may point at — the SAME spellings as lib/kernel/reputation.ts REVIEW_PLATFORMS minus `internal`. */
export const ASKABLE_REVIEW_PLATFORMS = ["google", "zillow", "realtor_com", "facebook", "yelp"] as const
export type AskableReviewPlatform = (typeof ASKABLE_REVIEW_PLATFORMS)[number]

/** Hosts a review link on each platform may live on. A link on any other host is refused at read. */
export const REVIEW_PLATFORM_HOSTS: Readonly<Record<AskableReviewPlatform, readonly string[]>> = Object.freeze({
  google: ["g.page", "g.co", "maps.app.goo.gl", "search.google.com", "www.google.com", "google.com"],
  zillow: ["www.zillow.com", "zillow.com"],
  realtor_com: ["www.realtor.com", "realtor.com"],
  facebook: ["www.facebook.com", "facebook.com", "fb.com", "www.fb.com", "fb.me"],
  yelp: ["www.yelp.com", "yelp.com"],
})

/** Template / placeholder residue that means "nobody configured this" (the old PLATFORM_URLS literals). */
const PLACEHOLDER = /YOUR_|PLACE_ID|REPLACE|CHANGE_ME|<[^>]*>|\{\{?[^}]*\}\}?|\bexample\.(com|org|net)\b|\bXXXX/i

export type ReviewLinkVerdict = { ok: true; url: string } | { ok: false; reason: string }

/** PURE. Is this a real review link for the platform? https only, platform-hosted, no credentials, no placeholder. */
export function validateReviewLink(platform: AskableReviewPlatform, raw: unknown): ReviewLinkVerdict {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty" }
  const text = raw.trim()
  if (text.length > 2048) return { ok: false, reason: "longer than 2048 characters" }
  if (PLACEHOLDER.test(text)) return { ok: false, reason: "contains placeholder text — nobody configured a real link" }
  let u: URL
  try { u = new URL(text) } catch { return { ok: false, reason: "not a URL" } }
  if (u.protocol !== "https:") return { ok: false, reason: "not https" }
  if (u.username || u.password) return { ok: false, reason: "carries credentials" }
  if (!REVIEW_PLATFORM_HOSTS[platform].includes(u.hostname.toLowerCase())) return { ok: false, reason: `host ${u.hostname} is not a ${platform} host` }
  return { ok: true, url: u.toString() }
}

export type ReviewApprovalMode = "auto" | "agent_approves"

export interface ReputationProfiles {
  /** Brokerage-wide links (validated). */
  brokerage: Partial<Record<AskableReviewPlatform, string>>
  /** Per-agent overrides keyed by agents.id (validated). */
  agents: Record<string, Partial<Record<AskableReviewPlatform, string>>>
  approval: ReviewApprovalMode
  /** Which platform to try first; platforms not listed follow in the canonical order. */
  platformOrder: AskableReviewPlatform[]
  /** What was refused at read and why — published, never silent. */
  rejected: Array<{ where: string; reason: string }>
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** PURE. brokerage_settings.settings (any shape) → validated profiles. Absent → nothing configured (the honest default). */
export function parseReputationProfiles(settings: unknown): ReputationProfiles {
  const out: ReputationProfiles = { brokerage: {}, agents: {}, approval: "auto", platformOrder: [...ASKABLE_REVIEW_PLATFORMS], rejected: [] }
  const raw = isObj(settings) ? settings[REPUTATION_PROFILES_KEY] : undefined
  if (!isObj(raw)) return out
  const take = (src: Record<string, unknown>, where: string): Partial<Record<AskableReviewPlatform, string>> => {
    const acc: Partial<Record<AskableReviewPlatform, string>> = {}
    for (const p of ASKABLE_REVIEW_PLATFORMS) {
      const entry = src[p]
      if (entry === undefined) continue
      const link = validateReviewLink(p, isObj(entry) ? entry.url : entry)
      if (link.ok) acc[p] = link.url
      else out.rejected.push({ where: `${where}.${p}`, reason: link.reason })
    }
    return acc
  }
  out.brokerage = take(raw, REPUTATION_PROFILES_KEY)
  if (isObj(raw.agents)) {
    for (const [agentId, v] of Object.entries(raw.agents)) {
      if (!/^[0-9a-f-]{36}$/i.test(agentId) || !isObj(v)) { out.rejected.push({ where: `${REPUTATION_PROFILES_KEY}.agents.${agentId}`, reason: "key is not an agents.id or value is not an object" }); continue }
      out.agents[agentId] = take(v, `${REPUTATION_PROFILES_KEY}.agents.${agentId}`)
    }
  }
  if (raw.approval === "agent_approves") out.approval = "agent_approves"
  if (Array.isArray(raw.platform_order)) {
    const first = (raw.platform_order as unknown[]).filter((p): p is AskableReviewPlatform => (ASKABLE_REVIEW_PLATFORMS as readonly string[]).includes(p as string))
    out.platformOrder = [...new Set([...first, ...ASKABLE_REVIEW_PLATFORMS])]
  }
  return out
}

export type ReviewTarget = { platform: AskableReviewPlatform; url: string; scope: "agent" | "brokerage" }

/** PURE. The ONE platform + link a request carries: the agent's own link first, then the brokerage's, in the tenant's order. null = nothing real is configured. */
export function chooseReviewTarget(profiles: ReputationProfiles, agentId: string | null): ReviewTarget | null {
  for (const platform of profiles.platformOrder) {
    const own = agentId ? profiles.agents[agentId]?.[platform] : undefined
    if (own) return { platform, url: own, scope: "agent" }
    const shared = profiles.brokerage[platform]
    if (shared) return { platform, url: shared, scope: "brokerage" }
  }
  return null
}

// ── the copy screen ──────────────────────────────────────────────────────────────────────────

export type ReviewAskViolationCode = "incentive" | "gating" | "rating_pressure" | "suppression"
export interface ReviewAskViolation { code: ReviewAskViolationCode; match: string }

// Each pattern is a RULE with a positive control in scripts/intent-driven-followup-guard.ts.
const INCENTIVE = /\b(gift\s*cards?|gift\s*certificates?|discounts?|coupons?|vouchers?|cash\b|\$\s?\d|\d+\s?dollars?|giveaway|raffle|sweepstakes?|prize|rewards?|rewarded|in exchange|in return for|credit (toward|towards|on)|bonus|perks?|(?<!feel )free\b(?! to)|enter(ed)? (you )?(to|into|in) (a|our|the) (drawing|contest|giveaway|raffle))/i
const GATING: RegExp[] = [
  /\bif (you|your)\b[^.!?]{0,80}\b(happy|satisfied|pleased|great|positive|good|enjoyed|loved|delighted)\b[^.!?]{0,100}\b(review|rate|rating|share|post|leave)/i,
  /\b(unhappy|dissatisfied|not (satisfied|happy|pleased)|negative experience|bad experience|any (problem|issue|concern|complaint)s?)\b[^.!?]{0,120}\b(contact|call|email|reach|tell|talk to|let) (me|us)\b[^.!?]{0,60}\b(first|before|instead|directly|privately)/i,
  /\bbefore (you )?(post|posting|leave|leaving|write|writing|submit|submitting)\b[^.!?]{0,60}\b(review|feedback|rating)/i,
  /\b(private|internal)\s+(feedback|survey|form)\s+(first|before)/i,
  /\bonly if you (had|have|were|are)\b/i,
]
const RATING_PRESSURE = /\b(5|five)[- ]?stars?\b|\brate (us|me) (a )?(5|five)\b|\b(positive|glowing|great|good|favorable|excellent|stellar)\s+(review|rating|feedback)\b/i
const SUPPRESSION = /\b(remove|delete|take down|retract|withdraw)\s+(your|the|that|any)\s+(negative\s+|bad\s+)?(review|rating)\b|\b(please\s+)?(don'?t|do not)\s+(post|leave|write)\s+(a\s+)?(negative|bad)\b/i

/** PURE. Violations found in the drafted subject + body; an empty list = clean. @proofSeam positive controls in the guard. */
export function screenReviewAskCopy(parts: { subject?: string | null; body: string | null | undefined }): ReviewAskViolation[] {
  const text = `${parts.subject ?? ""}\n${parts.body ?? ""}`
  const out: ReviewAskViolation[] = []
  const hit = (code: ReviewAskViolationCode, re: RegExp) => { const m = re.exec(text); if (m) out.push({ code, match: m[0].trim().slice(0, 80) }) }
  hit("incentive", INCENTIVE)
  for (const g of GATING) { const m = g.exec(text); if (m) { out.push({ code: "gating", match: m[0].trim().slice(0, 80) }); break } }
  hit("rating_pressure", RATING_PRESSURE)
  hit("suppression", SUPPRESSION)
  return out
}

/** The rules the drafting prompt carries — the SAME vocabulary the screen enforces (the model is told, the screen verifies). */
export const REVIEW_ASK_PROMPT_RULES = [
  "Ask for an honest review of their experience — whatever it was. Do not suggest what rating or what words to use.",
  "Offer NOTHING in exchange: no gift, discount, entry, credit or favor, and do not mention any closing gift in this message.",
  "Do not ask only happy clients; do not route unhappy clients somewhere private 'first' or 'before' they post; do not mention removing or editing a review.",
  "Give the one link provided and nothing else to click. Keep it short, warm and specific to this closing.",
] as const

/**
 * PURE. The plain message an AGENT sends by hand from the Reputation panel's Send button when no AI draft is attached
 * to the request row (the row carries no draft text). Honest-experience ask, one link, no incentive, no sentiment target —
 * it passes screenReviewAskCopy by construction (the guard asserts it).
 */
export function composeManualReviewAsk(parts: { firstName?: string | null; address?: string | null; url: string }): { subject: string; body: string } {
  const who = parts.firstName?.trim() ? `Hi ${parts.firstName.trim()}` : "Hello"
  const where = parts.address?.trim() ? ` with ${parts.address.trim()}` : ""
  return {
    subject: "Would you share your experience?",
    body: `${who}, it was a pleasure helping you${where}. If you are willing, an honest review of your experience helps other people choose the right agent: ${parts.url}`,
  }
}

// ── channel + timing helpers ─────────────────────────────────────────────────────────────────

export type ReviewAskChannel = "email" | "sms"

export interface ReviewAskContactFacts {
  email?: string | null
  phone?: string | null
  preferred_channel?: string | null
  tcpa_consent?: boolean | null
  email_opt_out?: boolean | null
  email_unsubscribed?: boolean | null
  sms_opt_out?: boolean | null
  sms_unsubscribed?: boolean | null
  dnc_status?: boolean | string | null
}

/**
 * PURE. The channel a review ask rides, from what the contact has on file and has said: their stated preference
 * wins when it is usable; otherwise a written email with the link; SMS ONLY with recorded TCPA consent and no
 * opt-out / DNC. This is a COST PRE-FILTER (no model spend on a draft nobody may receive) — the authoritative
 * consent / DNC / suppression / quiet-hours decision stays in the dispatch gate (lib/providers/dispatch.ts).
 */
export function chooseReviewChannel(contact: ReviewAskContactFacts): ReviewAskChannel | null {
  const dnc = contact.dnc_status === true || (typeof contact.dnc_status === "string" && contact.dnc_status !== "" && contact.dnc_status !== "clear" && contact.dnc_status !== "not_listed")
  const emailUsable = !!contact.email && contact.email.includes("@") && contact.email_opt_out !== true && contact.email_unsubscribed !== true
  const smsUsable = !!contact.phone && contact.phone.replace(/\D/g, "").length >= 10 && contact.tcpa_consent === true
    && contact.sms_opt_out !== true && contact.sms_unsubscribed !== true && !dnc
  if (contact.preferred_channel === "sms" && smsUsable) return "sms"
  if (emailUsable) return "email"
  if (smsUsable) return "sms"
  return null
}

/** The instant a closing's request becomes due: the close date + the tenant's delay. */
export function reviewAskDueAt(closeDate: string | Date, delayDays: number): Date {
  const d = new Date(closeDate)
  d.setDate(d.getDate() + delayDays)
  return d
}
