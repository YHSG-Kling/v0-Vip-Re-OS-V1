// lib/ads/persona-audience.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT C26 — PERSONA AUDIENCES (wave 149, lane 149A; owner ruling 2026-11-03).
//
// OWNER, verbatim: "We are allowed to name a custom audience in Meta called first time home buyer and sync up the customers that
// are tagged the persona so we retarget to them with ads that would most likely peak their interests." — "Every persona is
// allowed and this can't change."
//
// createPersonaAudience({ tenant, persona, platform, creator }) → the contacts TAGGED with that persona (contacts.contact_persona,
// every drifted spelling — lib/kernel/ads.ts resolveAudiencePopulation) and CONSENTED for marketing (tcpa_consent) and NOT
// SUPPRESSED (email unsubscribe / opt-out, the C16 contact_suppression_list) → the platform audience on the EXISTING Ads Manager
// survivor (lib/kernel/ads.ts createAudienceSegment → facebook_custom_audiences, then the existing approve → syncAudience door
// uploads it hashed through the platform connector) → attribution (the creating user on facebook_custom_audiences.agent_user_id,
// the persona + basis on source_rule, and an action-ledger row).
//
// NOT A NEW AUDIENCE SYSTEM (LAW 1/2). This module only PLANS the one audience definition and hands it to the survivor; it owns no
// table, no upload and no gate of its own. Compliance is exactly what C26 names:
//   (a) WORDING — the ad's copy is scanned where the ad is written (lib/compliance-rules/**; lib/ads/ad-creator.ts approve gate);
//   (b) the PLATFORM's housing rules on DELIVERY — no age / gender / ZIP narrowing, no lookalike (lib/ads/connectors/ad-payload.ts,
//       lib/ads/launch-assembler.ts, LOOKALIKE_AD_POLICY) — and a lookalike asked for HERE is explained, provider-specifically;
//   (c) consent + suppression — the population floor in lib/kernel/ads.ts.
// A persona is NEVER refused as an audience basis (only `other`, which names no situation, and a non-canonical spelling).
//
// PURE planner + an orchestrator with injected doors, so scripts/persona-compliance-guard.ts drives both on fixtures.

import { isCampaignPersona, type CampaignPersona } from "@/lib/campaigns/contact-sources"
import {
  DERIVED_PERSONA_BASIS,
  PERSONA_SEGMENT_TYPE,
  resolveAudiencePersonaBasis,
} from "@/lib/ads/audience-persona-basis"
import { FB_AUDIENCE_TEMPLATES } from "@/lib/ads/fb-audience-templates"
import type { SourceRule } from "@/lib/kernel/ads"

/** The platforms facebook_custom_audiences.target_platform admits (live CHECK). */
export type PersonaAudiencePlatform = "facebook" | "instagram" | "google" | "linkedin" | "tiktok" | "stackadapt"

/**
 * What each platform can do with a CUSTOMER-LIST persona audience in THIS product — provider-specific, stated plainly. "supported"
 * means a connector in lib/ads/connectors/registry.ts uploads a hashed customer list for it; the explanation is what an operator
 * reads when it cannot.
 */
const PERSONA_AUDIENCE_PLATFORMS: Readonly<Record<PersonaAudiencePlatform, { supported: boolean; explanation:string }>> = Object.freeze({
  facebook: { supported: true, explanation: "Meta Custom Audience from a customer list (hashed email / phone). Housing ads run in Meta's Special Ad Category: the custom audience is allowed; Meta itself refuses age, gender and ZIP narrowing and lookalike audiences at delivery, and the ad carries the platform's housing disclosures." },
  instagram: { supported: true, explanation: "Same Meta Custom Audience as Facebook (one Graph API account); the same Special Ad Category delivery rules apply." },
  google: { supported: true, explanation: "Google Ads Customer Match (hashed email / phone). The Ads account must be Customer-Match eligible (Google's own policy); Google's housing personalized-ads policy refuses age, gender, ZIP, parental and marital-status targeting at delivery." },
  linkedin: { supported: false, explanation: "LinkedIn Matched Audiences are not wired: there is no LinkedIn connector in lib/ads/connectors/registry.ts, so nothing could upload this list. Build it for Meta or Google, or add the connector (WAITING_EXTERNAL: a LinkedIn Marketing API app with Matched Audiences access)." },
  tiktok: { supported: false, explanation: "TikTok customer-file audiences are not wired: there is no TikTok connector in lib/ads/connectors/registry.ts. Build it for Meta or Google, or add the connector (WAITING_EXTERNAL: a TikTok for Business Marketing API app)." },
  stackadapt: { supported: false, explanation: "The StackAdapt connector here places TV / programmatic spots; a customer-list upload for a persona audience is not implemented or verified on it. Build it for Meta or Google." },
})

const LOOKALIKE_EXPLANATION =
  "A lookalike was asked for. Housing ads are a Special Ad Category: Meta does not offer Lookalike Audiences for them (its " +
  "replacement models are platform-controlled) and Google's housing policy restricts similar-audience modelling the same way — " +
  "so this product never builds one for a housing ad (LOOKALIKE_AD_POLICY, lib/kernel/lookalike-research.ts). The persona " +
  "audience itself is allowed: reach the people tagged with the persona directly."

export interface PersonaAudienceRequest {
  persona: string
  platform: PersonaAudiencePlatform | string
  /** True when the persona came from the derived study (persona-panel) — recorded as provenance on the source rule. */
  derived?: boolean
  /** An operator asking for a lookalike of the persona audience — explained, never built (platform housing rule). */
  lookalike?: boolean
}

export type PersonaAudiencePlan =
  | {
      ok: true
      persona: CampaignPersona
      platform: PersonaAudiencePlatform
      audienceName: string
      audienceType: "persona_segment"
      sourceRule: SourceRule
      consentBasis: string
      platformNote: string
    }
  | { ok: false; refusalKind: "unresolvable" | "no_basis" | "platform_unsupported" | "platform_housing_rule"; refusal: string }

/** PURE. Plan the ONE persona audience definition, or explain — provider-specifically — why the platform cannot carry it. */
export function planPersonaAudience(req: PersonaAudienceRequest): PersonaAudiencePlan {
  const persona = String(req.persona ?? "").trim().toLowerCase()
  if (!isCampaignPersona(persona)) {
    return { ok: false, refusalKind: "unresolvable", refusal: `"${req.persona}" is not a canonical persona — never guessed forward.` }
  }
  const platform = String(req.platform ?? "").trim().toLowerCase() as PersonaAudiencePlatform
  const support = PERSONA_AUDIENCE_PLATFORMS[platform]
  if (!support) {
    return { ok: false, refusalKind: "platform_unsupported", refusal: `"${req.platform}" is not an ad platform this product builds audiences for (${Object.keys(PERSONA_AUDIENCE_PLATFORMS).join(", ")}).` }
  }
  if (req.lookalike) return { ok: false, refusalKind: "platform_housing_rule", refusal: LOOKALIKE_EXPLANATION }
  if (!support.supported) return { ok: false, refusalKind: "platform_unsupported", refusal: support.explanation }
  const sourceRule = {
    type: PERSONA_SEGMENT_TYPE,
    ...(req.derived ? { basis: DERIVED_PERSONA_BASIS } : {}),
    filters: { personas: [persona] },
  } as SourceRule
  // The persona gate decides — never re-implemented here. Every persona but `other` resolves (owner ruling 2026-11-03).
  const basis = resolveAudiencePersonaBasis(sourceRule)
  if (!basis.ok) {
    return { ok: false, refusalKind: basis.refusalKind === "no_basis" ? "no_basis" : "unresolvable", refusal: basis.refusal }
  }
  // The name and consent basis are the template shelf's (lib/ads/fb-audience-templates.ts) — one spelling, never re-typed.
  const template = FB_AUDIENCE_TEMPLATES.find((t) => t.id === `persona_${persona}`)
  return {
    ok: true,
    persona,
    platform,
    audienceName: template?.name ?? `Persona — ${persona}`,
    audienceType: "persona_segment",
    sourceRule,
    consentBasis: template?.consentBasis ?? "Existing contacts with marketing consent — segmented on declared transaction situation",
    platformNote: support.explanation,
  }
}

export interface PersonaAudienceInput extends PersonaAudienceRequest {
  /** The SESSION tenant (solo agent, team or brokerage — the brokerages row) — never a body value. */
  tenant: { brokerageId: string }
  /** The SESSION user who creates it (users.id) — attribution. agentId only when the seat has an agents row. */
  creator: { userId: string; agentId?: string | null }
  adCampaignId?: string | null
}

export interface PersonaAudienceResult {
  ok: boolean
  audienceId?: string
  plan?: Extract<PersonaAudiencePlan, { ok: true }>
  refusalKind?: Extract<PersonaAudiencePlan, { ok: false }>["refusalKind"] | "create_failed" | "ledger_refused"
  error?: string
  attribution?: { creatorUserId: string; persona: CampaignPersona; platform: PersonaAudiencePlatform; audienceId: string; basis: "derived_persona" | "staff_chosen" }
  /** The upload is a separate, human-approved step on the existing door (approveAudience → syncAudience). */
  nextStep?: string
}

/** The survivor doors, injected so a proof runs them on fixtures; the defaults are the Ads Manager kernel + the action ledger. */
export interface PersonaAudienceDeps {
  createSegment: (args: {
    ctx: { brokerageId: string; userId: string; agentId: string }
    audienceName: string; audienceType: "persona_segment"; sourceRule: SourceRule; consentBasis: string
    adCampaignId?: string; targetPlatform: PersonaAudiencePlatform
  }) => Promise<{ success: boolean; audienceId?: string; error?: string }>
  ledger: (ctx: Record<string, unknown>, run: () => Promise<SegmentResult>, settle: (r: SegmentResult) => { status: "executed" | "failed" | "skipped"; outcome: string; error?: string | null }) => Promise<SegmentResult | LedgerReplay>
}
type SegmentResult = { success: boolean; audienceId?: string; error?: string }
type LedgerReplay = { replayed: true; reason: string }

async function defaultDeps(): Promise<PersonaAudienceDeps> {
  const { createAudienceSegment } = await import("@/lib/kernel/ads")
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return {
    createSegment: (a) => createAudienceSegment(a as Parameters<typeof createAudienceSegment>[0]),
    ledger: (ctx, run, settle) =>
      withActionLedger<SegmentResult | LedgerReplay>(ctx as unknown as Parameters<typeof withActionLedger>[0], run, {
        settle: (r) => ("replayed" in r ? { status: "skipped", outcome: "replayed" } : settle(r)),
        replay: (claim) => ({ replayed: true as const, reason: claim.kind === "refused" ? `refused: ${claim.error}` : claim.kind }),
      }),
  }
}

/**
 * C26. Plan → create on the Ads Manager survivor (draft; the upload waits for the human approval the existing door asks) →
 * ledger + attribution. Tenant and creator come from the caller's SESSION resolution (the "use server" door), never a body.
 */
export async function createPersonaAudience(input: PersonaAudienceInput, deps?: PersonaAudienceDeps): Promise<PersonaAudienceResult> {
  if (!input.tenant?.brokerageId || !input.creator?.userId) {
    return { ok: false, refusalKind: "create_failed", error: "A session tenant and creating user are required — nothing was created." }
  }
  const plan = planPersonaAudience(input)
  if (!plan.ok) return { ok: false, refusalKind: plan.refusalKind, error: plan.refusal }
  const d = deps ?? (await defaultDeps())
  const ctx = {
    brokerageId: input.tenant.brokerageId,
    action: "ads.persona_audience.create",
    actor: { type: "user", userId: input.creator.userId, agentId: input.creator.agentId ?? null },
    subject: { type: "facebook_custom_audiences", id: null, ref: `persona:${plan.persona}:${plan.platform}` },
    riskClass: "LOW_RISK_WRITE",
    channel: plan.platform,
    detail: { persona: plan.persona, platform: plan.platform, basis: input.derived ? DERIVED_PERSONA_BASIS : "staff_chosen", source_rule: plan.sourceRule },
  }
  const created = await d.ledger(ctx, () => d.createSegment({
    ctx: { brokerageId: input.tenant.brokerageId, userId: input.creator.userId, agentId: input.creator.agentId ?? "" },
    audienceName: plan.audienceName,
    audienceType: plan.audienceType,
    sourceRule: plan.sourceRule,
    consentBasis: plan.consentBasis,
    ...(input.adCampaignId ? { adCampaignId: input.adCampaignId } : {}),
    targetPlatform: plan.platform,
  }), (r) => r.success
    ? { status: "executed", outcome: `persona_audience_created:${r.audienceId}` }
    : { status: "failed", outcome: "persona_audience_refused", error: r.error ?? null })
  if ("replayed" in created) return { ok: false, refusalKind: "ledger_refused", error: `The action ledger did not admit this create (${created.reason}) — nothing was created twice.`, plan }
  if (!created.success || !created.audienceId) return { ok: false, refusalKind: "create_failed", error: created.error ?? "The audience was not created.", plan }
  return {
    ok: true,
    audienceId: created.audienceId,
    plan,
    attribution: { creatorUserId: input.creator.userId, persona: plan.persona, platform: plan.platform, audienceId: created.audienceId, basis: input.derived ? "derived_persona" : "staff_chosen" },
    nextStep: "Review and approve the audience — approval uploads it at once (owner ruling R4), and it keeps itself current: newly eligible people join and anyone who opts out or is suppressed leaves. Only consented, unsuppressed contacts tagged with the persona are uploaded, hashed.",
  }
}

// ── OWNER RULING R4 (2026-11-06; wave 150, lane 150QTV) — AUTOMATIC SYNC AFTER APPROVAL / ELIGIBILITY, REVOCATIONS TOO ──────────
// The approval door uploads at once (lib/ads/facebook-audience-sync.ts approveAudience). What changes AFTER that — a contact newly
// tagged with the persona, a consent granted, an opt-out, a suppression — must reach the platform the same way, without a button.
// Before this, the unattended door (app/api/cron/sync-facebook-audiences — an EXISTING tick, no new timer) picked only status
// 'approved'; the upload writes 'synced', so a live audience was never re-uploaded and a person who opted out stayed in it on Meta.
// Every upload is now a FULL REPLACE of the platform list (Meta usersreplace / Google removeAll — lib/ads/connectors), so a re-sync
// is how a revocation leaves. This selector says WHICH audiences the tick re-syncs, from evidence:
//   · approved and never uploaded                       → "approved — first upload";
//   · the last upload failed                            → "the last upload failed — retrying";
//   · live, and the tenant's contacts or suppression list changed after the last upload → "eligibility changed since the last
//     upload" (a consent / persona / opt-out change lands on contacts.updated_at; a suppression on contact_suppression_list).
// FAIL TOWARD THE REVOCATION: a tenant whose evidence cannot be read is re-synced (the sync re-applies consent + suppression), and
// the reason says so. Tenant comes from each audience ROW (the cron has no session and takes no tenant from a caller).

export interface AudienceResyncCandidate { id: string; brokerage_id: string; audience_name: string; reason: string }

/** The audiences the unattended door should (re-)upload now, each with its reason. Every `{ error }` is read. */
export async function audiencesNeedingResync(
  svc: { from: (t: string) => any },
  opts: { limit?: number } = {},
): Promise<{ ok: true; audiences: AudienceResyncCandidate[]; notes: string[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("facebook_custom_audiences")
    .select("id, brokerage_id, audience_name, status, last_synced_at")
    .in("status", ["approved", "synced", "failed"])
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(opts.limit ?? 200)
  if (error) return { ok: false, error: `audience read refused (${error.message})` }
  const rows = (data ?? []) as Array<{ id: string; brokerage_id: string; audience_name: string | null; status: string; last_synced_at: string | null }>
  const notes: string[] = []
  const latestChange = new Map<string, number | "unreadable">()
  const changeFor = async (brokerageId: string): Promise<number | "unreadable"> => {
    const memo = latestChange.get(brokerageId)
    if (memo !== undefined) return memo
    const [c, s] = await Promise.all([
      svc.from("contacts").select("updated_at").eq("brokerage_id", brokerageId).order("updated_at", { ascending: false }).limit(1),
      svc.from("contact_suppression_list").select("created_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(1),
    ])
    let v: number | "unreadable"
    if (c.error || s.error) {
      v = "unreadable"
      notes.push(`tenant ${brokerageId}: eligibility evidence unreadable (${c.error?.message ?? s.error?.message}) — re-syncing so revocations still leave`)
    } else {
      const t = [((c.data ?? [])[0] as { updated_at?: string } | undefined)?.updated_at, ((s.data ?? [])[0] as { created_at?: string } | undefined)?.created_at]
        .map((x) => Date.parse(String(x ?? ""))).filter((n) => Number.isFinite(n))
      v = t.length ? Math.max(...t) : 0
    }
    latestChange.set(brokerageId, v)
    return v
  }
  const out: AudienceResyncCandidate[] = []
  for (const r of rows) {
    const name = r.audience_name || r.id
    if (r.status === "approved" && !r.last_synced_at) { out.push({ id: r.id, brokerage_id: r.brokerage_id, audience_name: name, reason: "approved — first upload" }); continue }
    if (r.status === "failed") { out.push({ id: r.id, brokerage_id: r.brokerage_id, audience_name: name, reason: "the last upload failed — retrying" }); continue }
    const last = Date.parse(r.last_synced_at ?? "")
    const changed = await changeFor(r.brokerage_id)
    if (changed === "unreadable" || !Number.isFinite(last) || changed > last) {
      out.push({ id: r.id, brokerage_id: r.brokerage_id, audience_name: name, reason: changed === "unreadable" ? "eligibility evidence unreadable — re-syncing so revocations still leave" : "eligibility changed since the last upload" })
    }
  }
  return { ok: true, audiences: out, notes }
}
