"use server"

// app/actions/superadmin/platform-growth.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SELF-MARKETING — capture + work prospects for VIP Agents itself. Public
// capture (anyone can raise their hand for the product); the funnel + advance +
// pitch-draft are gated to platform MARKETING staff (or superadmin) via the
// capability map. Every staff write is audited.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import {
  validateProspectInput, rollupGrowthFunnel, composeProspectOutreach, PROSPECT_STATUSES,
  PROPOSAL_SECTIONS, proposalPricingLine, type ProspectProposal, type ProposalSectionKey,
} from "@/lib/platform/growth-funnel"
import { platformStaffCan, resolvePlatformRoleIdentity } from "@/lib/platform/platform-staff-roster"

// ── PUBLIC: capture a prospect (no auth — a "get started / notify me" hand-raise) ──
export async function capturePlatformProspectAction(input: {
  name?: string; email: string; company?: string; roleInterest?: string; source?: string; interestNote?: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const v = validateProspectInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const svc = createServiceClient()
  // Idempotent by email — a repeat hand-raise updates, never duplicates.
  const { data, error } = await svc.from("platform_prospects").upsert({
    name: v.value.name, email: v.value.email, company: v.value.company,
    role_interest: v.value.roleInterest, source: v.value.source, interest_note: v.value.interestNote,
    updated_at: new Date().toISOString(),
  }, { onConflict: "email" }).select("id").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: (data as any).id }
}

// ── PUBLIC: demo-request capture (the /demo booking form) ─────────────────────
// Same platform_prospects rail as the get-started hand-raise (idempotent by
// email), stamped source 'demo_request' so the growth board surfaces it, with
// the preferred times kept on BOTH interest_note (skimmable) and details jsonb
// (structured). Honest flow: a human follows up — nothing is auto-scheduled.
export async function requestPlatformDemoAction(input: {
  name?: string; email: string; company?: string; roleInterest?: string; preferredTimes?: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const preferredTimes = (input.preferredTimes ?? "").trim().slice(0, 600) || null
  const v = validateProspectInput({
    name: input.name, email: input.email, company: input.company, roleInterest: input.roleInterest,
    source: "demo_request",
    interestNote: preferredTimes ? `Demo request — preferred times: ${preferredTimes}` : "Demo request",
  })
  if (!v.ok) return { ok: false, error: v.error }
  const svc = createServiceClient()
  // Merge details (a repeat request must not clobber a stored proposal).
  const { data: existing, error: readErr } = await svc.from("platform_prospects").select("details").eq("email", v.value.email).maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }
  const details = {
    ...(((existing as any)?.details as Record<string, unknown>) ?? {}),
    demo_request: { preferred_times: preferredTimes, requested_at: new Date().toISOString() },
  }
  const { data, error } = await svc.from("platform_prospects").upsert({
    name: v.value.name, email: v.value.email, company: v.value.company,
    role_interest: v.value.roleInterest, source: v.value.source, interest_note: v.value.interestNote,
    details, updated_at: new Date().toISOString(),
  }, { onConflict: "email" }).select("id").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: (data as any).id }
}

// ── Gated: platform marketing staff (or superadmin) ───────────────────────────
async function requireMarketingStaff(): Promise<{ ok: true; userId: string; email: string; role: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = resolvePlatformRoleIdentity((data as any)?.user_type, (data as any)?.platform_role)
  // `!role ||` is a TYPE narrowing, not a second gate: platformStaffCan(null, …) is
  // already false. It is spelled out because this function RETURNS `role: string`,
  // and the survivor gives an honest `PlatformStaffRole | null` where the old
  // inline expression was `any` (it read `(data as any)?.platform_role ?? …`, so
  // the null was invisible to the compiler). The type is now real; the guard says so.
  if (!role || !platformStaffCan(role, "marketing")) return { ok: false, error: "Forbidden — platform marketing access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "", role }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_prospect", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-growth audit] failed:", err) }
}

export async function listPlatformProspectsAction(): Promise<{ ok: true; prospects: any[]; funnel: ReturnType<typeof rollupGrowthFunnel> } | { ok: false; error: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // `phone` is selected because the AI reception captures phone-only prospects
  // (email null — l32-s01 dropped the NOT NULL): without it the board showed a
  // caller with NO way to reach them (the phone column was written by
  // capturePhoneProspect and read by nothing staff-facing — §1.2, 2026-08-27).
  const { data, error } = await svc.from("platform_prospects")
    .select("id, name, email, phone, company, role_interest, source, status, interest_note, details, contacted_at, created_at")
    .order("created_at", { ascending: false }).limit(500)
  if (error) return { ok: false, error: error.message }
  return { ok: true, prospects: data ?? [], funnel: rollupGrowthFunnel(data ?? []) }
}

export async function advanceProspectAction(input: { id: string; status: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  if (!(PROSPECT_STATUSES as readonly string[]).includes(input.status)) return { ok: false, error: "Invalid status" }
  const svc = createServiceClient()
  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() }
  if (input.status === "contacted") patch.contacted_at = new Date().toISOString()
  const { error } = await svc.from("platform_prospects").update(patch).eq("id", input.id)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_prospect.advanced", input.id, { status: input.status })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/**
 * Generate a per-prospect PROPOSAL document — the assisted-sale artifact. Every
 * consumer-facing word is AI-AUTHORED through the charter rail (generateTextRouted
 * + withScriptStandards) grounded in the PLATFORM'S OWN brand context
 * (loadProductBrand — the platform-collateral analogue of resolveBrandContext)
 * and in REAL data: the prospect's row + the DB-driven subscription tier.
 * Authoring failure = honest absence (an error, never template prose). The
 * document persists on the prospect row (details.proposal) for the growth board.
 */
export async function generateProspectProposalAction(id: string): Promise<{ ok: true; proposal: ProspectProposal } | { ok: false; error: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: p, error: pErr } = await svc.from("platform_prospects")
    .select("id, name, email, company, role_interest, source, status, interest_note, details")
    .eq("id", id).maybeSingle()
  if (pErr) return { ok: false, error: pErr.message }
  if (!p) return { ok: false, error: "Prospect not found" }

  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const { loadPublicTiers } = await import("@/lib/platform/public-tiers")
  const [brand, tiers] = await Promise.all([loadProductBrand(svc), loadPublicTiers(svc)])
  if (tiers.length === 0) return { ok: false, error: "No active subscription tiers — publish plans before generating proposals." }

  // Recommended tier: the prospect's declared shape maps 1:1 onto tier vocabulary
  // (solo_agent/team/brokerage/multi_location); unknown falls to the featured plan.
  const row = p as any
  const tierRow = tiers.find((t) => t.tierName === row.role_interest) ?? tiers.find((t) => t.featured) ?? tiers[0]
  const tier = {
    tierName: tierRow.tierName, displayName: tierRow.displayName,
    monthlyCents: tierRow.monthlyCents, annualCents: tierRow.annualCents, setupCents: tierRow.setupCents,
  }
  const demoUrl = `${brand.ctaUrl}/demo`

  // Charter-governed authoring — platform brand voice, real facts only.
  let sections: Record<ProposalSectionKey, string> | null = null
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { withScriptStandards } = await import("@/lib/ai/script-standards")
    const keys = PROPOSAL_SECTIONS.map((s) => `"${s.key}": ${s.hint}`).join(",\n  ")
    const { text } = await generateTextRouted({
      feature: "client_message",
      system: withScriptStandards(
        `You write sales proposals for ${brand.name} — ${brand.tagline}. The product: ${brand.voicePitch}. ` +
        `HONEST ONLY: use exclusively the facts provided below — no fabricated statistics, testimonials, client names, or guarantees. ` +
        `Quote plan names, prices, and links VERBATIM as given.`,
      ),
      prompt:
        `Prospect facts:\n` +
        `- Name: ${row.name ?? "(not given)"}\n` +
        `- Company: ${row.company ?? "(not given)"}\n` +
        `- Business shape: ${row.role_interest}\n` +
        `- How they found us: ${row.source}\n` +
        `- What they told us: ${row.interest_note ?? "(nothing yet)"}\n` +
        `- Funnel status: ${row.status}\n\n` +
        `Recommended plan (DB-priced, quote verbatim): ${proposalPricingLine(tier)}\n` +
        `Plan inclusions (the ONLY capabilities you may cite):\n${tierRow.bullets.map((b) => `- ${b}`).join("\n") || "- (plan inclusions not yet published — speak only to the product description above)"}\n` +
        `Plan description: ${tierRow.description || "(none)"}\n\n` +
        `Migration fact: white-glove onboarding is guided, and existing data (contacts, listings, pipeline) can be imported by the platform team.\n` +
        `Trial fact: 14-day free trial, no credit card required.\n` +
        `Demo link (must appear verbatim in next_steps): ${demoUrl}\n\n` +
        `Return ONLY a JSON object:\n{\n  ${keys}\n}`,
      temperature: 0.6,
      maxTokens: 1100,
      userId: auth.userId,
    })
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>
      const out = {} as Record<ProposalSectionKey, string>
      let complete = true
      for (const s of PROPOSAL_SECTIONS) {
        const val = parsed[s.key]
        if (typeof val !== "string" || !val.trim()) { complete = false; break }
        out[s.key] = val.trim()
      }
      if (complete) sections = out
    }
  } catch { /* honest absence below */ }
  if (!sections) {
    return { ok: false, error: "Proposal authoring is unavailable right now — nothing was saved (no template prose). Try again in a moment." }
  }

  const proposal: ProspectProposal = { generatedAt: new Date().toISOString(), demoUrl, tier, sections }
  const details = { ...((row.details as Record<string, unknown>) ?? {}), proposal }
  const { error: upErr } = await svc.from("platform_prospects").update({ details, updated_at: new Date().toISOString() }).eq("id", id)
  if (upErr) return { ok: false, error: upErr.message }
  await audit(auth.userId, auth.email, "platform_prospect.proposal_generated", id, { tier: tier.tierName, demo_url: demoUrl })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true, proposal }
}

/** Draft the platform's own outreach pitch for a prospect — GATED, never auto-sent. */
export async function draftProspectOutreachAction(id: string): Promise<{ ok: true; subject: string; body: string } | { ok: false; error: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: p } = await svc.from("platform_prospects").select("name, role_interest, company").eq("id", id).maybeSingle()
  if (!p) return { ok: false, error: "Prospect not found" }
  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const brand = await loadProductBrand(svc)
  const draft = composeProspectOutreach({ name: (p as any).name, roleInterest: (p as any).role_interest, company: (p as any).company, brandName: brand.name })
  return { ok: true, ...draft }
}
