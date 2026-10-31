"use server"

// app/actions/custom-domains.ts — WHITE-LABEL CUSTOM DOMAINS, tenant surface.
//
// The tenant's website is ALREADY live at /site/[slug] the moment the tenant exists
// (lib/kernel/tenant-creation.ts tenantWebsitePath; the operating baseline mints the
// slug). A custom domain is OPTIONAL: the tenant connects a domain THEY OWN at THEIR
// DNS provider (owner, wave 141: VIPAgents never sells, registers or hosts domains).
// proxy.ts does the host→slug rewrite once a row is 'active'. Row lifecycle in
// tenant_custom_domains — ONE transition table, lib/platform/custom-domains.ts
// nextCustomDomainStatus (wave 141G):
//
//   pending_dns  — row created; tenant sets DNS (and, when routing is available,
//                  the domain is attached to the project and any challenge
//                  records are stored in verification jsonb)
//   verifying    — a status check ran, domain attached, not yet verified
//   active       — the routing layer verified the domain (verified_at stamped);
//                  the middleware starts serving the tenant site on this host
//   error        — captured honestly: the CODE in verification.error_code, the raw
//                  routing-layer message in error_detail (STAFF evidence); the tenant
//                  sees tenantFacingDomainMessage only
//   removed      — detached (routing delete best-effort); row kept for audit
//
// WAVE 141G — lane B's rule, applied: REQUEST → validate → execute → IMMEDIATE
// post-condition (confirmDomainRowPostCondition re-reads the row under its tenant and
// refuses an inadmissible state — success is never reported past a failed
// post-condition) → emit the kernel event (reportCustomDomainOutcome) → the readers
// pick it up. Every routing-layer call is ledgered (withActionLedger, HUMAN_REQUESTED,
// LAW 5) and gated by mayUseAndAfford (LAW 2). A DNS probe (probeDomainDns) gives the
// tenant IMMEDIATE feedback on every connect and check; it is feedback, never the
// verdict — only the routing layer's verified flag reaches 'active'.
//
// MOCK-SAFE / FAIL-CLOSED: without routing credentials rows stay where they are and
// every response says so ({ routingAvailable: false } + a tenant-safe note) — the
// standard DNS targets are still shown, nothing pretends to verify, nothing goes
// active. The tenant never sees a provider name, an env key or a raw API message
// (wave 141 PROVIDER VISIBILITY ruling).
//
// Gates: tenant principal (resolveWriteContext) for reads; the brokerage-admin class
// DERIVED from the roster for writes (see ADMIN_TYPES); plan tier open on every tier
// (owner ruling, see tierAllowsCustomDomains). Cap: 2 domains per brokerage (apex +
// www is the intended pair). Audited via the tenant audit idiom (audit_log insert,
// entity_type 'tenant_custom_domain').

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { isCanonicalTier, TIER_LABELS } from "@/lib/kernel/tier-role-matrix"
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { mayUseAndAfford } from "@/lib/billing/billing-access"
import { withActionLedger, type Settlement, type NonActingClaim } from "@/lib/kernel/action-ledger"
import {
  validateCustomDomain,
  platformReservedHosts,
  dnsInstructionsFor,
  dnsProviderGuide,
  DNS_PROVIDERS,
  probeDomainDns,
  nextCustomDomainStatus,
  CONNECT_POST_CONDITION_STATUSES,
  tenantFacingDomainMessage,
  addDomainToProject,
  getDomainStatus,
  removeDomainFromProject,
  getVercelDomainsConfig,
  reportCustomDomainOutcome,
  ROUTING_UNAVAILABLE_TENANT_NOTE,
  type DnsRecordInstruction,
  type VercelVerificationChallenge,
  type VercelDomainResult,
  type DnsProviderGuide,
  type DnsProbe,
  type CustomDomainStatus,
  type CustomDomainSignal,
} from "@/lib/platform/custom-domains"

// TENANT ADMIN GATE — DERIVED from the roster by named subtraction (CLAUDE.md §4:
// never retype a role list). A connected domain is brokerage-level configuration
// with a real per-tenant operating cost (see tierAllowsCustomDomains), so the class
// is the brokerage-books one: the roster minus team_lead (a team is a mini brokerage,
// but the domain is the brokerage's) and minus compliance_officer (reads, never
// configures). Same membership the old literal had; now it cannot drift from the
// roster. TOMBSTONE (wave 141G): the four-name literal that stood here is gone —
// survivor lib/auth/resolve-user-role.ts BROKERAGE_FINANCE_ADMIN_USER_TYPES.
const ADMIN_TYPES: ReadonlySet<string> = BROKERAGE_FINANCE_ADMIN_USER_TYPES
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
 * operating cost rather than a code gate: each active domain is an attachment
 * to the routing project, a DNS/verification loop to support and a certificate
 * to keep issued — and DOMAIN_CAP below means up to two per tenant. Opening it
 * to solo/team multiplies that by the number of tenants on the cheapest plans.
 * It ships open because the owner ruled it open; the cost is reported so it can
 * be PRICED rather than silently absorbed.
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
  userType: string
  brokerageId: string
  tier: string | null
  siteSlug: string | null
}

async function requireBrokerageAdmin(): Promise<AdminGate | { ok: false; error: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return { ok: false, error: "Forbidden — brokerage admin only" }
  const svc = createServiceClient()
  const { data: brk } = await svc
    .from("brokerages").select("plan_tier, slug")
    .eq("id", ctx.brokerageId).maybeSingle()
  return {
    ok: true,
    userId: ctx.userId,
    userType: ctx.userType,
    brokerageId: ctx.brokerageId,
    tier: (brk as any)?.plan_tier ?? null,
    siteSlug: (brk as any)?.slug ?? null,
  }
}

const ENTITLEMENT_ERROR =
  "Your subscription doesn't allow changes right now — your website stays live at its platform address."

/** ENTITLEMENT (LAW 2, mayUseAndAfford): a lapsed / blocked tenant changes nothing. */
async function tenantMayChangeDomains(gate: AdminGate): Promise<boolean> {
  const d = await mayUseAndAfford({ brokerageId: gate.brokerageId, capability: "app.access", actor: { userType: gate.userType } })
  return d.allowed
}

async function audit(svc: any, userId: string, action: string, entityId: string, after: Record<string, unknown>) {
  try {
    await sentinelWrite(svc, svc.from("audit_log").insert({
      user_id: userId,
      action,
      entity_type: "tenant_custom_domain",
      entity_id: entityId,
      before: null,
      after,
    }), { table: "audit_log", flow: "custom_domain_audit", reason: "audit echo of a custom-domain action that already completed" })
  } catch {
    /* audit is best-effort — never fail the user action on a log write */
  }
}

// ── LAW 5 — every routing-layer call leaves a ledger row ─────────────────────

type RoutingCall = { value: VercelDomainResult | null; ok: boolean; outcome: string; error?: string | null; notRun?: RoutingNotRun }

/** Why the routing layer was NOT asked: the ledger answered with a non-acting claim (wave 147, lane 147F). */
type RoutingNotRun = { kind: NonActingClaim["kind"]; error: string | null }

/**
 * The attach / verify / detach calls to the routing layer are consequential (they change
 * what the platform serves on a host the tenant owns) — claim → act → settle on
 * agent_action_ledger with the human who clicked, the row, the reason and the outcome.
 * Provider cost is the platform's (an internal ledger fact; the tenant is never told the
 * provider).
 *
 * WAVE 147 (lane 147F, ruling 11) — THE REFUSAL USED TO READ AS "ROUTING UNAVAILABLE". The
 * replay hook answered every non-acting claim with `{ value: null, ok: true }`, and the caller
 * turned `null` into the `routing_unavailable` signal: a REFUSED claim (the routing layer was
 * never asked) then stored `registered_with_vercel: true` and returned success. The result now
 * carries `notRun` (replay | in_flight | unknown | refused, with the ledger's error) and every
 * caller decides on it explicitly — a refusal is reported, never dressed up as a run.
 */
async function ledgeredRoutingCall(
  ctx: { brokerageId: string; userId: string; action: "tenant.custom_domain.attach" | "tenant.custom_domain.verify" | "tenant.custom_domain.detach"; rowId: string; idempotencyKey: string; detail: Record<string, unknown> },
  run: () => Promise<RoutingCall>,
): Promise<{ value: VercelDomainResult | null; notRun: RoutingNotRun | null }> {
  const res = await withActionLedger<RoutingCall>(
    {
      brokerageId: ctx.brokerageId,
      action: ctx.action,
      actor: { type: "user", userId: ctx.userId },
      subject: { type: "tenant_custom_domain", id: ctx.rowId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: "tenant admin connects, verifies or detaches a domain the tenant owns",
      idempotencyKey: ctx.idempotencyKey,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "custom-domains",
      detail: ctx.detail,
    },
    run,
    {
      settle: (r): Settlement => r.ok
        ? { status: "executed", outcome: r.outcome, provider: "vercel", costUsd: 0 }
        : { status: "failed", outcome: r.outcome, provider: "vercel", costUsd: 0, error: r.error ?? null },
      replay: (claim) => ({ value: null, ok: false, outcome: claim.kind, notRun: { kind: claim.kind, error: claim.kind === "refused" ? claim.error : null } }),
    },
  )
  return { value: res.value, notRun: res.notRun ?? null }
}

/** The tenant-facing sentence for a routing step the ledger did not let run. Never claims the step happened. */
function routingNotRunMessage(step: "connect" | "check", n: RoutingNotRun): string {
  if (n.kind === "in_flight") return `This domain's ${step === "connect" ? "connection" : "check"} is already running — refresh in a moment.`
  if (n.kind === "unknown") return `An earlier ${step === "connect" ? "connection" : "check"} attempt ended in an unknown state — run Check status before trying again.`
  return step === "connect"
    ? "The domain was saved, but its routing step could not be recorded, so it was not attempted — run Check status to finish connecting it."
    : "The check could not be recorded, so it was not run — nothing changed. Try again."
}

/** The routing layer's answer → the state-machine signal + what to store. */
function signalFor(step: "attach" | "check", r: VercelDomainResult | null): { signal: CustomDomainSignal; challenges: VercelVerificationChallenge[] | null; errorCode: string | null; errorDetail: string | null } {
  if (!r || !r.configured) return { signal: "routing_unavailable", challenges: null, errorCode: null, errorDetail: null }
  if (r.ok) {
    return {
      signal: step === "attach" ? (r.verified ? "attach_ok_verified" : "attach_ok_unverified") : (r.verified ? "check_verified" : "check_unverified"),
      challenges: r.challenges, errorCode: null, errorDetail: null,
    }
  }
  return { signal: step === "attach" ? "attach_failed" : "check_failed", challenges: null, errorCode: r.errorCode, errorDetail: r.error }
}

// ── IMMEDIATE POST-CONDITION (wave 141, lane B's rule) ───────────────────────

/**
 * After a connect / verify / detach the row is RE-READ under its tenant and must sit in a
 * status the step admits. A refused read, a vanished row or a foreign status is a FAILED
 * post-condition: the action reports it and never success. (CLAUDE.md §3: a write that
 * resolves is not a write that landed.)
 */
async function confirmDomainRowPostCondition(
  svc: any, brokerageId: string, id: string, admitted: ReadonlySet<string>,
): Promise<{ ok: true; row: any } | { ok: false; error: string }> {
  const { data, error } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: "The domain's saved state could not be confirmed — it is not connected yet. Try again." }
  if (!data) return { ok: false, error: "The domain was not saved — nothing is connected. Try again." }
  const status = String((data as any).status)
  if (!admitted.has(status)) {
    return { ok: false, error: `The domain landed in an unexpected state (${status}) — nothing is live. Run Check status, or remove and re-add it.` }
  }
  return { ok: true, row: data }
}

// ── View types ───────────────────────────────────────────────────────────────

interface CustomDomainDnsFeedback {
  /** false = the lookup could not run (fail closed), not "no record". */
  checked: boolean
  matches: boolean
  reason: string
  checkedAt: string
}

export interface CustomDomainView {
  id: string
  domain: string
  status: string
  /** Vercel's standard DNS targets for this host (always shown). */
  dnsRecords: DnsRecordInstruction[]
  /** Extra challenge records the routing layer asked for (live mode only). */
  challenges: VercelVerificationChallenge[]
  /** Tenant-safe sentence for the row's state — never the routing layer's raw message. */
  tenantMessage: string
  /** The last IMMEDIATE DNS probe (feedback, never the verdict); null when none ran yet. */
  dns: CustomDomainDnsFeedback | null
  /** Console-specific instructions for every supported DNS provider (same values, different consoles). */
  providerGuides: DnsProviderGuide[]
  verifiedAt: string | null
  lastCheckedAt: string | null
  createdAt: string | null
  /** users.id of whoever added this domain — tenant_custom_domains.added_by. */
  addedBy: string | null
}

export interface CustomDomainsPanel {
  tierAllowed: boolean
  tierLabel: string
  canManage: boolean
  /** CAPABILITY STATUS ONLY (wave 141 ruling): can the platform attach + verify a domain automatically right now. */
  routingAvailable: boolean
  /** Tenant-safe note when routing is unavailable; null otherwise. */
  routingNote: string | null
  cap: number
  siteSlug: string | null
  domains: CustomDomainView[]
}

function dnsFeedback(probe: DnsProbe): CustomDomainDnsFeedback {
  return { checked: probe.checked, matches: probe.matches, reason: probe.reason, checkedAt: probe.checkedAt }
}

function rowToView(row: any): CustomDomainView {
  const verification = (row.verification ?? {}) as { challenges?: unknown; error_code?: unknown; dns?: unknown }
  const challenges = Array.isArray(verification.challenges)
    ? (verification.challenges as VercelVerificationChallenge[])
    : []
  const dnsRaw = verification.dns && typeof verification.dns === "object" ? (verification.dns as Record<string, unknown>) : null
  const dns: CustomDomainDnsFeedback | null = dnsRaw
    ? { checked: dnsRaw.checked === true, matches: dnsRaw.matches === true, reason: String(dnsRaw.reason ?? ""), checkedAt: String(dnsRaw.checkedAt ?? "") }
    : null
  const domain = String(row.domain)
  const status = String(row.status)
  return {
    id: String(row.id),
    domain,
    status,
    dnsRecords: dnsInstructionsFor(domain),
    challenges,
    tenantMessage: tenantFacingDomainMessage(status, typeof verification.error_code === "string" ? verification.error_code : null),
    dns,
    providerGuides: DNS_PROVIDERS.map((p) => dnsProviderGuide(p, domain)),
    verifiedAt: row.verified_at ?? null,
    lastCheckedAt: row.last_checked_at ?? null,
    createdAt: row.created_at ?? null,
    addedBy: row.added_by ?? null,
  }
}

const ROW_COLUMNS = "id, brokerage_id, domain, status, verification, error_detail, created_at, verified_at, last_checked_at, added_by"

// ── READ: the settings-card panel ────────────────────────────────────────────

export async function getCustomDomainsPanel(): Promise<
  { ok: true; panel: CustomDomainsPanel } | { ok: false; error: string }
> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()

  const [{ data: brk }, { data: rows }] = await Promise.all([
    svc.from("brokerages").select("plan_tier, slug").eq("id", ctx.brokerageId).maybeSingle(),
    svc.from("tenant_custom_domains").select(ROW_COLUMNS)
      .eq("brokerage_id", ctx.brokerageId).neq("status", "removed")
      .order("created_at", { ascending: true }),
  ])

  const tier = (brk as any)?.plan_tier ?? null
  const routing = getVercelDomainsConfig().configured
  return {
    ok: true,
    panel: {
      tierAllowed: tierAllowsCustomDomains(tier),
      tierLabel: isCanonicalTier(tier) ? TIER_LABELS[tier] : "your current",
      canManage: ADMIN_TYPES.has(ctx.userType ?? ""),
      routingAvailable: routing,
      routingNote: routing ? null : ROUTING_UNAVAILABLE_TENANT_NOTE,
      cap: DOMAIN_CAP,
      siteSlug: (brk as any)?.slug ?? null,
      domains: ((rows ?? []) as any[]).map(rowToView),
    },
  }
}

// ── ADD (connect a domain the tenant owns) ───────────────────────────────────

export async function addCustomDomainAction(rawDomain: string): Promise<
  { ok: true; domain: CustomDomainView } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate
  if (!tierAllowsCustomDomains(gate.tier)) return { ok: false, error: TIER_GATE_ERROR }
  if (!gate.siteSlug) {
    return { ok: false, error: "Your brokerage has no site slug yet — save your branding first so your website is live." }
  }
  if (!(await tenantMayChangeDomains(gate))) return { ok: false, error: ENTITLEMENT_ERROR }

  const validated = validateCustomDomain(rawDomain, platformReservedHosts())
  if (!validated.ok) return { ok: false, error: validated.error }
  const domain = validated.domain

  const svc = createServiceClient()
  const nowIso = new Date().toISOString()

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

  // connect_requested_at: the idempotency anchor for THIS connect (a revived row is a new connect).
  let row: any
  if (existing) {
    const { data, error } = await svc.from("tenant_custom_domains")
      .update({
        status: nextCustomDomainStatus("removed", "revive"),
        verification: { challenges: [], connect_requested_at: nowIso },
        error_detail: null,
        verified_at: null,
        last_checked_at: null,
        added_by: gate.userId,
      })
      .eq("id", (existing as any).id).eq("brokerage_id", gate.brokerageId)
      .select(ROW_COLUMNS).single()
    if (error) return { ok: false, error: "The domain could not be saved — nothing is connected. Try again." }
    row = data
  } else {
    const { data, error } = await svc.from("tenant_custom_domains")
      .insert({
        brokerage_id: gate.brokerageId,
        domain,
        status: "pending_dns",
        verification: { challenges: [], connect_requested_at: nowIso },
        added_by: gate.userId,
      })
      .select(ROW_COLUMNS).single()
    if (error) {
      if ((error as any).code === "23505") {
        return { ok: false, error: "That domain is already connected to another workspace." }
      }
      return { ok: false, error: "The domain could not be saved — nothing is connected. Try again." }
    }
    row = data
  }
  const rowId = String(row.id)

  // IMMEDIATE DNS FEEDBACK — free, read-only, no provider egress. Right after adding, "no
  // record yet" is the expected answer and the reason says so.
  const probe = await probeDomainDns(domain)

  // Attach to the routing project when routing is available (ledgered, LAW 5). Rows stay
  // 'pending_dns' until a verified signal — the state machine is the only promoter.
  const routing = getVercelDomainsConfig().configured
  let attach: VercelDomainResult | null = null
  if (routing) {
    const call = await ledgeredRoutingCall(
      { brokerageId: gate.brokerageId, userId: gate.userId, action: "tenant.custom_domain.attach", rowId, idempotencyKey: `custom_domain.attach:${rowId}:${nowIso}`, detail: { domain, dns_checked: probe.checked, dns_matches: probe.matches } },
      async () => {
        const r = await addDomainToProject(domain)
        return { value: r, ok: r.configured && r.ok, outcome: !r.configured ? "routing_unavailable" : r.ok ? (r.verified ? "attached_verified" : "attached") : (r.errorCode ?? "refused"), error: r.configured && !r.ok ? r.error : null }
      },
    )
    if (call.notRun) {
      // THIS connect cycle was already attached (a duplicate of the same request): the row is left exactly as the
      // first run wrote it and re-read under its tenant. Anything else (refused / in flight / unknown) did NOT ask
      // the routing layer — the row stays pending_dns with nothing claimed about the routing layer (wave 147F).
      if (call.notRun.kind !== "replay") return { ok: false, error: routingNotRunMessage("connect", call.notRun) }
      const replayed = await confirmDomainRowPostCondition(svc, gate.brokerageId, rowId, CONNECT_POST_CONDITION_STATUSES)
      if (!replayed.ok) return replayed
      return { ok: true, domain: rowToView(replayed.row) }
    }
    attach = call.value
  }
  const s = signalFor("attach", attach)
  const nextStatus = nextCustomDomainStatus("pending_dns", s.signal)
  const patch: Record<string, unknown> = {
    status: nextStatus,
    verification: {
      ...((row.verification ?? {}) as Record<string, unknown>),
      challenges: s.challenges ?? [],
      registered_with_vercel: routing && s.signal !== "attach_failed",
      error_code: s.errorCode,
      dns: dnsFeedback(probe),
    },
    error_detail: s.errorDetail,
    last_checked_at: nowIso,
    ...(nextStatus === "active" ? { verified_at: nowIso } : {}),
  }
  const { error: patchErr } = await svc.from("tenant_custom_domains")
    .update(patch).eq("id", rowId).eq("brokerage_id", gate.brokerageId).select("id")
  if (patchErr) {
    return { ok: false, error: "The domain was saved but its routing result was not — run Check status to finish connecting it." }
  }

  // IMMEDIATE POST-CONDITION: the row, re-read under this tenant, in a state a connect admits.
  const post = await confirmDomainRowPostCondition(svc, gate.brokerageId, rowId, CONNECT_POST_CONDITION_STATUSES)
  if (!post.ok) return post
  row = post.row
  const status = String(row.status) as CustomDomainStatus

  // EVENTS — connected (post-condition passed), then verified / error as the result says.
  await reportCustomDomainOutcome({
    brokerageId: gate.brokerageId, domainRowId: rowId, domain,
    outcome: "connected", phase: "add", status, dns: probe, actorUserId: gate.userId, client: svc,
  })
  if (s.signal === "attach_failed") {
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: rowId, domain,
      outcome: "error", phase: "add", status, errorCode: s.errorCode, errorDetail: s.errorDetail,
      actorUserId: gate.userId, client: svc,
    })
  } else if (status === "active") {
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: rowId, domain,
      outcome: "verified", phase: "add", status, dns: probe, actorUserId: gate.userId, client: svc,
    })
  }

  await audit(svc, gate.userId, "custom_domain_added", rowId, {
    brokerage_id: gate.brokerageId,
    domain,
    status,
    routing_available: routing,
    dns_matches: probe.matches,
  })
  revalidatePath("/settings/branding")
  return { ok: true, domain: rowToView(row) }
}

// ── CHECK STATUS (verify) ────────────────────────────────────────────────────

export async function checkCustomDomainStatusAction(id: string): Promise<
  { ok: true; domain: CustomDomainView; routingAvailable: boolean } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate

  const svc = createServiceClient()
  const { data: existing, error: readErr } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("id", id).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: "The domain could not be read right now — try again." }
  if (!existing) return { ok: false, error: "Domain not found" }
  const current = String((existing as any).status) as CustomDomainStatus
  if (current === "removed") return { ok: false, error: "Domain was removed" }
  const domain = String((existing as any).domain)
  const nowIso = new Date().toISOString()

  // IMMEDIATE DNS FEEDBACK on every check — the tenant learns whether the record is visible
  // even when routing is unavailable (where only this feedback moves; the status never does).
  const probe = await probeDomainDns(domain)

  const routing = getVercelDomainsConfig().configured
  let result: VercelDomainResult | null = null
  if (routing) {
    // The cycle is ONE check (nowIso): a later "Check status" is a new, legitimate read of the routing layer, so it
    // must run — only the same request arriving twice in the same instant replays. Deliberate, not an oversight.
    const call = await ledgeredRoutingCall(
      { brokerageId: gate.brokerageId, userId: gate.userId, action: "tenant.custom_domain.verify", rowId: id, idempotencyKey: `custom_domain.verify:${id}:${nowIso}`, detail: { domain, from_status: current, dns_checked: probe.checked, dns_matches: probe.matches } },
      async () => {
        let r = await getDomainStatus(domain)
        // Drift heal: registered here but missing on the project (e.g. detached in the
        // routing dashboard) — re-attach once, then report that result.
        if (r.configured && !r.ok && r.errorCode === "not_found") r = await addDomainToProject(domain)
        return { value: r, ok: r.configured && r.ok, outcome: !r.configured ? "routing_unavailable" : r.ok ? (r.verified ? "verified" : "unverified") : (r.errorCode ?? "refused"), error: r.configured && !r.ok ? r.error : null }
      },
    )
    if (call.notRun) {
      // Nothing was asked of the routing layer, so nothing is learned and the row is NOT patched (the previous code
      // patched it as "routing unavailable" and claimed registered_with_vercel) — wave 147F.
      if (call.notRun.kind !== "replay") return { ok: false, error: routingNotRunMessage("check", call.notRun) }
      return { ok: true, domain: rowToView(existing), routingAvailable: routing }
    }
    result = call.value
  }
  const s = signalFor("check", result)
  const nextStatus = nextCustomDomainStatus(current, s.signal)
  const prior = ((existing as any).verification ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {
    status: nextStatus,
    verification: {
      ...prior,
      challenges: s.challenges ?? (Array.isArray(prior.challenges) ? prior.challenges : []),
      registered_with_vercel: s.signal === "check_failed" ? prior.registered_with_vercel === true : (routing || prior.registered_with_vercel === true),
      error_code: s.errorCode,
      dns: dnsFeedback(probe),
    },
    error_detail: s.errorDetail,
    last_checked_at: nowIso,
    ...(nextStatus === "active" ? { verified_at: (existing as any).verified_at ?? nowIso } : {}),
  }
  const { error: upErr } = await svc.from("tenant_custom_domains")
    .update(patch).eq("id", id).eq("brokerage_id", gate.brokerageId).select("id")
  if (upErr) return { ok: false, error: "The check ran but its result could not be saved — try again." }

  // IMMEDIATE POST-CONDITION: the row is in exactly the state the machine chose.
  const post = await confirmDomainRowPostCondition(svc, gate.brokerageId, id, new Set([nextStatus]))
  if (!post.ok) return post

  if (nextStatus === "active" && current !== "active") {
    await audit(svc, gate.userId, "custom_domain_verified", id, { brokerage_id: gate.brokerageId, domain })
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain,
      outcome: "verified", phase: "verify", status: nextStatus, dns: probe, actorUserId: gate.userId, client: svc,
    })
  } else if (nextStatus === "error") {
    // Verification hit an error — feed alert for the human + self-heal ledger + kernel event.
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain,
      outcome: "error", phase: "verify", status: nextStatus,
      errorCode: s.errorCode, errorDetail: s.errorDetail, dns: probe, actorUserId: gate.userId, client: svc,
    })
  }
  revalidatePath("/settings/branding")
  return { ok: true, domain: rowToView(post.row), routingAvailable: routing }
}

// ── REMOVE (detach) ──────────────────────────────────────────────────────────

export async function removeCustomDomainAction(id: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const gate = await requireBrokerageAdmin()
  if (!gate.ok) return gate
  if (!(await tenantMayChangeDomains(gate))) return { ok: false, error: ENTITLEMENT_ERROR }

  const svc = createServiceClient()
  const { data: existing, error: readErr } = await svc.from("tenant_custom_domains")
    .select(ROW_COLUMNS).eq("id", id).eq("brokerage_id", gate.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: "The domain could not be read right now — try again." }
  if (!existing) return { ok: false, error: "Domain not found" }
  const current = String((existing as any).status) as CustomDomainStatus
  const domain = String((existing as any).domain)
  const connectKey = String(((existing as any).verification ?? {}).connect_requested_at ?? (existing as any).created_at ?? "")

  // Routing detach is best-effort and ledgered — the row goes to 'removed' either way so
  // the middleware stops serving the host immediately.
  const detach = await withActionLedger<{ configured: boolean; ok: boolean; error: string | null }>(
    {
      brokerageId: gate.brokerageId,
      action: "tenant.custom_domain.detach",
      actor: { type: "user", userId: gate.userId },
      subject: { type: "tenant_custom_domain", id },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: "tenant admin detaches a domain the tenant owns",
      idempotencyKey: `custom_domain.detach:${id}:${connectKey}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "custom-domains",
      detail: { domain, from_status: current },
    },
    () => removeDomainFromProject(domain),
    {
      settle: (r): Settlement => r.ok
        ? { status: "executed", outcome: r.configured ? "detached" : "routing_unavailable", provider: "vercel", costUsd: 0 }
        : { status: "failed", outcome: "detach_refused", provider: "vercel", costUsd: 0, error: r.error },
      // WAVE 147 (lane 147F): every non-acting claim used to answer `{ ok: true }`, so a REFUSED detach (the routing
      // layer never asked) was audited `routing_detached: true` and the row carried no error — while the host stayed
      // attached to the routing project. Only a genuine replay (this connect cycle was already detached) is a success;
      // the row still goes to 'removed' in every case (the middleware stops serving the host), and a not-run detach is
      // recorded as one: `error_detail` names it and the error outcome is reported.
      replay: (claim) => claim.kind === "replay"
        ? { configured: true, ok: true, error: null }
        : { configured: true, ok: false, error: claim.kind === "refused"
            ? `the action ledger refused the detach, so the routing layer was not asked (${claim.error})`
            : `an earlier detach attempt is ${claim.kind === "in_flight" ? "still in flight" : "in an unknown state"} — the routing layer was not asked again` },
    },
  )
  if (detach.configured && !detach.ok) {
    // Ledger the API failure (no feed line — the row is removed regardless).
    await reportCustomDomainOutcome({
      brokerageId: gate.brokerageId, domainRowId: id, domain,
      outcome: "error", phase: "remove", status: "removed", errorDetail: detach.error, announce: false, actorUserId: gate.userId, client: svc,
    })
  }

  // The update is COUNTED (CLAUDE.md §3): a tenant predicate that matches nothing resolves too.
  const { data: removedRows, error } = await svc.from("tenant_custom_domains")
    .update({
      status: nextCustomDomainStatus(current, "remove"),
      error_detail: detach.ok ? null : `Removed locally; routing detach failed: ${detach.error}`,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", id).eq("brokerage_id", gate.brokerageId)
    .select("id")
  if (error) return { ok: false, error: "The domain could not be removed right now — try again." }
  if ((removedRows ?? []).length === 0) return { ok: false, error: "Domain not found" }

  await audit(svc, gate.userId, "custom_domain_removed", id, {
    brokerage_id: gate.brokerageId,
    domain,
    routing_detached: detach.ok,
  })
  revalidatePath("/settings/branding")
  return { ok: true }
}
