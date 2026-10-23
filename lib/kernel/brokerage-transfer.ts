// lib/kernel/brokerage-transfer.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE EXPLICIT TRANSFER RAIL — INDEPENDENT SUBSCRIBER → BROKERAGE LOCATION
// (wave 141, lane 141A). Owner, 2026-10-14 (verbatim): "Later adoption by the
// ACTUAL brokerage location = a deliberate relationship transfer: identify the
// exact brokerage/location → explicit agent/team permission → verify → migrate
// membership/data through canonical services → preserve history/evidence → stop
// individual billing at the right effective time → Stripe proration → no double
// billing → brokerage owns the seat/platform relationship … Migration:
// idempotent, cannot cross to the wrong brokerage/location, invoices immutable,
// no lost paid period, no fabricated refund, provenance of contacts/
// transactions/websites/campaigns/assets preserved."
//
// SURVIVORS AUDITED AT 01a71c3c2 — none did this, each is REUSED here:
//   · lib/kernel/users.ts assignUserToBrokerage (users + agents + grants move),
//     assignUserRoleAndEntitlements (user_type + the target grant),
//     createOrRepairUserDomainRecords (tier-aware domain rows in the target) —
//     the canonical membership services; this rail never writes users.brokerage_id.
//   · lib/agents/agent-books.ts / agent-deactivation.ts — the AGENT → AGENT
//     book move inside one tenant (contacts, leads, deal roles, tasks, listings,
//     calendar, alerts). Its move SET names the families a book is made of;
//     TRANSFER_DATA_FAMILIES below is that set widened to the owner's list
//     (campaigns, assets, documents) — every entry carries brokerage_id (the
//     proof derives it from scripts/schema-snapshot.ts + live-tables.ts).
//   · lib/kernel/tenant-creation.ts — the resumable step RECORD pattern
//     (status per step, re-run only what did not finish, one ledger row per
//     attempt) is copied, not re-invented.
//   · lib/billing/subscriber-billing-handoff.ts — the ONE billing call; the
//     Stripe side is lane 141H's behind that contract.
//   · brokerages.status 'archived' + archived_at (live, readerful, WRITERLESS
//     until now) — the archive step is their first writer. Archived, never deleted.
//   · lib/kernel/tenant-readiness.ts evaluateTenantReadiness — the verdict on
//     the target after the move.
//
// IDENTITY (lib/kernel/brokerage-identity.ts): every id on a request is CANONICAL —
// the target is the initiator's SESSION tenant, the source is resolved from the
// subject's account email (users.email → users.brokerage_id), the subject must
// be that tenant's owner. A brokerage NAME never selects anything here.
//
// CANNOT CROSS TO ANOTHER TENANT: every data update is pinned
// `.eq("brokerage_id", source)` and sets brokerage_id to the REQUEST ROW's target
// (never a caller value); the request row itself pins brokerage_id = target
// (m765 CHECK); a request can only be consented by its subject, cancelled or
// retried by its target's admins. A same-name third tenant is never read.
//
// EVIDENCE (LAW 5): one agent_action_ledger row per request / consent / cancel /
// migration ATTEMPT (withActionLedger), the request row's jsonb stages (consent,
// verification, migration steps with counts, billing handoff, readiness), and
// kernel events (audit rows with lineage). HUMANS through registered managers
// only (TRANSFER_HUMAN_ROUTES): the Recruiting Manager carries the roster side
// (consent asked / recorded, completion), the Data Steward a verification or
// data-move failure and a not-ready target, the Finance Manager a pending
// billing handoff. No superadmin fallback, no invented manager.
//
// IMMEDIATE (wave 141): consent → verify → migrate → post-condition → event →
// human, in the consent call itself. A stalled migration is resumable
// (runBrokerageTransferMigration again — a tenant-admin retry door); nothing
// waits for a cron. A second run of a completed transfer changes nothing.

import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { TenantReadinessVerdict } from "@/lib/kernel/tenant-creation"
import type { SubscriberBillingHandoffInput, SubscriberBillingHandoffResult } from "@/lib/billing/subscriber-billing-handoff"
import type { UserDomainRole, UserProvisioningParams, ProvisioningResult } from "@/lib/kernel/users"
import type { SeatGateVerdict } from "@/lib/kernel/seat-usage"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { isIndependentSubscriberTier } from "@/lib/kernel/brokerage-identity"

// ── Vocabulary (ONE spelling; m765 CHECKs mirror these) ───────────────────────

export const TRANSFER_STATUSES = ["requested", "consented", "migrating", "completed", "declined", "cancelled", "failed"] as const
export type TransferStatus = (typeof TRANSFER_STATUSES)[number]
export const OPEN_TRANSFER_STATUSES: readonly TransferStatus[] = ["requested", "consented", "migrating"]

/** The seat an adopted owner takes — a producing role, never an admin role by adoption. */
export const TRANSFER_TARGET_ROLES = ["agent", "team_lead"] as const
export type TransferTargetRole = (typeof TRANSFER_TARGET_ROLES)[number]

export const TRANSFER_MIGRATION_STEPS = ["verification", "membership", "data", "billing_handoff", "archive_source", "target_readiness"] as const
export type TransferStep = (typeof TRANSFER_MIGRATION_STEPS)[number]

/** The tenant-stewarded families an independent subscriber's business is made of — each carries
 *  brokerage_id and moves AS A WHOLE (the solo/team tenant's rows are all the adopted agent/team's).
 *  Deliberately NOT here (they stay with the archived tenant, readable by platform staff — history
 *  and evidence are preserved, money never crosses tenants): subscriptions, billing_invoices,
 *  ai_tool_usage, vendor_usage_tracking, agent_action_ledger, lifecycle_events, notifications,
 *  brokerage_settings / policies / entitlements / feature flags / managed_agents, commission_*,
 *  agent_book_transfers, user_invitations. */
export const TRANSFER_DATA_FAMILIES: readonly { table: string; what: string }[] = [
  { table: "contacts", what: "the book — contacts (agents see contacts; §5)" },
  { table: "leads", what: "unconverted leads the tenant owned" },
  { table: "transactions", what: "deals, with their agent role columns intact" },
  { table: "transaction_tasks", what: "deal checklists" },
  { table: "listings", what: "listings" },
  { table: "listing_media", what: "listing photos / media" },
  { table: "offers", what: "offers on those listings / for those buyers" },
  { table: "contract_term_versions", what: "the executed-terms record of those offers (wave 143, m797 — a child of offers / transactions; follows its parent)" },
  { table: "outside_offer_messages", what: "the outside-agent email loop on those offers (wave 143, m798 — a child of offers; follows its parent)" },
  { table: "showings", what: "showings" },
  { table: "tasks", what: "open work" },
  { table: "calendar_events", what: "appointments" },
  { table: "property_alerts", what: "buyer alerts" },
  { table: "activities", what: "activity timeline rows" },
  { table: "contact_notes", what: "notes on contacts" },
  { table: "contact_memory", what: "conversation memory facts per contact" },
  { table: "documents", what: "deal / listing documents" },
  { table: "client_documents", what: "client-visible documents" },
  { table: "marketing_campaigns", what: "campaigns" },
  { table: "campaign_sequences", what: "sequences (the one delivery engine)" },
  { table: "sequence_enrollments", what: "enrollments in those sequences" },
  { table: "marketing_attribution_credits", what: "attribution credits (the ROI ledger's rows)" },
  { table: "email_campaigns", what: "email campaigns" },
  { table: "marketing_assets", what: "the media library (lineage intact)" },
  { table: "ai_video_projects", what: "video projects" },
  { table: "video_assets", what: "rendered videos" },
  { table: "blog_posts", what: "the website's blog" },
  // THE WEBSITE'S LANDING PAGES (wave 143G; owner: "landing pages live inside the tenant website"; wave 141 owner list:
  // "provenance of … websites … preserved"). The page keeps its slug, so every printed QR / sent link / live ad still
  // resolves — but its brokerage_id decides which tenant a visitor's submission is filed under. Left behind, a
  // transferred agent's landing page would keep capturing leads into the ARCHIVED source tenant, where nobody reads
  // them. The two tables that FK to the page (form_id -> lead_capture_forms) move WITH it: a submission left in the
  // source would reference a form that lives in another tenant.
  { table: "lead_capture_forms", what: "the website's landing pages / lead magnets (slug, copy and URL unchanged)" },
  { table: "form_submissions", what: "the capture history of those landing pages (form_id stays in ONE tenant)" },
  { table: "ai_search_landing_citation_observations", what: "AI-search citation history of those landing pages (form_id stays in ONE tenant)" },
  { table: "farm_territories", what: "farm territories served" },
  { table: "relationship_edges", what: "the knowledge graph edges" },
]

export type TransferHumanTouchpoint = "consent_requested" | "consent_recorded" | "declined" | "verification_failed" | "data_move_failed" | "billing_pending" | "target_not_ready" | "completed"

/** HUMANS THROUGH REGISTERED MANAGERS ONLY (owner, wave 141). Every value is a MANAGERS key. */
export const TRANSFER_HUMAN_ROUTES: Readonly<Record<TransferHumanTouchpoint, ManagerKey>> = Object.freeze({
  consent_requested: "recruiting_manager",
  consent_recorded: "recruiting_manager",
  declined: "recruiting_manager",
  completed: "recruiting_manager",
  verification_failed: "data_steward",
  data_move_failed: "data_steward",
  target_not_ready: "data_steward",
  billing_pending: "finance_manager",
})

/** users.user_type values that are SEATS of the moving tenant (the operational admin roster spread,
 *  never restated — CLAUDE.md §4 — plus the producing / staff seat types). Contacts, vendors, the ISA
 *  system actor and platform staff never move. */
const MOVING_SEAT_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "agent", "tc"])

/** Target tenant states that may adopt. brokerages.status vocabulary: active | archived | cancelled | suspended. */
const ADOPTING_STATUSES: ReadonlySet<string> = new Set(["active"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Shapes ────────────────────────────────────────────────────────────────────

interface StepState { status: "done" | "failed" | "skipped"; at: string; detail?: string; error?: string }

export interface TransferMigrationRecord {
  version: 1
  attempts: number
  steps: Partial<Record<TransferStep, StepState>>
  /** Rows moved per family / members / teams — exact counts from the updates' returned ids. */
  counts: Record<string, number>
  last_error?: string | null
}

export interface TransferConsentEvidence {
  user_id: string
  at: string
  decision: "consent" | "decline"
  statement: string
  channel: string
  request_snapshot: { source_brokerage_id: string; target_brokerage_id: string; target_role: TransferTargetRole; source_name: string | null; target_name: string | null }
}

export interface TransferRequestRow {
  id: string
  brokerage_id: string
  source_brokerage_id: string
  target_brokerage_id: string
  subject_user_id: string
  initiated_by_user_id: string
  target_role: TransferTargetRole
  status: TransferStatus
  reason: string | null
  consent: TransferConsentEvidence | null
  verification: { at: string; ok: boolean; checks: Array<{ key: string; ok: boolean; detail: string }> } | null
  migration: TransferMigrationRecord | null
  billing_handoff: SubscriberBillingHandoffResult | null
  readiness: TenantReadinessVerdict | null
  effective_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

/** @proofSeam — production callers never pass this; scripts/brokerage-identity-guard.ts injects the
 *  env-bound services (the users.ts movers, the seat gate, entitlements, billing, readiness, the event
 *  bus, the notifiers) so the rail is proven in memory with every table write visible. */
export interface BrokerageTransferDeps {
  now?: () => Date
  assignUserToBrokerage?: (p: { userId: string; brokerageId: string; callerUserId: string }) => Promise<{ success: boolean; error?: string }>
  assignRole?: (p: { userId: string; newRole: UserDomainRole; brokerageId: string; teamId?: string | null; callerUserId: string }) => Promise<{ success: boolean; error?: string }>
  domainRecords?: (p: UserProvisioningParams) => Promise<ProvisioningResult>
  seatGate?: (svc: any, brokerageId: string, role: string, opts?: { subjectUserId?: string | null }) => Promise<Pick<SeatGateVerdict, "allowed" | "reason" | "message">>
  tierAllowsRole?: (tier: string | null | undefined, role: UserDomainRole) => boolean
  mayUseAndAfford?: (i: { brokerageId: string; capability: string; client?: any }) => Promise<{ allowed: boolean; reason: string }>
  billingHandoff?: (svc: any, input: SubscriberBillingHandoffInput) => Promise<SubscriberBillingHandoffResult>
  readiness?: (svc: any, brokerageId: string) => Promise<TenantReadinessVerdict>
  /** Wave 141B's immediate-operation reporter (lib/kernel/immediate-operations.ts reportOperationOutcome). */
  reportOutcome?: (svc: any, input: Record<string, unknown>) => Promise<unknown>
  emit?: (input: Record<string, unknown>) => Promise<unknown>
  notifyAdmins?: (svc: any, brokerageId: string, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
  notifyStaff?: (svc: any, n: { type: string; title: string; body: string; entityType?: string | null; entityId?: string | null; priority?: "low" | "medium" | "high" }) => Promise<number>
}

export interface TransferActor {
  userId: string
  /** The actor's SESSION tenant (never a request body) — checked against the request's side. */
  brokerageId: string
  kind: "target_admin" | "subject" | "system"
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** @proofSeam scripts/brokerage-identity-guard.ts asserts the step algebra directly. */
export function transferMigrationComplete(record: Pick<TransferMigrationRecord, "steps"> | null | undefined): boolean {
  if (!record) return false
  return TRANSFER_MIGRATION_STEPS.every((s) => { const st = record.steps[s]?.status; return st === "done" || st === "skipped" })
}

/** @proofSeam scripts/brokerage-identity-guard.ts asserts the pending set after a stalled step. */
export function transferStepsPending(record: Pick<TransferMigrationRecord, "steps"> | null | undefined): TransferStep[] {
  if (!record) return [...TRANSFER_MIGRATION_STEPS]
  return TRANSFER_MIGRATION_STEPS.filter((s) => { const st = record.steps[s]?.status; return st !== "done" && st !== "skipped" })
}

/** PURE: the seat a moving member takes in the target. The subject takes the requested role; an
 *  admin-class member of a team tenant becomes a producing agent (adoption never grants admin);
 *  producing / staff types keep their own. */
export function memberTargetRole(userType: string | null, isSubject: boolean, requested: TransferTargetRole): UserDomainRole {
  if (isSubject) return requested
  if (TENANT_ADMIN_USER_TYPES.has(String(userType ?? ""))) return "agent"
  return (userType === "tc" ? "tc" : "agent") as UserDomainRole
}

function nowIso(deps: BrokerageTransferDeps): string { return (deps.now ?? (() => new Date()))().toISOString() }

function managerLabel(key: ManagerKey): string {
  return key.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

// ── Row access (every write counted; CLAUDE.md §3) ─────────────────────────────

async function readRequest(svc: any, requestId: string): Promise<{ row: TransferRequestRow | null; error: string | null }> {
  const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("id", requestId).maybeSingle()
  if (error) return { row: null, error: error.message }
  return { row: (data ?? null) as TransferRequestRow | null, error: null }
}

async function patchRequest(svc: any, requestId: string, patch: Record<string, unknown>, deps: BrokerageTransferDeps): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.from("brokerage_transfer_requests").update({ ...patch, updated_at: nowIso(deps) }).eq("id", requestId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((data ?? []).length !== 1) return { ok: false, error: "transfer request row not matched" }
  return { ok: true }
}

async function readBrokerage(svc: any, id: string) {
  const { data, error } = await svc.from("brokerages").select("id, name, plan_tier, status, deleted_at, archived_at, ai_isa_system_user_id").eq("id", id).maybeSingle()
  if (error) return { row: null, error: error.message as string }
  return { row: (data ?? null) as { id: string; name: string | null; plan_tier: string | null; status: string | null; deleted_at: string | null; archived_at: string | null; ai_isa_system_user_id: string | null } | null, error: null }
}

async function emitTransferEvent(svc: any, deps: BrokerageTransferDeps, event: string, brokerageId: string, requestId: string, actorUserId: string | null, metadata: Record<string, unknown>) {
  try {
    const emit = deps.emit ?? (await import("@/lib/kernel/emit")).emitKernelEvent
    await emit({ event, brokerageId, entityType: "brokerage_transfer_request", entityId: requestId, actorUserId, auditOnly: true, metadata, client: svc })
  } catch (e) {
    console.warn(`[brokerage-transfer] event ${event} not recorded:`, (e as Error)?.message)
  }
}

/** A human, through the registered manager that owns the touchpoint — never a superadmin fallback. */
async function notifyHumans(svc: any, deps: BrokerageTransferDeps, touch: TransferHumanTouchpoint, req: Pick<TransferRequestRow, "id" | "brokerage_id" | "source_brokerage_id" | "subject_user_id">, body: string, opts: { targetAdmins?: boolean; staff?: boolean; subject?: boolean } = {}): Promise<{ admins: number; staff: number; subject: boolean }> {
  const manager = TRANSFER_HUMAN_ROUTES[touch]
  const title = `${managerLabel(manager)}: brokerage adoption — ${touch.replace(/_/g, " ")}`
  const out = { admins: 0, staff: 0, subject: false }
  if (opts.targetAdmins) {
    try {
      const notify = deps.notifyAdmins ?? (await import("@/lib/notifications/brokerage-admins")).notifyBrokerageAdmins
      out.admins = await notify(svc, req.brokerage_id, { type: `brokerage_transfer_${touch}`, title, body, entityType: "brokerage_transfer_request", entityId: req.id, priority: "high" })
    } catch (e) { console.warn("[brokerage-transfer] target admins not notified:", (e as Error)?.message) }
  }
  if (opts.staff) {
    try {
      const notify = deps.notifyStaff ?? (async (client: any, n: any) => (await import("@/lib/notifications/platform-staff")).notifyPlatformStaff(client as never, n))
      out.staff = await notify(svc, { type: `brokerage_transfer_${touch}`, title, body, entityType: "brokerage_transfer_request", entityId: req.id, priority: "high" })
    } catch (e) { console.warn("[brokerage-transfer] platform staff not notified:", (e as Error)?.message) }
  }
  if (opts.subject) {
    const { error } = await svc.from("notifications").insert({
      user_id: req.subject_user_id, brokerage_id: req.source_brokerage_id, type: `brokerage_transfer_${touch}`,
      title: title.slice(0, 200), body: body.slice(0, 480), entity_type: "brokerage_transfer_request", entity_id: req.id,
      priority: "high", channel: "in_app", is_read: false,
    })
    if (error) console.warn("[brokerage-transfer] subject bell refused:", error.message)
    out.subject = !error
  }
  return out
}

async function ledgered<T extends { ok: boolean; error?: string }>(svc: any, ctx: { brokerageId: string; action: string; actorUserId: string | null; subjectId: string; key: string; riskClass: "LOW_RISK_WRITE" | "FINANCIAL"; detail: Record<string, unknown> }, run: () => Promise<T>, onRefused: (why: string) => T): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>({
    brokerageId: ctx.brokerageId, action: ctx.action,
    actor: ctx.actorUserId ? { type: "user", userId: ctx.actorUserId } : { type: "system" },
    subject: { type: "brokerage_transfer_request", id: ctx.subjectId, ref: ctx.key },
    reasonCode: "SUBSCRIPTION_LIFECYCLE", idempotencyKey: ctx.key, riskClass: ctx.riskClass, systemSource: "brokerage_transfer", detail: ctx.detail,
  }, run, {
    settle: (r) => r.ok ? { status: "executed", outcome: ctx.action.split(".").pop() ?? "done", providerRef: ctx.subjectId, error: null } : { status: "failed", outcome: "refused", error: r.error ?? null },
    replay: (claim) => onRefused(claim.kind === "refused" ? claim.error : claim.kind),
  }, { client: svc })
}

// ── 1. REQUEST (the target brokerage admin, from their session tenant) ────────

export interface RequestBrokerageTransferInput {
  /** The initiator's SESSION tenant — the adopting brokerage / location / team. */
  targetBrokerageId: string
  initiatedByUserId: string
  /** The adopted owner's ACCOUNT email — the identity key; never a brokerage name. */
  subjectEmail: string
  targetRole: TransferTargetRole
  reason?: string | null
}

export type RequestBrokerageTransferResult =
  | { ok: true; request: TransferRequestRow; notified: { subject: boolean } }
  | { ok: false; error: string }

export async function requestBrokerageTransfer(svc: any, input: RequestBrokerageTransferInput, deps: BrokerageTransferDeps = {}): Promise<RequestBrokerageTransferResult> {
  const targetId = String(input.targetBrokerageId ?? "")
  if (!UUID_RE.test(targetId)) return { ok: false, error: "No adopting tenant — refused." }
  if (!(TRANSFER_TARGET_ROLES as readonly string[]).includes(input.targetRole)) return { ok: false, error: `The adopted owner's seat must be one of: ${TRANSFER_TARGET_ROLES.join(", ")}.` }
  const email = String(input.subjectEmail ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "The agent's account email is required — it is how the independent workspace is identified (never by brokerage name)." }

  const target = await readBrokerage(svc, targetId)
  if (target.error) return { ok: false, error: `Could not read your brokerage: ${target.error}` }
  if (!target.row || target.row.deleted_at) return { ok: false, error: "Your brokerage record could not be found." }
  if (!ADOPTING_STATUSES.has(String(target.row.status ?? ""))) return { ok: false, error: `Your brokerage is '${target.row.status}' — only an active brokerage can adopt a workspace.` }
  if (target.row.plan_tier === "solo_agent") return { ok: false, error: "A solo workspace cannot adopt another workspace — the adopting side must be a team, brokerage or multi-location tenant." }

  const { data: subjectRow, error: subjectErr } = await svc.from("users").select("id, email, brokerage_id, user_type, platform_role, first_name, last_name").eq("email", email).maybeSingle()
  if (subjectErr) return { ok: false, error: `Could not look the account up: ${subjectErr.message}` }
  const subject = subjectRow as { id: string; brokerage_id: string | null; user_type: string | null; platform_role: string | null; first_name: string | null; last_name: string | null } | null
  if (!subject) return { ok: false, error: "No account with that email — the agent must be an independent subscriber on the platform to be adopted." }
  if (subject.platform_role) return { ok: false, error: "That account is platform staff, not a subscriber." }
  const sourceId = subject.brokerage_id
  if (!sourceId) return { ok: false, error: "That account holds no workspace — invite them as a user instead (Settings → Users)." }
  if (sourceId === targetId) return { ok: false, error: "That account is already a member of your brokerage." }

  const source = await readBrokerage(svc, sourceId)
  if (source.error) return { ok: false, error: `Could not read the independent workspace: ${source.error}` }
  if (!source.row || source.row.deleted_at) return { ok: false, error: "The independent workspace could not be found." }
  if (source.row.archived_at || source.row.status === "archived") return { ok: false, error: "That workspace is already archived." }
  if (!isIndependentSubscriberTier(source.row.plan_tier)) return { ok: false, error: `That account belongs to a ${String(source.row.plan_tier ?? "").replace(/_/g, " ")} tenant, not an independent solo/team subscription — a brokerage's member cannot be adopted away; they must leave it first.` }
  if (!TENANT_ADMIN_USER_TYPES.has(String(subject.user_type ?? ""))) return { ok: false, error: "That account is not the owner of its workspace — only the independent workspace's owner can consent to a transfer." }

  // One open request per source tenant (the m765 partial unique index says the same).
  const { data: open, error: openErr } = await svc.from("brokerage_transfer_requests").select("id, brokerage_id, status").eq("source_brokerage_id", sourceId).in("status", [...OPEN_TRANSFER_STATUSES]).limit(1)
  if (openErr) return { ok: false, error: `Could not check for an open request: ${openErr.message}` }
  if ((open ?? []).length) {
    const o = (open as Array<{ brokerage_id: string; status: string }>)[0]
    return { ok: false, error: o.brokerage_id === targetId ? `A request for this workspace is already ${o.status}.` : "That workspace already has an open adoption request with another brokerage." }
  }

  const tierAllows = deps.tierAllowsRole ?? (await import("@/lib/kernel/tier-role-matrix")).tierAllowsRole
  if (!tierAllows(target.row.plan_tier, input.targetRole)) return { ok: false, error: `Your ${String(target.row.plan_tier ?? "").replace(/_/g, " ")} plan does not seat a ${input.targetRole.replace(/_/g, " ")}.` }
  const gate = deps.seatGate ?? (await import("@/lib/kernel/seat-usage")).seatGate
  const seat = await gate(svc, targetId, input.targetRole, { subjectUserId: subject.id })
  if (!seat.allowed) return { ok: false, error: seat.message ?? `Seat check refused (${seat.reason}).` }
  const afford = deps.mayUseAndAfford ?? (await import("@/lib/billing/billing-access")).mayUseAndAfford
  const access = await afford({ brokerageId: targetId, capability: "app.access", client: svc })
  if (!access.allowed) return { ok: false, error: `Your subscription cannot take on a workspace right now (${access.reason}).` }

  const at = nowIso(deps)
  const key = `transfer:request:${sourceId}:${targetId}:${at}`
  return ledgered<RequestBrokerageTransferResult>(svc, {
    brokerageId: targetId, action: "tenant.transfer.request", actorUserId: input.initiatedByUserId, subjectId: sourceId, key, riskClass: "LOW_RISK_WRITE",
    detail: { source_brokerage_id: sourceId, target_role: input.targetRole, subject_user_id: subject.id },
  }, async () => {
    const { data: inserted, error: insErr } = await svc.from("brokerage_transfer_requests").insert({
      brokerage_id: targetId, source_brokerage_id: sourceId, target_brokerage_id: targetId,
      subject_user_id: subject.id, initiated_by_user_id: input.initiatedByUserId, target_role: input.targetRole,
      status: "requested", reason: (input.reason ?? "").trim().slice(0, 500) || null,
      consent: null, verification: null, migration: null, billing_handoff: null, readiness: null,
      effective_at: null, completed_at: null, created_at: at, updated_at: at,
    }).select("*").single()
    if (insErr || !inserted) return { ok: false as const, error: `Transfer request not recorded: ${insErr?.message ?? "no row"}` }
    const request = inserted as TransferRequestRow
    await emitTransferEvent(svc, deps, "brokerage_transfer_requested", targetId, request.id, input.initiatedByUserId, { source_brokerage_id: sourceId, target_role: input.targetRole, subject_user_id: subject.id })
    const notified = await notifyHumans(svc, deps, "consent_requested", request,
      `${target.row!.name ?? "A brokerage"} has asked to adopt your workspace "${source.row!.name ?? ""}" as its ${input.targetRole.replace(/_/g, " ")}. Nothing moves until you consent in Settings → General → Brokerage affiliation.`,
      { subject: true })
    return { ok: true as const, request, notified: { subject: notified.subject } }
  }, (why) => ({ ok: false, error: `Transfer request evidence could not be recorded (${why}) — nothing was requested.` }))
}

// ── 2. CONSENT / DECLINE (the subject, from their own session) ───────────────

export interface TransferConsentInput {
  requestId: string
  actor: TransferActor
  decision: "consent" | "decline"
  /** The subject's own words — recorded verbatim as evidence (required for consent). */
  statement: string
  channel: string
}

export type TransferConsentResult =
  | { ok: true; request: TransferRequestRow; migration: RunTransferMigrationResult | null }
  | { ok: false; error: string }

export async function recordBrokerageTransferConsent(svc: any, input: TransferConsentInput, deps: BrokerageTransferDeps = {}): Promise<TransferConsentResult> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, error: `Could not read the request: ${read.error}` }
  const req = read.row
  if (!req) return { ok: false, error: "Transfer request not found." }
  if (req.subject_user_id !== input.actor.userId || req.source_brokerage_id !== input.actor.brokerageId) return { ok: false, error: "Only the owner of the workspace being adopted can answer this request." }
  if (req.status !== "requested") return { ok: false, error: `This request is ${req.status} — it cannot be answered again.` }
  const statement = String(input.statement ?? "").trim()
  if (input.decision === "consent" && statement.length < 8) return { ok: false, error: "Consent needs your own statement (a sentence in your words) — it is recorded as evidence." }

  const [source, target] = await Promise.all([readBrokerage(svc, req.source_brokerage_id), readBrokerage(svc, req.target_brokerage_id)])
  const at = nowIso(deps)
  const consent: TransferConsentEvidence = {
    user_id: input.actor.userId, at, decision: input.decision, statement: statement.slice(0, 1000), channel: String(input.channel ?? "settings_ui").slice(0, 60),
    request_snapshot: { source_brokerage_id: req.source_brokerage_id, target_brokerage_id: req.target_brokerage_id, target_role: req.target_role, source_name: source.row?.name ?? null, target_name: target.row?.name ?? null },
  }
  const nextStatus: TransferStatus = input.decision === "consent" ? "consented" : "declined"
  const key = `transfer:consent:${req.id}`
  const recorded = await ledgered<{ ok: boolean; error?: string }>(svc, {
    brokerageId: req.brokerage_id, action: "tenant.transfer.consent", actorUserId: input.actor.userId, subjectId: req.id, key, riskClass: "LOW_RISK_WRITE",
    detail: { decision: input.decision, source_brokerage_id: req.source_brokerage_id, channel: consent.channel },
  }, async () => {
    const { data, error } = await svc.from("brokerage_transfer_requests").update({ status: nextStatus, consent, updated_at: at }).eq("id", req.id).eq("status", "requested").select("id")
    if (error) return { ok: false, error: `Consent not recorded: ${error.message}` }
    if ((data ?? []).length !== 1) return { ok: false, error: "Consent not recorded: the request changed underneath you." }
    return { ok: true }
  }, (why) => ({ ok: false, error: `Consent evidence could not be recorded (${why}) — nothing changed.` }))
  if (!recorded.ok) return { ok: false, error: recorded.error ?? "consent refused" }

  await emitTransferEvent(svc, deps, input.decision === "consent" ? "brokerage_transfer_consented" : "brokerage_transfer_declined", req.brokerage_id, req.id, input.actor.userId, { source_brokerage_id: req.source_brokerage_id, channel: consent.channel })
  await notifyHumans(svc, deps, input.decision === "consent" ? "consent_recorded" : "declined", req,
    input.decision === "consent"
      ? `${source.row?.name ?? "The workspace"} consented to the adoption; the migration is running now.`
      : `${source.row?.name ?? "The workspace"} declined the adoption request${statement ? `: "${statement.slice(0, 200)}"` : "."}`,
    { targetAdmins: true })

  const after = await readRequest(svc, req.id)
  if (input.decision === "decline" || !after.row) return { ok: true, request: after.row ?? { ...req, status: nextStatus, consent }, migration: null }
  // IMMEDIATE: consent → verify → migrate, in this same call. A stall is recorded and resumable.
  const migration = await runBrokerageTransferMigration(svc, { requestId: req.id, actor: { ...input.actor, kind: "subject" } }, deps)
  const final = await readRequest(svc, req.id)
  return { ok: true, request: final.row ?? after.row, migration }
}

// ── 3. CANCEL (the target brokerage admin, before migration starts) ──────────

export async function cancelBrokerageTransferRequest(svc: any, input: { requestId: string; actor: TransferActor; reason?: string | null }, deps: BrokerageTransferDeps = {}): Promise<{ ok: boolean; error?: string }> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, error: `Could not read the request: ${read.error}` }
  const req = read.row
  if (!req) return { ok: false, error: "Transfer request not found." }
  if (req.brokerage_id !== input.actor.brokerageId) return { ok: false, error: "That request belongs to another brokerage." }
  if (req.status !== "requested" && req.status !== "consented") return { ok: false, error: `A ${req.status} request cannot be cancelled${req.status === "migrating" ? " — the migration is in progress; retry it to finish" : ""}.` }
  const at = nowIso(deps)
  const r = await ledgered<{ ok: boolean; error?: string }>(svc, {
    brokerageId: req.brokerage_id, action: "tenant.transfer.cancel", actorUserId: input.actor.userId, subjectId: req.id, key: `transfer:cancel:${req.id}`, riskClass: "LOW_RISK_WRITE",
    detail: { reason: input.reason ?? null, was: req.status },
  }, async () => {
    const { data, error } = await svc.from("brokerage_transfer_requests").update({ status: "cancelled", reason: (input.reason ?? req.reason ?? "").toString().slice(0, 500) || null, updated_at: at }).eq("id", req.id).in("status", ["requested", "consented"]).select("id")
    if (error) return { ok: false, error: error.message }
    if ((data ?? []).length !== 1) return { ok: false, error: "The request changed underneath you — nothing cancelled." }
    return { ok: true }
  }, (why) => ({ ok: false, error: `Cancellation evidence could not be recorded (${why}) — nothing changed.` }))
  if (r.ok) await emitTransferEvent(svc, deps, "brokerage_transfer_cancelled", req.brokerage_id, req.id, input.actor.userId, { reason: input.reason ?? null })
  return r
}

// ── 4. MIGRATE (verify → membership → data → billing → archive → readiness) ──

export interface RunTransferMigrationInput { requestId: string; actor: TransferActor }

export type RunTransferMigrationResult =
  | { ok: true; completed: true; alreadyCompleted: boolean; record: TransferMigrationRecord; readiness: TenantReadinessVerdict | null }
  | { ok: false; completed: false; stalledAt: TransferStep | null; error: string; record: TransferMigrationRecord | null }

export async function runBrokerageTransferMigration(svc: any, input: RunTransferMigrationInput, deps: BrokerageTransferDeps = {}): Promise<RunTransferMigrationResult> {
  const read = await readRequest(svc, input.requestId)
  if (read.error) return { ok: false, completed: false, stalledAt: null, error: `Could not read the request: ${read.error}`, record: null }
  const req = read.row
  if (!req) return { ok: false, completed: false, stalledAt: null, error: "Transfer request not found.", record: null }
  // WHO MAY RUN IT: the target's admins (their session tenant is the request's), the subject right
  // after consenting (their session tenant is the source), or the system (a continuation).
  if (input.actor.kind === "target_admin" && req.brokerage_id !== input.actor.brokerageId) return { ok: false, completed: false, stalledAt: null, error: "That request belongs to another brokerage.", record: req.migration }
  if (input.actor.kind === "subject" && (req.subject_user_id !== input.actor.userId || req.source_brokerage_id !== input.actor.brokerageId)) return { ok: false, completed: false, stalledAt: null, error: "Only the consenting owner or the adopting brokerage can run this transfer.", record: req.migration }
  if (req.status === "completed") return { ok: true, completed: true, alreadyCompleted: true, record: req.migration as TransferMigrationRecord, readiness: req.readiness }
  if (req.status !== "consented" && req.status !== "migrating") return { ok: false, completed: false, stalledAt: null, error: `A ${req.status} request cannot be migrated${req.status === "requested" ? " — the workspace owner has not consented" : ""}.`, record: req.migration }
  if (!req.consent || req.consent.decision !== "consent" || req.consent.user_id !== req.subject_user_id) return { ok: false, completed: false, stalledAt: null, error: "No consent evidence from the workspace owner — refused.", record: req.migration }

  const record: TransferMigrationRecord = req.migration && req.migration.version === 1
    ? { ...req.migration, steps: { ...req.migration.steps }, counts: { ...req.migration.counts }, attempts: (req.migration.attempts ?? 0) + 1 }
    : { version: 1, attempts: 1, steps: {}, counts: {} }
  const effectiveAt = req.effective_at ?? nowIso(deps)
  const sourceId = req.source_brokerage_id
  const targetId = req.target_brokerage_id // THE ROW's target — never the caller's
  const actorUserId = input.actor.userId

  const persist = async (extra: Record<string, unknown> = {}) => {
    const r = await patchRequest(svc, req.id, { migration: record, effective_at: effectiveAt, ...extra }, deps)
    if (!r.ok) console.error("[brokerage-transfer] migration record write refused:", r.error, { requestId: req.id })
  }
  const step = async (key: TransferStep, run: () => Promise<{ error?: string | null; skipped?: string | null; detail?: string | null } | void>): Promise<boolean> => {
    const prior = record.steps[key]?.status
    if (prior === "done" || prior === "skipped") return true
    try {
      const r = (await run()) ?? {}
      if (r.skipped) record.steps[key] = { status: "skipped", at: nowIso(deps), detail: r.skipped }
      else if (r.error) { record.steps[key] = { status: "failed", at: nowIso(deps), error: r.error.slice(0, 700) }; record.last_error = r.error.slice(0, 700) }
      else record.steps[key] = { status: "done", at: nowIso(deps), ...(r.detail ? { detail: r.detail } : {}) }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      record.steps[key] = { status: "failed", at: nowIso(deps), error: msg.slice(0, 700) }
      record.last_error = msg.slice(0, 700)
    }
    await persist()
    return record.steps[key]?.status !== "failed"
  }
  const stall = async (at: TransferStep, touch: TransferHumanTouchpoint, body: string, staff: boolean): Promise<RunTransferMigrationResult> => {
    await emitTransferEvent(svc, deps, "brokerage_transfer_stalled", targetId, req.id, actorUserId, { step: at, error: record.last_error ?? null, attempt: record.attempts })
    await notifyHumans(svc, deps, touch, req, body, { targetAdmins: true, staff })
    return { ok: false, completed: false, stalledAt: at, error: record.last_error ?? `stalled at ${at}`, record }
  }
  // THE BILLING ACTOR IS THE APPROVING BROKERAGE ADMIN, NEVER THE SUBJECT (owner, wave 142: "fix the
  // Stripe handoff to use the APPROVING BROKERAGE ADMIN (not the subject user)"). The consent call runs
  // this migration AS THE SUBJECT (kind "subject"), and the Stripe side (lib/billing/subscriber-handoff.ts)
  // admits only an admin OF THE TARGET or platform staff — so every Stripe-linked adoption handed the
  // subject's id over, was refused actor_not_authorized, and stalled at stripe_handoff_pending on consent.
  // The approval IS the request: initiated_by_user_id is the target admin who filed it
  // (app/actions/brokerage-transfer.ts requireAdoptingAdmin). A target admin retrying a stalled run is
  // that admin re-approving it, so their own id is passed; the subject and a system continuation carry
  // the original approver. The ledger keeps the RUNNING actor (who pressed the button) and records the
  // approver beside it.
  const approvingAdminUserId = input.actor.kind === "target_admin" ? input.actor.userId : req.initiated_by_user_id

  return ledgered<RunTransferMigrationResult>(svc, {
    brokerageId: targetId, action: "tenant.transfer.migrate", actorUserId, subjectId: req.id, key: `transfer:migrate:${req.id}:attempt:${record.attempts}`, riskClass: "FINANCIAL",
    detail: { source_brokerage_id: sourceId, attempt: record.attempts, pending: transferStepsPending(record), effective_at: effectiveAt, approving_admin_user_id: approvingAdminUserId },
  }, async () => {
    await persist()

    // ── verification: deterministic checks, each recorded; any failure stops before a row moves ──
    // Held in a ref object: these are assigned inside the step closures, and TS narrows a reassigned
    // `let … = null` read after the closure to `never`.
    const ref: { source: Awaited<ReturnType<typeof readBrokerage>>["row"]; target: Awaited<ReturnType<typeof readBrokerage>>["row"]; verdict: TenantReadinessVerdict | null } = { source: null, target: null, verdict: null }
    const okV = await step("verification", async () => {
      const checks: Array<{ key: string; ok: boolean; detail: string }> = []
      const source = await readBrokerage(svc, sourceId)
      const target = await readBrokerage(svc, targetId)
      ref.source = source.row; ref.target = target.row
      checks.push({ key: "source_tenant", ok: !!source.row && !source.row.deleted_at && isIndependentSubscriberTier(source.row.plan_tier), detail: source.error ?? (source.row ? `${source.row.plan_tier} / ${source.row.status}` : "not found") })
      checks.push({ key: "target_tenant", ok: !!target.row && !target.row.deleted_at && ADOPTING_STATUSES.has(String(target.row.status ?? "")) && target.row.plan_tier !== "solo_agent" && target.row.id === req.brokerage_id, detail: target.error ?? (target.row ? `${target.row.plan_tier} / ${target.row.status}` : "not found") })
      checks.push({ key: "source_ne_target", ok: sourceId !== targetId, detail: sourceId === targetId ? "same tenant" : "distinct canonical ids" })
      const { data: subj, error: subjErr } = await svc.from("users").select("id, brokerage_id, user_type").eq("id", req.subject_user_id).maybeSingle()
      const subject = subj as { brokerage_id: string | null; user_type: string | null } | null
      const membershipDone = record.steps.membership?.status === "done"
      checks.push({ key: "subject_in_source", ok: !subjErr && !!subject && (subject.brokerage_id === sourceId || (membershipDone && subject.brokerage_id === targetId)), detail: subjErr?.message ?? (subject ? `users.brokerage_id=${subject.brokerage_id}` : "subject not found") })
      checks.push({ key: "consent", ok: req.consent?.decision === "consent" && req.consent.request_snapshot?.target_brokerage_id === targetId && req.consent.request_snapshot?.source_brokerage_id === sourceId, detail: req.consent ? `recorded ${req.consent.at} via ${req.consent.channel}` : "missing" })
      const tierAllows = deps.tierAllowsRole ?? (await import("@/lib/kernel/tier-role-matrix")).tierAllowsRole
      checks.push({ key: "target_role_on_tier", ok: tierAllows(target.row?.plan_tier, req.target_role), detail: `${req.target_role} on ${target.row?.plan_tier}` })
      if (!membershipDone) {
        const gate = deps.seatGate ?? (await import("@/lib/kernel/seat-usage")).seatGate
        const seat = await gate(svc, targetId, req.target_role, { subjectUserId: req.subject_user_id })
        checks.push({ key: "target_seat", ok: seat.allowed, detail: seat.message ?? seat.reason })
      }
      const afford = deps.mayUseAndAfford ?? (await import("@/lib/billing/billing-access")).mayUseAndAfford
      const access = await afford({ brokerageId: targetId, capability: "app.access", client: svc })
      checks.push({ key: "target_entitled", ok: access.allowed, detail: access.reason })
      const failed = checks.filter((c) => !c.ok)
      const verification = { at: nowIso(deps), ok: failed.length === 0, checks }
      const r = await patchRequest(svc, req.id, { verification, ...(failed.length === 0 ? { status: "migrating" } : {}) }, deps)
      if (!r.ok) return { error: `verification could not be recorded: ${r.error}` }
      if (failed.length) return { error: `verification failed: ${failed.map((c) => `${c.key} (${c.detail})`).join("; ")}` }
      return { detail: `${checks.length} checks passed` }
    })
    if (!okV) return stall("verification", "verification_failed", `The adoption of ${ref.source?.name ?? sourceId} could not be verified: ${record.last_error}. Nothing moved.`, false)
    req.status = "migrating"

    // ── membership: the canonical users.ts movers, owner first; source grants retired first ──
    const okM = await step("membership", async () => {
      const isaId = ref.source?.ai_isa_system_user_id ?? null
      const { data: memberRows, error: memErr } = await svc.from("users").select("id, email, first_name, last_name, user_type, team_id, platform_role").eq("brokerage_id", sourceId).is("platform_role", null)
      if (memErr) return { error: `members read refused: ${memErr.message}` }
      const members = ((memberRows ?? []) as Array<{ id: string; email: string | null; first_name: string | null; last_name: string | null; user_type: string | null; team_id: string | null }>)
        .filter((u) => u.id !== isaId && MOVING_SEAT_TYPES.has(String(u.user_type ?? "")))
        .sort((a, b) => (a.id === req.subject_user_id ? -1 : b.id === req.subject_user_id ? 1 : 0))
      const moveUser = deps.assignUserToBrokerage ?? (await import("@/lib/kernel/users")).assignUserToBrokerage
      const setRole = deps.assignRole ?? (await import("@/lib/kernel/users")).assignUserRoleAndEntitlements
      const domain = deps.domainRecords ?? (await import("@/lib/kernel/users")).createOrRepairUserDomainRecords
      let moved = 0
      for (const u of members) {
        const role = memberTargetRole(u.user_type, u.id === req.subject_user_id, req.target_role)
        // Retire the SOURCE tenant's grants first — assignUserToBrokerage re-pins every grant the user
        // holds, and an 'admin' grant re-pinned to the target would make the adopted agent its admin.
        const { data: retired, error: retireErr } = await svc.from("user_role_assignments").delete().eq("user_id", u.id).eq("brokerage_id", sourceId).select("id")
        if (retireErr) return { error: `grants of ${u.email ?? u.id} could not be retired: ${retireErr.message}` }
        record.counts[`grants_retired`] = (record.counts.grants_retired ?? 0) + (retired ?? []).length
        const mv = await moveUser({ userId: u.id, brokerageId: targetId, callerUserId: actorUserId })
        if (!mv.success) return { error: `${u.email ?? u.id} could not be moved: ${mv.error ?? "refused"}` }
        const rl = await setRole({ userId: u.id, newRole: role, brokerageId: targetId, teamId: u.team_id ?? null, callerUserId: actorUserId })
        if (!rl.success) return { error: `${u.email ?? u.id} moved, but their ${role} seat was refused: ${rl.error ?? "refused"}` }
        const dr = await domain({ userId: u.id, email: u.email ?? "", firstName: u.first_name ?? "", lastName: u.last_name ?? "", userType: role, brokerageId: targetId, teamId: u.team_id ?? null, tier: ref.target?.plan_tier ?? null, callerUserId: actorUserId })
        if (!dr.success) return { error: `${u.email ?? u.id} seated, but their domain records were refused: ${dr.error ?? "refused"}` }
        moved += 1
      }
      record.counts.members = (record.counts.members ?? 0) + moved
      // The team (a mini brokerage) moves as a unit — same id, so every team_id stays coherent.
      const { data: teams, error: teamErr } = await svc.from("teams").update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).select("id")
      if (teamErr) return { error: `teams could not be moved: ${teamErr.message}` }
      record.counts.teams = (record.counts.teams ?? 0) + (teams ?? []).length
      // IMMEDIATE POST-CONDITION: no seat is left behind, and the subject sits in the target.
      const { data: left, error: leftErr } = await svc.from("users").select("id, user_type").eq("brokerage_id", sourceId).is("platform_role", null)
      if (leftErr) return { error: `post-condition read refused: ${leftErr.message}` }
      const stragglers = ((left ?? []) as Array<{ id: string; user_type: string | null }>).filter((u) => u.id !== isaId && MOVING_SEAT_TYPES.has(String(u.user_type ?? "")))
      if (stragglers.length) return { error: `post-condition failed: ${stragglers.length} seat(s) still in the source tenant` }
      const { data: subjNow } = await svc.from("users").select("brokerage_id").eq("id", req.subject_user_id).maybeSingle()
      if ((subjNow as { brokerage_id?: string } | null)?.brokerage_id !== targetId) return { error: "post-condition failed: the adopted owner is not in the target tenant" }
      return { detail: `${moved} member(s), ${(teams ?? []).length} team(s)` }
    })
    if (!okM) return stall("membership", "data_move_failed", `Membership migration stalled: ${record.last_error}. Retry from Settings → Users once the cause is fixed.`, true)

    // ── data: every family, pinned to the source, re-homed to the ROW's target; post-condition per family ──
    const okD = await step("data", async () => {
      const errors: string[] = []
      for (const fam of TRANSFER_DATA_FAMILIES) {
        const { data: moved, error } = await svc.from(fam.table).update({ brokerage_id: targetId }).eq("brokerage_id", sourceId).select("id")
        if (error) { errors.push(`${fam.table}: ${error.message}`); continue }
        record.counts[fam.table] = (record.counts[fam.table] ?? 0) + (moved ?? []).length
        const { data: left, error: leftErr } = await svc.from(fam.table).select("id").eq("brokerage_id", sourceId).limit(1)
        if (leftErr) errors.push(`${fam.table} post-condition read: ${leftErr.message}`)
        else if ((left ?? []).length) errors.push(`${fam.table}: rows remain in the source after the move`)
      }
      if (errors.length) return { error: `data families refused: ${errors.join("; ")}` }
      return { detail: TRANSFER_DATA_FAMILIES.map((f) => `${f.table}=${record.counts[f.table] ?? 0}`).join(",") }
    })
    if (!okD) return stall("data", "data_move_failed", `Data migration stalled: ${record.last_error}. Membership already moved; retry from Settings → Users once the cause is fixed.`, true)

    // ── billing handoff: the ONE billing call; not ok = nothing changed, archive waits ──
    const okB = await step("billing_handoff", async () => {
      const handoff = deps.billingHandoff ?? (await import("@/lib/billing/subscriber-billing-handoff")).handoffSubscriberBillingToBrokerage
      const r = await handoff(svc, { sourceBrokerageId: sourceId, targetBrokerageId: targetId, effectiveAt, transferRequestId: req.id, actorUserId: approvingAdminUserId })
      const p = await patchRequest(svc, req.id, { billing_handoff: r }, deps)
      if (!p.ok) return { error: `billing handoff evidence not recorded: ${p.error}` }
      if (!r.ok) return { error: `billing handoff pending (${r.code}): ${r.error}` }
      return { detail: `${r.mode} effective ${r.effectiveAt}` }
    })
    if (!okB) return stall("billing_handoff", "billing_pending", `The adopted workspace's individual billing has not been handed off yet: ${record.last_error}. The workspace stays open (not archived) until the Finance Manager completes it; retry afterwards.`, true)

    // ── archive the source: status + archived_at (first writer of a live, readerful column) — never deleted ──
    const okA = await step("archive_source", async () => {
      const at = nowIso(deps)
      const { data, error } = await svc.from("brokerages").update({ status: "archived", archived_at: at, updated_at: at }).eq("id", sourceId).neq("status", "archived").select("id")
      if (error) return { error: `archive refused: ${error.message}` }
      if ((data ?? []).length !== 1) {
        const now = await readBrokerage(svc, sourceId)
        if (now.row?.status === "archived") return { detail: "already archived" }
        return { error: "archive matched no row" }
      }
      await emitTransferEvent(svc, deps, "brokerage_archived", sourceId, req.id, actorUserId, { adopted_by_brokerage_id: targetId, archived_at: at })
      return { detail: `archived ${at}` }
    })
    if (!okA) return stall("archive_source", "data_move_failed", `The adopted workspace could not be archived: ${record.last_error}.`, true)

    // ── the target's readiness verdict (evaluate; repairs are the self-healing engine's) ──
    await step("target_readiness", async () => {
      const evaluate = deps.readiness ?? (async (c: any, id: string) => { const r = await (await import("@/lib/kernel/tenant-readiness")).evaluateTenantReadiness(c, id); return { ready: r.ready, blockers: r.blockers, checkedAt: r.checkedAt } })
      try { ref.verdict = await evaluate(svc, targetId) } catch (e) { ref.verdict = { ready: false, blockers: [`readiness evaluation threw: ${(e as Error).message}`], checkedAt: nowIso(deps) } }
      const p = await patchRequest(svc, req.id, { readiness: ref.verdict }, deps)
      if (!p.ok) return { error: `readiness verdict not recorded: ${p.error}` }
      return { detail: ref.verdict.ready ? "READY" : `NOT READY: ${ref.verdict.blockers.join("; ")}` }
    })

    // IMMEDIATE OPERATION (wave 141B, integrated): the transfer's post-condition verdict is evidenced and, when
    // the brokerage is not READY, routed to its owning manager in-request — never a day/week later.
    try {
      const report = deps.reportOutcome ?? (async (c: any, i: Record<string, unknown>) => (await import("@/lib/kernel/immediate-operations")).reportOperationOutcome(c, i as never))
      await report(svc, { operation: "brokerage_transfer", brokerageId: targetId, ok: !!ref.verdict?.ready, subjectType: "brokerage_transfer_request", subjectId: req.id, actorUserId, evidence: { source_brokerage_id: sourceId, counts: record.counts, effective_at: effectiveAt, readiness: ref.verdict }, error: ref.verdict?.ready ? null : (ref.verdict?.blockers.join("; ") ?? "readiness unknown"), tenantFacing: ref.verdict?.ready ? null : "The adoption completed; the brokerage still has setup to finish before it is fully ready." })
    } catch (e) { record.last_error = `operation report failed: ${(e as Error).message}` }

    const completedAt = nowIso(deps)
    await persist({ status: "completed", completed_at: completedAt })
    await emitTransferEvent(svc, deps, "brokerage_transfer_completed", targetId, req.id, actorUserId, { source_brokerage_id: sourceId, counts: record.counts, effective_at: effectiveAt, ready: ref.verdict?.ready ?? null })
    await notifyHumans(svc, deps, "completed", req, `${ref.source?.name ?? "The workspace"} is now part of ${ref.target?.name ?? "your brokerage"}: ${record.counts.members ?? 0} member(s), ${Object.entries(record.counts).filter(([k]) => !["members", "teams", "grants_retired"].includes(k)).reduce((n, [, v]) => n + v, 0)} record(s) moved; individual billing stopped effective ${effectiveAt}.`, { targetAdmins: true, subject: true })
    if (ref.verdict && !ref.verdict.ready) {
      await notifyHumans(svc, deps, "target_not_ready", req, `The adoption completed but the brokerage is not READY: ${ref.verdict.blockers.join("; ")}.`, { targetAdmins: true })
    }
    return { ok: true, completed: true, alreadyCompleted: false, record, readiness: ref.verdict }
  }, (why) => ({ ok: false, completed: false, stalledAt: null, error: `Transfer evidence could not be recorded (${why}) — nothing moved.`, record }))
}

// ── 5. LIST (for the two settings cards) ──────────────────────────────────────

export async function listBrokerageTransferRequests(svc: any, input: { brokerageId: string; side: "target" | "source"; limit?: number }): Promise<{ ok: boolean; error?: string; requests: TransferRequestRow[] }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  if (input.side === "target") {
    const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(limit)
    if (error) return { ok: false, error: error.message, requests: [] }
    return { ok: true, requests: (data ?? []) as TransferRequestRow[] }
  }
  const { data, error } = await svc.from("brokerage_transfer_requests").select("*").eq("source_brokerage_id", input.brokerageId).order("created_at", { ascending: false }).limit(limit)
  if (error) return { ok: false, error: error.message, requests: [] }
  return { ok: true, requests: (data ?? []) as TransferRequestRow[] }
}
