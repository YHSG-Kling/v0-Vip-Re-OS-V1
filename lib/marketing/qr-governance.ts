/**
 * lib/marketing/qr-governance.ts — THE GOVERNED QR DOORS (wave 152, lane 152C).
 *
 * Owner (verbatim, 2026-11-11): "qr minted bar code has a destination url and each bar code needs is unique and needs
 * tracking, creating one and managing. all mail including letters can have a section that can use a qr bar code."
 *
 * EXTENDS THE ONE REGISTRY — it is not a second one. `qr_codes` stays THE registry, lib/marketing/tracked-qr.ts
 * mintTrackedQr stays its ONE writer of new rows, /api/qr/scan stays THE resolver (scripts/qr-registry-guard.ts §1).
 * What this module adds is the path a PERSON's request takes before it reaches that writer (constitution LAW 4/5):
 *
 *   session actor (the caller's gate: resolveWriteContext — tenant from the SESSION, never a body)
 *     → typed instruction (GovernedQrMintInput / destination edit / lifecycle / duplicate)
 *     → policy: input rules · office/team permission · tenant-scoped campaign/listing · destination safety
 *       (qr-contract.ts validateQrDestination: https, verified tenant hosts + the external allow-list, no loop,
 *       no personal data in the URL) — allow or refuse with the tenant-facing sentence
 *     → the canonical writer (mintTrackedQr / one counted UPDATE)
 *     → withActionLedger evidence (who, why HUMAN_REQUESTED, which tool, what happened; idempotency for the mint)
 *     → readback (the row the write returned, or the ledger's provider_ref on a replay)
 *
 * SERVER-ONLY and gate-free by design: every export takes the ALREADY-RESOLVED session actor. The callers are the gates
 * — app/api/admin/qr-codes/route.ts (create + edit on the board) and app/actions/qr-management.ts (lifecycle,
 * duplicate, activity) — each resolveWriteContext first, then here (CLAUDE.md §4: gate first, then the service client).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { withActionLedger, type LedgerClient, type NonActingClaim } from "@/lib/kernel/action-ledger"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { MAIL_LAYOUT_LIBRARY } from "@/lib/direct-mail/mail-piece-rules"
import { mintTrackedQr, isQrDestinationType, isQrPurpose, normalizeOrigin, type QrDestinationType, type QrPurpose, type MintedTrackedQr } from "./tracked-qr"
import {
  validateQrDestination, qrLifecycleState, appendQrDestinationVersion, classifyQrScan, qrReferrerHost,
  summarizeQrScans, isAbsentColumnRefusal, qrLabelKind, QR_TOKEN_SCOPES, QR_CONSENT_CONTEXTS, QR_PLACEMENT_TYPES, QR_REPEAT_WINDOW_MS,
  QR_RETIRED_REASONS, QR_TRAFFIC_CLASSES, QR_DEVICE_CLASSES,
  type QrMintContext, type QrDestinationVersion, type QrLifecycleState, type QrScanSummary, type QrTokenScope, type QrConsentContext,
  type QrTrafficClass,
} from "./qr-contract"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any }

/** The SESSION actor a gate resolved (resolveWriteContext): tenant, users.id, agents.id (nullable), user_type. */
export interface QrActor {
  brokerageId: string
  userId: string
  agentId: string | null
  userType: string
}

interface QrDoorDeps {
  /** Service client (the gate already ran). */
  client?: Db
  /** The action ledger's client (a proof injects the same in-memory client). */
  ledgerClient?: LedgerClient
  /** The app's own origins (NEXT_PUBLIC_APP_URL + the request origin). */
  appOrigins?: ReadonlyArray<string | null | undefined>
  /** Origin for the scan link the minter builds. */
  origin?: string | null
}

type Refusal = { ok: false; code: "invalid" | "unsafe_destination" | "not_permitted" | "not_found" | "terminal" | "conflict" | "refused" | "in_flight" | "unavailable"; message: string }

/** Office filing: the tenant-admin roster minus team leads (a lead files under the TEAM they lead — a fact, below).
 *  Derived by named subtraction from the one roster (CLAUDE.md §4), never retyped. */
const OFFICE_FILERS = new Set([...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead"))

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/
/** `<kind>:<id>` is a minter's server-side key namespace (listing:, open_house:, lead_magnet:, …) — a person's label may
 *  not take that shape, or a later automated mint for that entity would find the person's code. */
const GENERATED_KEY_RE = /^(platform:)?[a-z][a-z_]*:/

// ─── tenant hosts (verified custom domains + the declared website) ────────────

/**
 * The hosts a tenant may point a code at as its OWN site: ACTIVE verified custom domains (tenant_custom_domains,
 * status 'active' — lib/platform/custom-domains.ts owns that state) and the website it declared in its brand settings.
 * A refused read returns what it could read — fewer hosts means MORE refusals (fail closed), never fewer.
 */
export async function loadQrTenantHosts(db: Db, brokerageId: string): Promise<{ customDomains: string[]; websiteHosts: string[] }> {
  const customDomains: string[] = []
  const websiteHosts: string[] = []
  const { data: domains, error: dErr } = await db.from("tenant_custom_domains").select("domain, status").eq("brokerage_id", brokerageId).eq("status", "active")
  if (dErr) console.error("[qr-governance] verified domains not read — tenant-site destinations refused:", dErr.message)
  for (const d of (domains ?? []) as Array<{ domain?: string | null }>) if (d.domain) customDomains.push(d.domain.toLowerCase())
  const hostOf = (u: string | null | undefined): string | null => {
    if (!u) return null
    try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase() } catch { return null }
  }
  const { data: brand, error: bErr } = await db.from("brokerage_brand_settings").select("website_url").eq("brokerage_id", brokerageId).maybeSingle()
  if (bErr) console.error("[qr-governance] brand website not read:", bErr.message)
  const { data: firm, error: fErr } = await db.from("brokerages").select("website").eq("id", brokerageId).maybeSingle()
  if (fErr) console.error("[qr-governance] brokerage website not read:", fErr.message)
  for (const h of [hostOf((brand as { website_url?: string | null } | null)?.website_url), hostOf((firm as { website?: string | null } | null)?.website)]) {
    if (h && !websiteHosts.includes(h)) websiteHosts.push(h)
  }
  return { customDomains, websiteHosts }
}

// ─── office / team permission ─────────────────────────────────────────────────

/** May this actor file a code under this team / office? The existing facts only: teams.team_lead_id (a users.id),
 *  the actor's own agents.team_id / location_id, locations.managing_broker_user_id, and the tenant-admin roster. */
async function decideFilingScope(db: Db, actor: QrActor, input: { teamId?: string | null; locationId?: string | null }): Promise<{ ok: true } | Refusal> {
  if (!input.teamId && !input.locationId) return { ok: true }
  const admin = OFFICE_FILERS.has(actor.userType)
  const { data: own, error: ownErr } = await db.from("agents").select("team_id, location_id").eq("user_id", actor.userId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (ownErr) return { ok: false, code: "refused", message: "We couldn't confirm which office or team you belong to, so nothing was created. Try again in a moment." }
  const mine = (own ?? {}) as { team_id?: string | null; location_id?: string | null }
  if (input.teamId) {
    const { data: team, error } = await db.from("teams").select("id, team_lead_id").eq("id", input.teamId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that team, so nothing was created. Try again in a moment." }
    const t = team as { id?: string; team_lead_id?: string | null } | null
    if (!t?.id) return { ok: false, code: "not_permitted", message: "That team isn't in your account. Pick one of your teams, or leave the team empty." }
    if (!admin && t.team_lead_id !== actor.userId && mine.team_id !== input.teamId) {
      return { ok: false, code: "not_permitted", message: "You can file a code only under a team you lead or belong to. Ask an account admin to create it for that team." }
    }
  }
  if (input.locationId) {
    const { data: loc, error } = await db.from("locations").select("id, managing_broker_user_id").eq("id", input.locationId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that office, so nothing was created. Try again in a moment." }
    const l = loc as { id?: string; managing_broker_user_id?: string | null } | null
    if (!l?.id) return { ok: false, code: "not_permitted", message: "That office isn't in your account. Pick one of your offices, or leave the office empty." }
    if (!admin && l.managing_broker_user_id !== actor.userId && mine.location_id !== input.locationId) {
      return { ok: false, code: "not_permitted", message: "You can file a code only under your own office. Ask an account admin to create it for that office." }
    }
  }
  return { ok: true }
}

// ─── THE GOVERNED MINT ────────────────────────────────────────────────────────

interface GovernedQrMintInput {
  /** The request's idempotency key — a replay with the same key returns the SAME code (never a second mint). */
  idempotencyKey: string
  /** The name a person reads on the board. */
  label: string
  purpose: QrPurpose
  destinationType: QrDestinationType | null
  /** The destination. Empty → the code's own landing (allowed only for landing_page / book_meeting / no type). */
  targetUrl?: string | null
  listingId?: string | null
  marketingCampaignId?: string | null
  expiresAt?: string | null
  teamId?: string | null
  locationId?: string | null
  channel?: string | null
  source?: string | null
  placement?: string | null
  mailLayout?: string | null
  assetId?: string | null
  purposeContext?: string | null
  consentContext?: QrConsentContext | null
  tokenScope?: QrTokenScope
  printSizeIn?: number | null
  trackingEnabled?: boolean
  duplicatedFrom?: string | null
}

interface GovernedQrRecord {
  id: string
  slug: string
  label: string
  scanUrl: string
  targetUrl: string
  destinationType: string | null
  purpose: string | null
  imageDataUrl: string | null
}

type GovernedQrResult = { ok: true; replayed: boolean; code: GovernedQrRecord } | Refusal

/** PURE (module-private) — the instruction's own rules, before anything is read. */
function inputRefusal(input: GovernedQrMintInput, nowMs: number): Refusal | null {
  const bad = (message: string): Refusal => ({ ok: false, code: "invalid", message })
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey ?? "")) return bad("This request is missing its safety key, so nothing was created. Reload the page and try again.")
  const label = (input.label ?? "").trim()
  if (!label || label.length > 120) return bad("Give the code a name of 1–120 characters so you can find it later.")
  if (GENERATED_KEY_RE.test(label)) return bad("Names that start with a word and a colon (like “listing:”) are reserved for codes the system creates. Rename it — for example “Spring open house sign”.")
  if (!isQrPurpose(input.purpose)) return bad("Choose what this code is for.")
  if (input.destinationType != null && !isQrDestinationType(input.destinationType)) return bad("Choose where scanners should land.")
  if (input.tokenScope && !(QR_TOKEN_SCOPES as readonly string[]).includes(input.tokenScope)) return bad("Choose whether this is one code for the design or one code per printed piece.")
  if (input.consentContext && !(QR_CONSENT_CONTEXTS as readonly string[]).includes(input.consentContext)) return bad("Choose what the destination does with personal details.")
  if (input.placement && !(QR_PLACEMENT_TYPES as readonly string[]).includes(input.placement)) return bad("Choose where the code is printed or shown.")
  if (input.mailLayout && !(input.mailLayout in MAIL_LAYOUT_LIBRARY && MAIL_LAYOUT_LIBRARY[input.mailLayout as keyof typeof MAIL_LAYOUT_LIBRARY].qrRegion)) return bad("That mail layout has no QR area. Choose a letter, personal note or postcard side.")
  if (input.printSizeIn !== null && input.printSizeIn !== undefined && !(input.printSizeIn >= 0.8 && input.printSizeIn <= 4)) return bad("Print the code between 0.8 and 4 inches wide — smaller than 0.8 inches phones misread it.")
  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime()
    if (!Number.isFinite(t) || t <= nowMs) return bad("Pick an end date in the future, or leave it empty.")
  }
  return null
}

const OWN_LANDING_TYPES = new Set<string | null>([null, "landing_page", "book_meeting"])

/** Re-read a minted code (the mint's readback, and a replay's answer). Tenant-scoped. */
async function readGovernedRecord(db: Db, brokerageId: string, qrCodeId: string, origin: string): Promise<GovernedQrRecord | null> {
  const { data, error } = await db.from("qr_codes").select("id, slug, label, target_url, destination_type, purpose").eq("id", qrCodeId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !data) return null
  const r = data as { id: string; slug: string; label: string; target_url: string; destination_type: string | null; purpose: string | null }
  return { id: r.id, slug: r.slug, label: r.label, scanUrl: `${origin}/api/qr/scan?slug=${r.slug}`, targetUrl: r.target_url, destinationType: r.destination_type, purpose: r.purpose, imageDataUrl: null }
}

type MintRun = { kind: "minted"; minted: MintedTrackedQr } | { kind: "refused" } | { kind: "replay"; claim: NonActingClaim }

/**
 * Mint ONE new, unique code for a person's request. Same idempotency key → the same record (the ledger's UNIQUE key;
 * the replay re-reads the code its provider_ref names). Two requests with two keys → two codes with two unpredictable
 * tokens, whatever their labels. Refused requests write nothing and say what to do.
 */
export async function mintGovernedQr(input: GovernedQrMintInput, actor: QrActor, deps: QrDoorDeps = {}): Promise<GovernedQrResult> {
  const db: Db = deps.client ?? createServiceClient()
  const origin = normalizeOrigin(deps.origin ?? null)
  const nowMs = Date.now()
  if (!actor.brokerageId || !actor.userId) return { ok: false, code: "not_permitted", message: "Sign in to an account to create QR codes." }
  const invalid = inputRefusal(input, nowMs)
  if (invalid) return invalid

  const scope = await decideFilingScope(db, actor, { teamId: input.teamId, locationId: input.locationId })
  if (!scope.ok) return scope

  // A campaign or listing FK proves a row exists, never that it is THIS tenant's.
  if (input.marketingCampaignId) {
    const { data, error } = await db.from("marketing_campaigns").select("id").eq("id", input.marketingCampaignId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that campaign, so nothing was created. Try again in a moment." }
    if (!data) return { ok: false, code: "not_permitted", message: "That campaign isn't in your account. Pick one of your campaigns." }
  }
  if (input.listingId) {
    const { data, error } = await db.from("listings").select("id").eq("id", input.listingId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "refused", message: "We couldn't confirm that listing, so nothing was created. Try again in a moment." }
    if (!data) return { ok: false, code: "not_permitted", message: "That listing isn't in your account. Pick one of your listings." }
  }

  const target = (input.targetUrl ?? "").trim()
  let destinationKind: string = "own_landing"
  let destination: string | null = null
  if (!target) {
    if (!OWN_LANDING_TYPES.has(input.destinationType ?? null)) return { ok: false, code: "invalid", message: "This kind of destination needs a web address. Paste the page people should reach." }
  } else {
    const hosts = await loadQrTenantHosts(db, actor.brokerageId)
    const verdict = validateQrDestination({ url: target, appOrigins: [...(deps.appOrigins ?? []), origin], tenantHosts: [...hosts.customDomains, ...hosts.websiteHosts] })
    if (!verdict.ok) return { ok: false, code: "unsafe_destination", message: verdict.message }
    destination = verdict.url
    destinationKind = verdict.kind
  }

  const context: Partial<QrMintContext> = {
    token_scope: input.tokenScope ?? "per_design",
    tracking: input.trackingEnabled === false ? "disabled" : "enabled",
    channel: input.channel ?? null, source: input.source ?? null, placement: input.placement ?? null, mail_layout: input.mailLayout ?? null,
    asset_id: input.assetId ?? null, team_id: input.teamId ?? null, location_id: input.locationId ?? null,
    purpose_context: input.purposeContext ?? null,
    // Said only where it is KNOWN: the code's own landing asks for consent before any contact (app/qr/[slug]); another
    // site has its own terms. An in-app page varies (a listing has a request form, a video page has none) — unstated.
    consent_context: input.consentContext ?? (destinationKind === "own_landing" ? "consented_form" : destinationKind === "allowed_external" || destinationKind === "tenant_site" ? "external_site" : null),
    print_size_in: input.printSizeIn ?? null, idempotency_key: input.idempotencyKey, duplicated_from: input.duplicatedFrom ?? null,
  }

  const run = await withActionLedger<MintRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.mint",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", ref: input.idempotencyKey },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      idempotencyKey: `qr_mint:${actor.brokerageId}:${input.idempotencyKey}`,
      channel: input.channel ?? null,
      systemSource: "qr_registry",
      detail: { label: input.label.trim(), purpose: input.purpose, destination_type: input.destinationType, destination_kind: destinationKind, marketing_campaign_id: input.marketingCampaignId ?? null, listing_id: input.listingId ?? null, ...context },
    },
    async () => {
      const minted = await mintTrackedQr({
        brokerageId: actor.brokerageId, agentId: actor.agentId, label: input.label.trim(), destinationType: input.destinationType,
        targetUrl: destination, listingId: input.listingId ?? null, marketingCampaignId: input.marketingCampaignId ?? null,
        expiresAt: input.expiresAt ?? null, purpose: input.purpose, origin, createdByUserId: actor.userId, mintContext: context, governed: true,
      }, db as never)
      return minted ? { kind: "minted", minted } : { kind: "refused" }
    },
    {
      settle: (r) => r.kind === "minted"
        ? { status: "executed", outcome: "minted", provider: "qr_registry", providerRef: r.minted.qrCodeId }
        : { status: "failed", outcome: "mint_refused", error: "the registry refused the new code" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const } : { kind: "replay" as const, claim }),
    },
    { client: deps.ledgerClient },
  )

  if (run.kind === "minted") {
    const m = run.minted
    return { ok: true, replayed: false, code: { id: m.qrCodeId, slug: m.slug, label: input.label.trim(), scanUrl: m.scanUrl, targetUrl: m.targetUrl, destinationType: m.destinationType, purpose: input.purpose, imageDataUrl: m.qrCodeDataUrl } }
  }
  if (run.kind === "refused") return { ok: false, code: "refused", message: "The QR code wasn't created — the registry refused the write. Nothing was saved; try again, and contact platform support if it keeps happening." }
  const claim = run.claim
  if (claim.kind === "replay" && claim.entry.provider_ref) {
    const again = await readGovernedRecord(db, actor.brokerageId, claim.entry.provider_ref, origin)
    if (again) return { ok: true, replayed: true, code: again }
  }
  if (claim.kind === "in_flight" || claim.kind === "unknown") return { ok: false, code: "in_flight", message: "This code is already being created from your earlier click. Wait a moment and reload the page to see it." }
  return { ok: false, code: "refused", message: "We couldn't confirm whether this code was created, so nothing new was made. Reload the page; if it isn't listed, create it again." }
}

// ─── DESTINATION EDIT (versioned) ─────────────────────────────────────────────

const EDIT_COLUMNS = "id, slug, brokerage_id, target_url, destination_type, is_active, expires_at, retired_at, retired_reason, destination_history"

type QrDestinationEditResult =
  | { ok: true; unchanged: boolean; targetUrl: string; destinationType: string | null; history: QrDestinationVersion[] }
  | Refusal

/**
 * Point a code at a new destination. The printed token never changes, so every printed copy follows the NEXT scan;
 * the previous destination is kept as a version (m945's trigger refuses a history that shrinks or a target change
 * without a new version). Tenant isolation: the row is read and written under the SESSION's brokerage only — another
 * tenant's code reads as "not in your account", the same answer as a code that does not exist.
 */
export async function editQrDestination(
  input: { qrCodeId: string; targetUrl: string; destinationType?: QrDestinationType | null; reason?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<QrDestinationEditResult> {
  const db: Db = deps.client ?? createServiceClient()
  const origin = normalizeOrigin(deps.origin ?? null)
  if (!input?.qrCodeId) return { ok: false, code: "invalid", message: "Choose the code to change." }
  if (input.destinationType !== undefined && input.destinationType !== null && !isQrDestinationType(input.destinationType)) return { ok: false, code: "invalid", message: "Choose where scanners should land." }

  const { data, error } = await db.from("qr_codes").select(EDIT_COLUMNS).eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) return { ok: false, code: "unavailable", message: "Destination history isn't switched on for your account yet, so the destination wasn't changed. Platform support can finish the update." }
  if (error) return { ok: false, code: "refused", message: "We couldn't load this code, so nothing was changed. Try again in a moment." }
  const row = data as { id: string; slug: string; target_url: string; destination_type: string | null; is_active: boolean | null; expires_at: string | null; retired_at: string | null; retired_reason: string | null; destination_history: QrDestinationVersion[] | null } | null
  if (!row) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const state = qrLifecycleState(row)
  if (state === "retired" || state === "revoked") return { ok: false, code: "terminal", message: "This code is retired, so its destination can't change. Duplicate it to print a new code with a new destination." }

  const hosts = await loadQrTenantHosts(db, actor.brokerageId)
  const verdict = validateQrDestination({ url: input.targetUrl, appOrigins: [...(deps.appOrigins ?? []), origin], tenantHosts: [...hosts.customDomains, ...hosts.websiteHosts], ownSlug: row.slug })
  if (!verdict.ok) return { ok: false, code: "unsafe_destination", message: verdict.message }
  const nextType = input.destinationType === undefined ? row.destination_type : input.destinationType
  if (verdict.url === row.target_url && nextType === row.destination_type) {
    return { ok: true, unchanged: true, targetUrl: row.target_url, destinationType: row.destination_type, history: row.destination_history ?? [] }
  }

  const changedAt = new Date().toISOString()
  const history = appendQrDestinationVersion(row.destination_history, { target_url: row.target_url, destination_type: row.destination_type }, { target_url: verdict.url, destination_type: nextType, changed_at: changedAt, changed_by_user_id: actor.userId, reason: (input.reason ?? "").trim() || null })
  const version = history[history.length - 1].version

  type EditRun = { kind: "saved" } | { kind: "conflict" } | { kind: "refused"; message: string } | { kind: "replay" }
  const out = await withActionLedger<EditRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.destination_edit",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", id: row.id },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      // One row per VERSION: a double-submitted save of the same version replays instead of writing twice.
      idempotencyKey: `qr_dest:${row.id}:v${version}`,
      systemSource: "qr_registry",
      detail: { from: row.target_url, to: verdict.url, from_type: row.destination_type, to_type: nextType, destination_kind: verdict.kind, version, reason: (input.reason ?? "").trim() || null },
    },
    async () => {
      // OPTIMISTIC: only the destination we read may be replaced; a write that matched nothing is COUNTED (§3).
      const { data: written, error: wErr } = await db.from("qr_codes")
        .update({ target_url: verdict.url, destination_type: nextType, destination_history: history })
        .eq("id", row.id).eq("brokerage_id", actor.brokerageId).eq("target_url", row.target_url)
        .select("id")
      if (wErr) return { kind: "refused", message: wErr.message }
      return Array.isArray(written) && written.length === 1 ? { kind: "saved" } : { kind: "conflict" }
    },
    {
      settle: (r) => r.kind === "saved" ? { status: "executed", outcome: "destination_changed", provider: "qr_registry", providerRef: row.id }
        : r.kind === "conflict" ? { status: "failed", outcome: "stale_destination", error: "the destination changed before this save" }
        : { status: "failed", outcome: "write_refused", error: r.kind === "refused" ? r.message : "refused" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const, message: claim.error } : { kind: "replay" as const }),
    },
    { client: deps.ledgerClient },
  )
  if (out.kind === "saved") return { ok: true, unchanged: false, targetUrl: verdict.url, destinationType: nextType, history }
  if (out.kind === "conflict") return { ok: false, code: "conflict", message: "Someone changed this code's destination a moment ago. Reload to see the latest version, then try again." }
  if (out.kind === "replay") return { ok: false, code: "in_flight", message: "This change was already saved from an earlier click. Reload to see it." }
  return { ok: false, code: "refused", message: "The destination wasn't changed — the save was refused. Nothing was changed; try again in a moment." }
}

// ─── LIFECYCLE: pause · resume · retire · revoke-unsafe ───────────────────────

export type QrLifecycleAction = "pause" | "resume" | "retire" | "revoke_unsafe"

/** The retirement each terminal action writes — typed against QR_RETIRED_REASONS (the m945 CHECK's one code source), so
 *  a vocabulary change that this door does not follow fails to compile instead of being refused by the database. */
const RETIREMENT_FOR: Record<"retire" | "revoke_unsafe", (typeof QR_RETIRED_REASONS)[number]> = { retire: "retired", revoke_unsafe: "revoked_unsafe" }

/** PURE (module-private) — the one transition table. Retirement is TERMINAL and never deletes the row: a code that was
 *  printed on mailed pieces is evidence of what was mailed. */
function lifecycleTransition(state: QrLifecycleState, action: QrLifecycleAction, nowIso: string): { ok: true; patch: Record<string, unknown> | null } | Refusal {
  const terminal = state === "retired" || state === "revoked"
  switch (action) {
    case "pause":
      if (terminal) return { ok: false, code: "terminal", message: "This code is already retired and doesn't route scans." }
      return { ok: true, patch: state === "paused" ? null : { is_active: false } }
    case "resume":
      if (terminal) return { ok: false, code: "terminal", message: "A retired code can't be resumed. Duplicate it to print a new code." }
      return { ok: true, patch: state === "paused" ? { is_active: true } : null }
    case "retire":
      if (terminal) return { ok: true, patch: null }
      return { ok: true, patch: { is_active: false, retired_at: nowIso, retired_reason: RETIREMENT_FOR.retire } }
    case "revoke_unsafe":
      if (state === "revoked") return { ok: true, patch: null }
      if (state === "retired") return { ok: false, code: "terminal", message: "This code is already retired and doesn't route scans, so there is nothing left to turn off." }
      return { ok: true, patch: { is_active: false, retired_at: nowIso, retired_reason: RETIREMENT_FOR.revoke_unsafe } }
  }
}

type QrLifecycleResult = { ok: true; state: QrLifecycleState; changed: boolean } | Refusal

export async function changeQrLifecycle(
  input: { qrCodeId: string; action: QrLifecycleAction; reason?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<QrLifecycleResult> {
  const db: Db = deps.client ?? createServiceClient()
  if (!input?.qrCodeId) return { ok: false, code: "invalid", message: "Choose the code to change." }
  if (!["pause", "resume", "retire", "revoke_unsafe"].includes(input.action)) return { ok: false, code: "invalid", message: "Choose pause, resume, retire or turn off." }
  if (input.action === "revoke_unsafe" && !(input.reason ?? "").trim()) return { ok: false, code: "invalid", message: "Say why the destination is unsafe — it goes on the code's record." }

  const needsRetirement = input.action === "retire" || input.action === "revoke_unsafe"
  let { data, error } = await db.from("qr_codes").select("id, is_active, expires_at, retired_at, retired_reason").eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) {
    if (needsRetirement) return { ok: false, code: "unavailable", message: "Retiring codes isn't switched on for your account yet. Pause the code instead — it stops routing scans right away." }
    ;({ data, error } = await db.from("qr_codes").select("id, is_active, expires_at").eq("id", input.qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  }
  if (error) return { ok: false, code: "refused", message: "We couldn't load this code, so nothing was changed. Try again in a moment." }
  if (!data) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const row = data as { id: string; is_active: boolean | null; expires_at: string | null; retired_at?: string | null; retired_reason?: string | null }
  const before = qrLifecycleState(row)
  const decision = lifecycleTransition(before, input.action, new Date().toISOString())
  if (!decision.ok) return decision
  if (!decision.patch) return { ok: true, state: before, changed: false }
  const patch = decision.patch

  type LifeRun = { kind: "saved" } | { kind: "none" } | { kind: "refused"; message: string } | { kind: "replay" }
  const out = await withActionLedger<LifeRun>(
    {
      brokerageId: actor.brokerageId,
      action: "marketing.qr.lifecycle",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "qr_code", id: row.id },
      reasonCode: "HUMAN_REQUESTED",
      riskClass: "LOW_RISK_WRITE",
      systemSource: "qr_registry",
      detail: { action: input.action, from: before, reason: (input.reason ?? "").trim() || null },
    },
    async () => {
      const { data: written, error: wErr } = await db.from("qr_codes").update(patch).eq("id", row.id).eq("brokerage_id", actor.brokerageId).select("id")
      if (wErr) return { kind: "refused", message: wErr.message }
      return Array.isArray(written) && written.length === 1 ? { kind: "saved" } : { kind: "none" }
    },
    {
      settle: (r) => r.kind === "saved" ? { status: "executed", outcome: input.action, provider: "qr_registry", providerRef: row.id } : { status: "failed", outcome: "write_refused", error: r.kind === "refused" ? r.message : "matched no row" },
      replay: (claim) => (claim.kind === "refused" ? { kind: "refused" as const, message: claim.error } : { kind: "replay" as const }),
    },
    { client: deps.ledgerClient },
  )
  if (out.kind !== "saved") return { ok: false, code: out.kind === "none" ? "not_found" : "refused", message: out.kind === "none" ? "That QR code isn't in your account." : "The change wasn't saved. Nothing was changed; try again in a moment." }
  return { ok: true, state: qrLifecycleState({ ...row, ...patch } as Parameters<typeof qrLifecycleState>[0]), changed: true }
}

// ─── DUPLICATE (a new unique token, the same design) ──────────────────────────

/** Duplicate a code's design ON PURPOSE: the same destination, purpose and context under a NEW unpredictable token —
 *  never the old token (two printed runs stay separately measurable). The source may be retired (that is how a retired
 *  code is "re-printed"); its destination is re-validated as of today. */
export async function duplicateQrDesign(
  input: { sourceQrCodeId: string; idempotencyKey: string; label?: string | null },
  actor: QrActor,
  deps: QrDoorDeps = {},
): Promise<GovernedQrResult> {
  const db: Db = deps.client ?? createServiceClient()
  let { data, error } = await db.from("qr_codes").select("id, label, purpose, destination_type, target_url, slug, listing_id, marketing_campaign_id, mint_context").eq("id", input.sourceQrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (error && isAbsentColumnRefusal(error)) ({ data, error } = await db.from("qr_codes").select("id, label, purpose, destination_type, target_url, slug, listing_id, marketing_campaign_id").eq("id", input.sourceQrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  if (error) return { ok: false, code: "refused", message: "We couldn't load the code to copy, so nothing was created. Try again in a moment." }
  if (!data) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  const src = data as { id: string; label: string; purpose: string | null; destination_type: string | null; target_url: string; slug: string; listing_id: string | null; marketing_campaign_id: string | null; mint_context?: Partial<QrMintContext> | null }
  const ctx = src.mint_context ?? {}
  // The source's own landing is ITS landing — a copy lands on its own (empty target → the minter's default).
  const ownLanding = /\/qr\/[^/?#]+$/.test(src.target_url) && src.target_url.endsWith(`/qr/${src.slug}`)
  const baseLabel = (input.label ?? "").trim() || (qrLabelKind(src.label) === "manual" ? `${src.label} (copy)` : "Copy of an automatic code")
  return mintGovernedQr({
    idempotencyKey: input.idempotencyKey,
    label: baseLabel.slice(0, 120),
    purpose: (isQrPurpose(src.purpose) ? src.purpose : "general"),
    destinationType: isQrDestinationType(src.destination_type) ? src.destination_type : null,
    targetUrl: ownLanding ? null : src.target_url,
    listingId: src.listing_id, marketingCampaignId: src.marketing_campaign_id,
    teamId: ctx.team_id ?? null, locationId: ctx.location_id ?? null, channel: ctx.channel ?? null, source: ctx.source ?? null,
    placement: ctx.placement ?? null, mailLayout: ctx.mail_layout ?? null, assetId: ctx.asset_id ?? null, purposeContext: ctx.purpose_context ?? null,
    consentContext: ctx.consent_context ?? null, tokenScope: ctx.token_scope ?? "per_design", printSizeIn: ctx.print_size_in ?? null,
    trackingEnabled: ctx.tracking !== "disabled", duplicatedFrom: src.id,
  }, actor, deps)
}

// ─── SCAN EVIDENCE (the resolver's permitted context) ─────────────────────────
// TOMBSTONE (152C, same wave): qrScanEvidence lived here first. SURVIVOR: lib/marketing/tracked-qr.ts qrScanEvidence —
// moved beside the minter so the lead-magnet tracker (in the CRM page's module graph) can derive the same evidence without
// pulling this module into that graph; the referring-host reducer is lib/marketing/qr-contract.ts qrReferrerHost.

/** Bot · repeat · human-likely for this scan. The repeat window reads the same visitor key on the same code; before
 *  m946 (no visitor_key column) the read is refused and the class falls back to the browser test alone. */
export async function classifyScanForCode(db: Db, input: { qrCodeId: string; visitorKey: string; userAgent: string | null | undefined; nowMs?: number }): Promise<QrTrafficClass> {
  const now = input.nowMs ?? Date.now()
  const since = new Date(now - QR_REPEAT_WINDOW_MS).toISOString()
  const { data, error } = await db.from("qr_scan_events").select("scanned_at").eq("qr_code_id", input.qrCodeId).eq("visitor_key", input.visitorKey).gte("scanned_at", since).order("scanned_at", { ascending: false }).limit(1)
  if (error && !isAbsentColumnRefusal(error)) console.error("[qr-governance] repeat-window read refused:", error.message)
  const last = Array.isArray(data) && data[0] ? (data[0] as { scanned_at?: string | null }).scanned_at ?? null : null
  return classifyQrScan({ userAgent: input.userAgent, lastSameVisitorScanAt: last, nowMs: now })
}

// ─── ACTIVITY (the board's scan history + aggregate outcomes) ─────────────────

export interface QrActivity {
  summary: QrScanSummary
  recent: Array<{ scannedAt: string | null; trafficClass: string | null; deviceClass: string | null; referrerHost: string | null; linkedToContact: boolean }>
  history: QrDestinationVersion[]
  /** Contacts created through this code's consented landing form (qr_codes.lead_count — the submit door's counter). */
  consentedContacts: number
}

/** Tenant-scoped scan history for one code. Raw scans, filtered visits, unique visitor-days and consented submissions
 *  stay separate; a scan is never shown as a person (no visitor key, no contact id leaves this function). */
export async function loadQrActivity(qrCodeId: string, actor: QrActor, deps: QrDoorDeps = {}): Promise<{ ok: true; activity: QrActivity } | Refusal> {
  const db: Db = deps.client ?? createServiceClient()
  let { data: code, error: codeErr } = await db.from("qr_codes").select("id, lead_count, destination_history").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (codeErr && isAbsentColumnRefusal(codeErr)) ({ data: code, error: codeErr } = await db.from("qr_codes").select("id, lead_count").eq("id", qrCodeId).eq("brokerage_id", actor.brokerageId).maybeSingle())
  if (codeErr) return { ok: false, code: "refused", message: "We couldn't load this code's activity. Try again in a moment." }
  if (!code) return { ok: false, code: "not_found", message: "That QR code isn't in your account." }
  let { data: events, error: evErr } = await db.from("qr_scan_events").select("scanned_at, traffic_class, visitor_key, device_class, contact_id, referrer").eq("qr_code_id", qrCodeId).eq("brokerage_id", actor.brokerageId).order("scanned_at", { ascending: false }).limit(500)
  if (evErr && isAbsentColumnRefusal(evErr)) ({ data: events, error: evErr } = await db.from("qr_scan_events").select("scanned_at, contact_id, referrer").eq("qr_code_id", qrCodeId).eq("brokerage_id", actor.brokerageId).order("scanned_at", { ascending: false }).limit(500))
  if (evErr) return { ok: false, code: "refused", message: "We couldn't load this code's scans. Try again in a moment." }
  const rows = (events ?? []) as Array<{ scanned_at?: string | null; traffic_class?: string | null; visitor_key?: string | null; device_class?: string | null; contact_id?: string | null; referrer?: string | null }>
  const c = code as { lead_count?: number | null; destination_history?: QrDestinationVersion[] | null }
  return {
    ok: true,
    activity: {
      summary: summarizeQrScans(rows),
      // Rows from before wave 152 stored the full referring URL — shown as its HOST only, like every new row.
      // Only values the m946 CHECKs admit are shown (QR_TRAFFIC_CLASSES / QR_DEVICE_CLASSES); anything else reads as unknown.
      recent: rows.slice(0, 25).map((r) => ({
        scannedAt: r.scanned_at ?? null,
        trafficClass: (QR_TRAFFIC_CLASSES as readonly string[]).includes(r.traffic_class ?? "") ? r.traffic_class ?? null : null,
        deviceClass: (QR_DEVICE_CLASSES as readonly string[]).includes(r.device_class ?? "") ? r.device_class ?? null : null,
        referrerHost: qrReferrerHost(r.referrer),
        linkedToContact: !!r.contact_id,
      })),
      history: Array.isArray(c.destination_history) ? c.destination_history : [],
      consentedContacts: c.lead_count ?? 0,
    },
  }
}
