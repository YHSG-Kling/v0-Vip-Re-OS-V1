"use server"

// app/actions/custom-domains.ts — WHITE-LABEL CUSTOM DOMAINS, tenant surface.
//
// Brokerage-tier feature: point www.theirbrokerage.com at the tenant's
// /site/[slug] storefront (proxy.ts does the host→slug rewrite once a row is
// 'active'). Row lifecycle in tenant_custom_domains:
//
//   pending_dns  — row created; tenant sets DNS (and, when the Vercel API is
//                  configured, the domain is registered with the project and
//                  any challenge records are stored in verification jsonb)
//   verifying    — a status check ran, domain registered, not yet verified
//   active       — Vercel verified the domain (verified_at stamped); the
//                  middleware starts serving the tenant site on this host
//   error        — captured honestly in error_detail (e.g. domain owned by
//                  another Vercel account/project)
//   removed      — detached (Vercel delete best-effort); row kept for audit
//
// MOCK-SAFE: without VERCEL_TOKEN/VERCEL_PROJECT_ID rows stay 'pending_dns'
// and every response says so ({ vercelConfigured: false } + instructions) —
// the standard DNS targets are still shown, nothing pretends to verify.
//
// Gates: tenant principal (resolveWriteContext) for reads; brokerage-admin
// types for writes; plan tier gated to Brokerage/Multi-Location (legacy
// non-canonical tiers fail OPEN, same rule as lib/kernel/tier-role-matrix).
// Cap: 2 domains per brokerage (apex + www is the intended pair).
// Audited via the tenant audit idiom (audit_log insert, entity_type
// 'tenant_custom_domain').

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { isCanonicalTier, TIER_LABELS } from "@/lib/kernel/tier-role-matrix"
import {
  validateCustomDomain,
  platformReservedHosts,
  dnsInstructionsFor,
  addDomainToProject,
  getDomainStatus,
  removeDomainFromProject,
  getVercelDomainsConfig,
  reportCustomDomainOutcome,
  VERCEL_NOT_CONFIGURED_NOTE,
  type DnsRecordInstruction,
  type VercelVerificationChallenge,
} from "@/lib/platform/custom-domains"

// TENANT ADMIN GATE (kept inline, infra/credentials): 'superadmin' removed —
// dead as users.user_type (0 live rows); broker_owner added — storable seat
// that owns the brokerage.
const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])
const DOMAIN_CAP = 2

// ── Gating helpers ───────────────────────────────────────────────────────────

/**
 * EVERY TIER. Not a stub — the ruling.
 *
 * OWNER, verbatim: "when we have the team and solo agent subscription tiers,
 * those subscriptions get the same level of features as brokerages." Tiers
 * differ by SEAT COUNT, not by feature set. A solo agent's own storefront is
 * exactly the surface a custom domain is for.
 *
 * ── FLAGGED FOR PRICING, NOT WITHHELD ───────────────────────────────────────
 *
 * Custom domains are one of the three parity items with a REAL per-tenant
 * operating cost rather than a code gate: each active domain is a registration
 * against the Vercel project, a DNS/verification loop to support and a
 * certificate to keep issued — and DOMAIN_CAP below means up to two per tenant.
 * Opening it to solo/team multiplies that by the number of tenants on the
 * cheapest plans. It ships open because the owner ruled it open; the cost is
 * reported so it can be PRICED rather than silently absorbed.
 *
 * Kept as a named function rather than deleted so the shape of the decision
 * stays visible — restoring a floor is a one-line change.
 */
function tierAllowsCustomDomains(tier: string | null | undefined): boolean {
  void tier
  return true
}

const TIER_GATE_ERROR =
  "Custom domains are not available on your plan — your site stays live on the platform URL."

interface AdminGate {
  ok: true
  userId: string
  brokerageId: string
  tier: string | null
  siteSlug: string | null
}

async function requireBrokerageAdmin(): Promise<AdminGate | { ok: false; error: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return { ok: false, error: "Forbidden — brokerage admin only" }
  const svc = createServiceClient()
  const { data: brk } = await svc
    .from("brokerages").select("plan_tier, slug")
    .eq("id", ctx.brokerageId).maybeSingle()
  return {
    ok: true,
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    tier: (brk as any)?.plan_tier ?? null,
    siteSlug: (brk as any)?.slug ?? null,
  }
}

async function audit(svc: any, userId: string, action: string, entityId: string, after: Record<string, unknown>) {
  try {
    await svc.from("audit_log").insert({
      user_id: userId,
      action,
      entity_type: "tenant_custom_domain",
      entity_id: entityId,
      before: null,
      after,
    })
  } catch {
    /* audit is best-effort — never fail the user action on a log write */
  }
}

// ── View types ───────────────────────────────────────────────────────────────

export interface CustomDomainView {
  id: string
  domain: string
  status: string
  /** Vercel's standard DNS targets for this host (always shown). */
  dnsRecords: DnsRecordInstruction[]
  /** Extra challenge records the Vercel API asked for (live mode only). */
  challenges: VercelVerificationChallenge[]
  errorDetail: string | null
  verifiedAt: string | null
  lastCheckedAt: string | null
  createdAt: string | null
}

export interface CustomDomainsPanel {
  tierAllowed: boolean
  tierLabel: string
  canManage: boolean
  vercelConfigured: boolean
  /** Honest note shown when the Vercel API is not configured. */
  unconfiguredNote: string | null
  cap: number
  siteSlug: string | null
  domains: CustomDomainView[]
}

function rowToView(row: any): CustomDomainView {
  const verification = (row.verification ?? {}) as { challenges?: unknown }
  const challenges = Array.isArray(verification.challenges)
    ? (verification.challenges as VercelVerificationChallenge[])
    : []
  return {
    id: String(row.id),
    domain: String(row.domain),
    status: String(row.status),
    dnsRecords: dnsInstructionsFor(String(row.domain)),
    challenges,
    errorDetail: row.error_detail ?? null,
    verifiedAt: row.verified_at ?? null,
    lastCheckedAt: row.last_checked_at ?? null,
    createdAt: row.created_at ?? null,
  }
}

const ROW_COLUMNS = "id, brokerage_id, domain, status, verification, error_detail, created_at, verified_at, last_checked_at"

// ── READ: the settings-card panel ────────────────────────────────────────────

export async function getCustomDomainsPanel(): Promise<
  { ok: true; panel: CustomDomainsPanel } | { ok: false; error: string }
> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()

  const [{ data: brk }, { data: rows }] = await Promise.all([
    svc.from("brokerages").select("plan_tier, slug").eq("id", ctx.brokerageId).maybeSingle(),
    svc.from("tenant_custom_domains").select(ROW_COLUMNS)
      .eq("brokerage_id", ctx.brokerageId).neq("status", "removed")
      .order("created_at", { ascending: true }),
  ])

  const tier = (brk as any)?.plan_tier ?? null
  const configured = getVercelDomainsConfig().configured
  return {
    ok: true,
    panel: {
      tierAllowed: tierAllowsCustomDomains(tier),
      tierLabel: isCanonicalTier(tier) ? TIER_LABELS[tier] : "your current",
      canManage: ADMIN_TYPES.has(ctx.userType ?? ""),
      vercelConfigured: configured,
      unconfiguredNote: configured ? null : VERCEL_NOT_CONFIGURED_NOTE,
      cap: DOMAIN_CAP,
      siteSlug: (brk as any)?.slug ?? null,
      domains: ((rows ?? []) as any[]).map(rowToView),
    },
  }
}

// ── ADD ──────────────────────────────────────────────────────────────────────

export async function addCustomDomainAction(rawDomain: string): Promise<
  { ok: true; domain: CustomDomainView } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate
  if (!tierAllowsCustomDomains(gate.tier)) return { ok: false, error: TIER_GATE_ERROR }
  if (!gate.siteSlug) {
    return { ok: false, error: "Your brokerage has no site slug yet — save your branding first so /site is live." }
  }

  const validated = validateCustomDomain(rawDomain, platformReservedHosts())
  if (!validated.ok) return { ok: false, error: validated.error }
  const domain = validated.domain

  const svc = createServiceClient()

  // Cap: 2 live rows per brokerage (apex + www is the intended pair).
  const { count } = await svc.from("tenant_custom_domains")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", gate.brokerageId).neq("status", "removed")
  if ((count ?? 0) >= DOMAIN_CAP) {
    return { ok: false, error: `Limit reached — up to ${DOMAIN_CAP} custom domains per brokerage (apex + www). Remove one first.` }
  }

  // domain is globally UNIQUE — revive our own removed row, refuse anyone else's.
  const { data: existing } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("domain", domain).maybeSingle()
  if (existing && (existing as any).brokerage_id !== gate.brokerageId) {
    return { ok: false, error: "That domain is already connected to another workspace." }
  }
  if (existing && (existing as any).status !== "removed") {
    return { ok: false, error: "That domain is already connected to your workspace." }
  }

  let row: any
  if (existing) {
    const { data, error } = await svc.from("tenant_custom_domains")
      .update({
        status: "pending_dns",
        verification: { challenges: [] },
        error_detail: null,
        verified_at: null,
        last_checked_at: null,
        added_by: gate.userId,
      })
      .eq("id", (existing as any).id)
      .select(ROW_COLUMNS).single()
    if (error) return { ok: false, error: error.message }
    row = data
  } else {
    const { data, error } = await svc.from("tenant_custom_domains")
      .insert({
        brokerage_id: gate.brokerageId,
        domain,
        status: "pending_dns",
        verification: { challenges: [] },
        added_by: gate.userId,
      })
      .select(ROW_COLUMNS).single()
    if (error) {
      if ((error as any).code === "23505") {
        return { ok: false, error: "That domain is already connected to another workspace." }
      }
      return { ok: false, error: error.message }
    }
    row = data
  }

  // Register with Vercel when configured; store challenges. Rows stay
  // 'pending_dns' until a status check verifies (or an error is captured).
  const vercel = await addDomainToProject(domain)
  if (vercel.configured) {
    if (!vercel.ok) {
      const { data } = await svc.from("tenant_custom_domains")
        .update({
          status: "error",
          error_detail: vercel.error ?? "Vercel rejected the domain",
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", row.id).select(ROW_COLUMNS).single()
      row = data ?? { ...row, status: "error", error_detail: vercel.error }
      // Rail outcome onto the governed bus + self-heal ledger (best-effort).
      await reportCustomDomainOutcome({
        brokerageId: gate.brokerageId, domainRowId: String(row.id), domain,
        outcome: "error", phase: "add", errorCode: vercel.errorCode, errorDetail: vercel.error,
      })
    } else {
      const nowIso = new Date().toISOString()
      const patch: Record<string, unknown> = {
        verification: { challenges: vercel.challenges, registered_with_vercel: true },
        last_checked_at: nowIso,
        error_detail: null,
      }
      if (vercel.verified) {
        patch.status = "active"
        patch.verified_at = nowIso
      }
      const { data } = await svc.from("tenant_custom_domains")
        .update(patch).eq("id", row.id).select(ROW_COLUMNS).single()
      row = data ?? row
      if (vercel.verified) {
        // status→active on first registration — announce it on the governed bus.
        await reportCustomDomainOutcome({
          brokerageId: gate.brokerageId, domainRowId: String(row.id), domain,
          outcome: "verified", phase: "add",
        })
      }
    }
  }

  await audit(svc, gate.userId, "custom_domain_added", String(row.id), {
    brokerage_id: gate.brokerageId,
    domain,
    status: row.status,
    vercel_configured: vercel.configured,
  })
  revalidatePath("/settings/branding")
  return { ok: true, domain: rowToView(row) }
}

// ── CHECK STATUS ─────────────────────────────────────────────────────────────

export async function checkCustomDomainStatusAction(id: string): Promise<
  { ok: true; domain: CustomDomainView; vercelConfigured: boolean } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate

  const svc = createServiceClient()
  const { data: existing } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("id", id).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (!existing) return { ok: false, error: "Domain not found" }
  if ((existing as any).status === "removed") return { ok: false, error: "Domain was removed" }

  const nowIso = new Date().toISOString()

  // MOCK-SAFE: no token → the row honestly stays where it is; only the
  // check timestamp moves.
  let result = await getDomainStatus((existing as any).domain)
  if (!result.configured) {
    const { data } = await svc.from("tenant_custom_domains")
      .update({ last_checked_at: nowIso }).eq("id", id).select(ROW_COLUMNS).single()
    return { ok: true, domain: rowToView(data ?? existing), vercelConfigured: false }
  }

  // Drift heal: registered here but missing on the project (e.g. detached in
  // the Vercel dashboard) — re-attach once, then report that result.
  if (!result.ok && result.errorCode === "not_found") {
    result = await addDomainToProject((existing as any).domain)
  }

  let patch: Record<string, unknown>
  if (result.configured && result.ok) {
    if (result.verified) {
      patch = {
        status: "active",
        verified_at: (existing as any).verified_at ?? nowIso,
        verification: { challenges: [], registered_with_vercel: true },
        error_detail: null,
        last_checked_at: nowIso,
      }
    } else {
      patch = {
        status: "verifying",
        verification: { challenges: result.challenges, registered_with_vercel: true },
        error_detail: null,
        last_checked_at: nowIso,
      }
    }
  } else {
    const detail = (result.configured && result.error) || "Vercel API error"
    patch = { status: "error", error_detail: detail, last_checked_at: nowIso }
  }

  const { data: updated, error: upErr } = await svc.from("tenant_custom_domains")
    .update(patch).eq("id", id).select(ROW_COLUMNS).single()
  if (upErr) return { ok: false, error: upErr.message }

  if (patch.status === "active" && (existing as any).status !== "active") {
    await audit(svc, gate.userId, "custom_domain_verified", id, {
      brokerage_id: gate.brokerageId,
      domain: (existing as any).domain,
    })
    // status→active — the rail's outcome onto the governed bus (best-effort).
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain: (existing as any).domain,
      outcome: "verified", phase: "verify",
    })
  } else if (patch.status === "error") {
    // Verification hit an error — feed alert for the human + self-heal ledger.
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain: (existing as any).domain,
      outcome: "error", phase: "verify",
      errorCode: result.configured && !result.ok ? result.errorCode : null,
      errorDetail: String(patch.error_detail ?? ""),
    })
  }
  revalidatePath("/settings/branding")
  return { ok: true, domain: rowToView(updated), vercelConfigured: true }
}

// ── REMOVE ───────────────────────────────────────────────────────────────────

export async function removeCustomDomainAction(id: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate

  const svc = createServiceClient()
  const { data: existing } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("id", id).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (!existing) return { ok: false, error: "Domain not found" }

  // Vercel detach is best-effort — the row goes to 'removed' either way so
  // the middleware stops serving the host immediately.
  const vercel = await removeDomainFromProject((existing as any).domain)
  if (vercel.configured && !vercel.ok) {
    // Ledger the API failure (no feed line — the row is removed regardless).
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain: (existing as any).domain,
      outcome: "error", phase: "remove", errorDetail: vercel.error, announce: false,
    })
  }

  const { error } = await svc.from("tenant_custom_domains")
    .update({
      status: "removed",
      error_detail: vercel.ok ? null : `Removed locally; Vercel detach failed: ${vercel.error}`,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (error) return { ok: false, error: error.message }

  await audit(svc, gate.userId, "custom_domain_removed", id, {
    brokerage_id: gate.brokerageId,
    domain: (existing as any).domain,
    vercel_detached: vercel.ok,
  })
  revalidatePath("/settings/branding")
  return { ok: true }
}
