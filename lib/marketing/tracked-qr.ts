/**
 * lib/marketing/tracked-qr.ts
 *
 * ★ THE ONE QR MINTER ★ — the single writer of `qr_codes` for the whole tree.
 *
 * A census found NINE distinct creation paths writing this table with different slug recipes,
 * different (or absent) idempotency, and inconsistent column coverage — so the same listing could
 * carry two tracked codes that could not see each other, and `expires_at` /
 * `marketing_campaign_id` had one writer and zero writers respectively. Every one of those paths
 * now routes THROUGH this function. See the CONSOLIDATED-INTO-THIS-FILE block at the bottom for
 * what died and what was merged in first.
 *
 * Reuses the existing qr_codes + qr_scan_events tables and the dynamic /api/qr/scan?slug=
 * resolver (the printed/encoded slug never goes stale). WAVE 152 (lane 152C): the slug is an
 * UNPREDICTABLE token (mintQrToken), and every row carries its provenance (m945: created_by_user_id,
 * mint_context, destination_history) — the governed doors live in lib/marketing/qr-governance.ts.
 *
 * IDEMPOTENT per `label` (the deterministic "(entity, kind)" key): a re-render / re-generate /
 * re-launch reuses the SAME tracked code so scans accrue to one row. NEVER throws — an asset must
 * still render without a QR (returns null → caller skips the badge).
 *
 * TWO URLs, DO NOT CONFUSE THEM:
 *   • scanUrl      — `${origin}/api/qr/scan?slug=…`. THIS is what the PNG encodes. Always.
 *   • target_url   — the SEMANTIC destination the code stands for (the listing page, the magnet
 *                    landing, whatever the agent typed). Stored for display + editing; it is what
 *                    the QR management surfaces show as "where this points". This module used to
 *                    overwrite it with the scan URL after insert, which made every survivor-minted
 *                    row self-referential and destroyed the caller's destination — so routing the
 *                    remaining minters here would have LOST the URL their users typed. It no
 *                    longer does that. When a caller supplies no target, target_url falls back to
 *                    the public QR landing `${origin}/qr/<slug>` (set in the insert itself since wave
 *                    152 — the token is drawn before the row is written).
 *
 * LIVE CHECK VOCABULARIES (hrvaqgvukzxfskkcrwbt, verified — a value outside these is a REFUSED
 * insert, and supabase-js resolves that refusal, it does not throw):
 *   destination_type ∈ {anniversary_video, book_meeting, cma_form, landing_page, listing_detail,
 *                       other, podcast_episode, video_avatar_tour}  (NULL allowed)
 *   purpose          ∈ {business_card, campaign, event, general, lead_capture, lead_magnet,
 *                       listing, listing_inquiry, open_house}       (NULL allowed)
 */
import "server-only"
import QRCode from "qrcode"
import { randomBytes, createHash } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
// THE ENCODING CONTRACT (wave 141F): quiet zone, error correction, contrast — one option
// builder every encoder (server + client) shares. lib/marketing/qr-contract.ts is pure.
// WAVE 152 (lane 152C): the token shape and the mint provenance shape live there too.
import { qrEncodeOptions, QR_RENDER_DEFAULTS, QR_TOKEN_SHAPE, qrLabelKind, isAbsentColumnRefusal, qrDeviceClass, coarseNetworkPrefix, qrReferrerHost, type QrMintContext, type QrDestinationVersion, type QrDeviceClass } from "./qr-contract"

type AnyClient = ReturnType<typeof createServiceClient>

const ORIGIN_FALLBACK = "https://app.vipagentos.com"

export function normalizeOrigin(origin?: string | null): string {
  return (origin ?? process.env.NEXT_PUBLIC_APP_URL ?? ORIGIN_FALLBACK).replace(/\/$/, "")
}

/** qr_codes.destination_type CHECK (m148) — the FULL live vocabulary. */
export type QrDestinationType =
  | "anniversary_video"
  | "book_meeting"
  | "cma_form"
  | "landing_page"
  | "listing_detail"
  | "other"
  | "podcast_episode"
  | "video_avatar_tour"

/** qr_codes.purpose CHECK — the FULL live vocabulary. */
export type QrPurpose =
  | "business_card"
  | "campaign"
  | "event"
  | "general"
  | "lead_capture"
  | "lead_magnet"
  | "listing"
  | "listing_inquiry"
  | "open_house"

export const QR_DESTINATION_TYPES: readonly QrDestinationType[] = [
  "anniversary_video", "book_meeting", "cma_form", "landing_page",
  "listing_detail", "other", "podcast_episode", "video_avatar_tour",
] as const

export const QR_PURPOSES: readonly QrPurpose[] = [
  "business_card", "campaign", "event", "general", "lead_capture",
  "lead_magnet", "listing", "listing_inquiry", "open_house",
] as const

export function isQrDestinationType(v: unknown): v is QrDestinationType {
  return typeof v === "string" && (QR_DESTINATION_TYPES as readonly string[]).includes(v)
}
export function isQrPurpose(v: unknown): v is QrPurpose {
  return typeof v === "string" && (QR_PURPOSES as readonly string[]).includes(v)
}

// ─── OWNER: PLATFORM vs TENANT (wave 81D) ────────────────────────────────────
// Owner verbatim: "the qrcode system agent needs to make sure that any qrcode
// that gets created for assets are added to the qrcode management which is
// wired to the platform if used for platform or tenants dashboard."
//
// qr_codes IS the QR management registry — THE ONE survivor — and this minter
// is its only writer, so "added to the management" is satisfied by
// construction for every emitter that mints here (scripts/qr-registry-guard.ts
// is the sweep that proves no emitter encodes a QR image outside it). WHO owns
// a code is the row's brokerage_id: a tenant's code carries its brokerage and
// shows on that tenant's board (app/dashboard/agent/qr-codes); a PLATFORM code
// (the platform's own marketing — its prospect funnel, its business cards)
// carries NO brokerage and shows on the platform board
// (app/dashboard/superadmin/qr-codes), which also sees every tenant's codes
// because platform staff see all tenants (CLAUDE.md §4).
//
// LIVE FACT (hrvaqgvukzxfskkcrwbt, 2026-09-24): qr_codes.brokerage_id was NOT
// NULL until supabase/migrations/m664-qr-codes-platform-owner.sql was APPLIED
// LIVE the same day (nullable now, CHECK brokerage_id IS NOT NULL OR label LIKE
// 'platform:%'). A refused platform mint (any future refusal) stays honest
// (null → the caller skips the badge), never a fabricated row under some tenant's id.
export type QrOwnerKind = "platform" | "tenant"
/** Every platform-owned label carries this prefix so the idempotency key can
 *  never collide with a tenant's label of the same text. */
export const PLATFORM_QR_LABEL_PREFIX = "platform:"

/** PURE: who owns a qr_codes row — the brokerage, or the platform when the row
 *  carries none. The ONE classifier both boards read. */
export function qrOwnerKind(row: { brokerage_id?: string | null }): QrOwnerKind {
  return row.brokerage_id ? "tenant" : "platform"
}

// ─── CANONICAL IDEMPOTENCY KEYS ──────────────────────────────────────────────
// The whole point of the merge: two paths minting for the SAME entity must produce the SAME key,
// or they cannot see each other and both mint. Any new minter for one of these entities MUST use
// the helper, not a hand-rolled string.

/** ONE key for every listing QR — used by BOTH app/actions/listings-kernel.ts:launchListing and
 *  lib/orchestrator/internal.ts:handleListingLive, which used to dedupe on different columns. */
export function listingQrLabel(listingId: string): string {
  return `listing:${listingId}`
}

/** ONE key for every open-house QR (app/actions/seller-open-house.ts). Replaces the deterministic
 *  `oh-<eventId>` SLUG that used to carry that role via an upsert-on-slug. */
export function openHouseQrLabel(eventId: string): string {
  return `open_house:${eventId}`
}

export interface MintTrackedQrArgs {
  /** The owning tenant. REQUIRED for a tenant code; ignored (written null)
   *  for a platform code (`owner: "platform"`). */
  brokerageId: string | null
  /** Who owns the code (default "tenant"). A platform code carries no
   *  brokerage and a `platform:`-prefixed label — see the OWNER block above. */
  owner?: QrOwnerKind
  /** agents.id (qr_codes.agent_id FK → agents.id) — nullable for brokerage-level material. */
  agentId?: string | null
  /** Deterministic idempotency key, e.g. `material:listing_flyer:<listingId>`.
   *  NOTE: `qr_codes` has ONE text column for this, so the key IS the stored label. There is no
   *  separate display name — the QR surfaces resolve the human description from `listing_id` /
   *  `marketing_campaign_id`, which every row now carries. A prettier label is not worth a key
   *  that moves when a listing's address is corrected. */
  label: string
  /** m148 destination_type — MUST be an enum-valid value (or null). */
  destinationType?: QrDestinationType | null
  /** The SEMANTIC URL this code stands for. Omit → defaults to the public `/qr/<slug>` landing. */
  targetUrl?: string | null
  listingId?: string | null
  /** ★ TRACKING LINKED TO CAMPAIGN ★ qr_codes.marketing_campaign_id (FK marketing_campaigns).
   *  Stamp this whenever the code is minted in a marketing-campaign context — it is what
   *  lib/marketing/campaign-measurer.ts aggregates scans over. */
  marketingCampaignId?: string | null
  /** qr_codes.expires_at (timestamptz ISO string). */
  expiresAt?: string | null
  purpose?: QrPurpose
  origin?: string
  /** WAVE 152 (152C) — qr_codes.created_by_user_id: the SESSION user who minted it (users.id, never agents.id). */
  createdByUserId?: string | null
  /** WAVE 152 (152C) — provenance merged into qr_codes.mint_context (channel, placement, asset, office/team, consent
   *  context, token scope, print size, tracking). The minter always stamps minted_via / label_kind / token_scope. */
  mintContext?: Partial<QrMintContext> | null
  /**
   * WAVE 152 (152C) — a GOVERNED mint (lib/marketing/qr-governance.ts mintGovernedQr) is unique per IDEMPOTENCY KEY
   * (the action ledger holds it), not per label: two people may name two codes "Spring flyer" and get two codes. It
   * skips the label reuse and REFUSES rather than degrade when the provenance columns are absent.
   */
  governed?: boolean
}

export interface MintedTrackedQr {
  qrCodeId: string
  slug: string
  /** the /api/qr/scan?slug= URL the PNG actually encodes. */
  scanUrl: string
  /** the SEMANTIC destination stored on the row (what the QR "means"). */
  targetUrl: string
  /** data:image/png;base64,... ready for an <Img> / print template. */
  qrCodeDataUrl: string
  destinationType: QrDestinationType | null
  /** true when THIS call minted a new row (vs. reusing an existing tracked code). */
  created: boolean
}

/** PNG encode of any URL. The ONLY QR image source in the tree — no third-party HTTP renderer.
 *  Options come from the one contract (lib/marketing/qr-contract.ts): a 4-module quiet zone
 *  (this used to pass `margin: 1`, a quarter of the spec's quiet zone, on every printed piece),
 *  error correction M, black on white. */
export async function renderQrPng(url: string, width: number = QR_RENDER_DEFAULTS.printWidth): Promise<string> {
  return QRCode.toDataURL(url, qrEncodeOptions(width))
}

/**
 * WAVE 152 (152C) — THE TOKEN. An unpredictable slug drawn from the CSPRNG: 22 symbols of a 32-symbol alphabet (each
 * byte mod 32 — 256 is a multiple of 32, so no symbol is favored). NOT derived from the label: the label is a
 * server-side key (`pre_listing_kit:<contactId>`, `estimate_comparison:<street-address>`, …) and the slug is printed on
 * paper, so a Contact id or an address never reaches the scanned URL. The old recipe (label + Date.now() base36) was
 * guessable from the label and the minute. Codes minted before keep their slugs and keep resolving (the resolver
 * looks up by slug, whatever its shape).
 */
function mintQrToken(): string {
  const bytes = randomBytes(QR_TOKEN_SHAPE.length)
  let out = ""
  for (let i = 0; i < QR_TOKEN_SHAPE.length; i++) out += QR_TOKEN_SHAPE.alphabet[bytes[i] % QR_TOKEN_SHAPE.alphabet.length]
  return out
}

/**
 * WAVE 152 (152C) — WHAT ONE SCAN MAY RECORD: a coarse device class, the referring HOST only, and a visitor key — a
 * one-way hash of (code, UTC day, coarse network /24·/48, browser string), so the same phone on the same day reads as
 * one visitor of THIS code and nothing more. The raw IP and the full browser string are never stored, and the key cannot
 * follow a person across codes or days. Lives beside the minter (not in lib/marketing/qr-governance.ts) so every scan
 * writer — the scan door and the lead-magnet tracker, both already in the CRM page's module graph — derives the same
 * evidence without adding a module to that graph (test:proxy-graph-budget).
 */
export function qrScanEvidence(input: { qrCodeId: string; ip: string | null | undefined; userAgent: string | null | undefined; referrer: string | null | undefined; nowMs?: number }): { visitorKey: string; deviceClass: QrDeviceClass; referrerHost: string | null } {
  const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10)
  const visitorKey = createHash("sha256").update(`${input.qrCodeId}|${day}|${coarseNetworkPrefix(input.ip)}|${(input.userAgent ?? "").trim()}`).digest("hex").slice(0, 32)
  return { visitorKey, deviceClass: qrDeviceClass(input.userAgent), referrerHost: qrReferrerHost(input.referrer) }
}

export async function mintTrackedQr(
  args: MintTrackedQrArgs,
  client?: AnyClient,
): Promise<MintedTrackedQr | null> {
  try {
    const owner: QrOwnerKind = args.owner ?? "tenant"
    if (!args.label) return null
    if (owner === "tenant" && !args.brokerageId) return null
    if (args.destinationType && !isQrDestinationType(args.destinationType)) return null
    if (args.purpose && !isQrPurpose(args.purpose)) return null
    // A platform code's key is namespaced so it can never collide with (or be
    // reused by) a tenant label of the same text.
    const label = owner === "platform" && !args.label.startsWith(PLATFORM_QR_LABEL_PREFIX) ? `${PLATFORM_QR_LABEL_PREFIX}${args.label}` : args.label
    const brokerageId = owner === "platform" ? null : args.brokerageId

    const svc: AnyClient = client ?? createServiceClient()
    const origin = normalizeOrigin(args.origin)

    // 1. Reuse an existing tracked code for this (entity, kind).
    //    A FAILED lookup must NOT read as "no code yet" — that mints a duplicate on every
    //    re-run, each with its own globally-unique slug, which is exactly the drift this
    //    consolidation exists to end. supabase-js RESOLVES refusals, so destructure the error.
    //    The owner predicate is EXPLICIT on both branches: a tenant's key is looked up under
    //    its brokerage, a platform key under brokerage_id IS NULL — never every tenant.
    //    WAVE 152 (152C): a GOVERNED mint skips this — its idempotency is the action ledger's key
    //    (lib/marketing/qr-governance.ts), so two distinct requests under one display label are two codes.
    let existing: { id?: string; slug?: string; target_url?: string | null; destination_type?: string | null; listing_id?: string | null; marketing_campaign_id?: string | null; expires_at?: string | null } | null = null
    if (!args.governed) {
      let lookup = svc
        .from("qr_codes")
        .select("id, slug, target_url, destination_type, listing_id, marketing_campaign_id, expires_at")
        .eq("label", label)
        .eq("is_active", true)
      lookup = brokerageId ? lookup.eq("brokerage_id", brokerageId) : lookup.is("brokerage_id", null)
      const { data: found, error: lookupError } = await lookup.maybeSingle()

      if (lookupError) {
        console.error("[mintTrackedQr] idempotency lookup refused — refusing to mint a duplicate:", lookupError.message)
        return null
      }
      existing = found
    }

    let qrCodeId: string
    let slug: string
    let targetUrl: string
    let destinationType: QrDestinationType | null = args.destinationType ?? null
    let created = false

    if (existing?.id && existing?.slug) {
      qrCodeId = existing.id as string
      slug = existing.slug as string
      targetUrl = (existing.target_url as string) ?? `${origin}/qr/${slug}`
      destinationType = (existing.destination_type as QrDestinationType | null) ?? destinationType

      // ENRICH-ON-REUSE, never clobber. The agent may have re-pointed target_url by hand, and the
      // first campaign a code was minted under owns its attribution — so only NULL columns are
      // backfilled from the new call. This is how a listing QR minted by the orchestrator picks up
      // the destination_type / campaign the later marketing path knows about.
      const backfill: Record<string, unknown> = {}
      if (!existing.destination_type && args.destinationType) backfill.destination_type = args.destinationType
      if (!existing.listing_id && args.listingId) backfill.listing_id = args.listingId
      if (!existing.marketing_campaign_id && args.marketingCampaignId) backfill.marketing_campaign_id = args.marketingCampaignId
      if (!existing.expires_at && args.expiresAt) backfill.expires_at = args.expiresAt
      if (Object.keys(backfill).length > 0) {
        const { error: backfillError } = await svc.from("qr_codes").update(backfill).eq("id", qrCodeId)
        if (backfillError) {
          console.error("[mintTrackedQr] reuse backfill refused:", backfillError.message)
        } else if (backfill.destination_type) {
          destinationType = backfill.destination_type as QrDestinationType
        }
      }
    } else {
      // 2. Mint a fresh tracked row under a NEW UNPREDICTABLE TOKEN (wave 152, 152C — mintQrToken above).
      // TOMBSTONE (152C): the slug used to be `${label lower-cased, 40 chars}-${Date.now().toString(36)}` and the
      // target_url a `${origin}/qr` placeholder PATCHED to `/qr/<slug>` after the insert. The token is now drawn
      // BEFORE the insert, so the row lands complete in one write (no patch — and m945's history trigger never sees
      // a target change that has no version). SURVIVOR: mintQrToken + the single insert below.
      const suppliedTarget = (args.targetUrl ?? "").trim() || null
      const mintedAt = new Date().toISOString()
      const context: QrMintContext = {
        token_scope: "per_design",
        tracking: "enabled",
        ...(args.mintContext ?? {}),
        minted_via: args.governed ? "governed" : "automated",
        label_kind: qrLabelKind(label),
      }

      let inserted: { id?: string; slug?: string } | null = null
      let insertedTarget: string | null = null
      for (let attempt = 0; attempt < 2 && !inserted; attempt++) {
        const newSlug = mintQrToken()
        const target = suppliedTarget ?? `${origin}/qr/${newSlug}`
        const firstVersion: QrDestinationVersion = { version: 1, target_url: target, destination_type: args.destinationType ?? null, kind: "minted", changed_at: mintedAt, changed_by_user_id: args.createdByUserId ?? null, reason: null }
        const base = {
          // null ONLY for a platform-owned code (label platform:… — m664 applied 2026-09-24;
          // a refusal stays an honest null result, never a row filed under some tenant).
          brokerage_id: brokerageId,
          agent_id: args.agentId ?? null,
          label,
          // target_url is NOT NULL — the semantic URL when we have one, else this code's own public landing.
          target_url: target,
          purpose: args.purpose ?? "campaign",
          destination_type: args.destinationType ?? null,
          slug: newSlug,
          listing_id: args.listingId ?? null,
          marketing_campaign_id: args.marketingCampaignId ?? null,
          expires_at: args.expiresAt ?? null,
          is_active: true,
          scan_count: 0,
          lead_count: 0,
        }
        // m945 provenance — creator, mint context and the first destination version — on EVERY code.
        let { data, error } = await svc
          .from("qr_codes")
          .insert({ ...base, created_by_user_id: args.createdByUserId ?? null, mint_context: context, destination_history: [firstVersion] })
          .select("id, slug")
          .maybeSingle()
        // DEGRADES SAFELY until m945 is applied (the action ledger's precedent): an AUTOMATED mint — a listing launch,
        // a postcard, an open house — must not lose its code to a missing provenance column, so it is re-written once
        // without them and says so. A GOVERNED mint refuses: its provenance is the point of the request.
        if (error && isAbsentColumnRefusal(error) && !args.governed) {
          console.error("[mintTrackedQr] provenance columns absent (m945 not applied) — minted WITHOUT creator/context/history:", error.message)
          ;({ data, error } = await svc.from("qr_codes").insert(base).select("id, slug").maybeSingle())
        }
        if (error) {
          // 23505 on slug: a token collision (≈ 2^-110) — draw again once; anything else is a refusal.
          if (error.code === "23505" && /slug/.test(error.message ?? "") && attempt === 0) continue
          console.error("[mintTrackedQr] insert refused:", error.message)
          return null
        }
        inserted = data as { id?: string; slug?: string } | null
        if (inserted?.id) insertedTarget = target
      }

      if (!inserted?.id || !inserted?.slug || !insertedTarget) return null
      targetUrl = insertedTarget
      qrCodeId = inserted.id as string
      slug = inserted.slug as string
      created = true
    }

    const scanUrl = `${origin}/api/qr/scan?slug=${slug}`
    const qrCodeDataUrl = await renderQrPng(scanUrl)

    return { qrCodeId, slug, scanUrl, targetUrl, qrCodeDataUrl, destinationType, created }
  } catch {
    return null
  }
}

// ─── CONSOLIDATED INTO THIS FILE in the QR merge (wave Q) ────────────────────
//
// The following creation paths were MERGED-THEN-DELETED. Each one's raw insert is gone; each
// call site now calls mintTrackedQr. What each contributed BEFORE it died:
//
//   • lib/kernel/marketing.ts:createQrAsset — DELETED outright (orphan export, zero callers).
//     It was the SOLE writer of `qr_codes.expires_at`, so that column would have become dead
//     schema. `expiresAt` moved here and is now reachable from createQrCodeAction and the admin
//     POST route, which is more callers than it ever had.
//
//   • app/actions/marketing-studio.ts:createQrCodeAction — insert deleted, action kept as the
//     session gate. It was NOT idempotent and never set destination_type. It contributed the
//     slug recipe (kept above) and the browser-facing param shape.
//
//   • app/api/admin/qr-codes/route.ts POST — insert deleted. Contributed the destination_type
//     validation set and the app-hosted default-URL table (both kept in that route).
//
//   • lib/kernel/lead-magnets.ts:publishLeadMagnet + :generateQRCode, and
//     app/actions/lead-magnets-actions.ts:generateQRCodeAction — THREE lead-magnet minters with
//     THREE dedupe keys (none / target_url / none). Collapsed to ONE key: `lead_magnet:<magnetId>`.
//     generateQRCodeAction contributed destination_type 'landing_page', which the other two lacked.
//
//   • app/actions/listings-kernel.ts:launchListing and lib/orchestrator/internal.ts:
//     handleListingLive — TWO listing minters deduping on DIFFERENT keys
//     ((listing_id,brokerage_id,purpose) vs (brokerage_id,target_url)), so neither could see the
//     other and both minted for the same listing. Collapsed to ONE key: `listing:<listingId>`.
//     listings-kernel contributed the "a failed lookup must not read as no-code-yet" rule, which
//     is now enforced here for every caller.
//
//   • app/actions/seller-open-house.ts:createQrCodeForEvent — upsert-on-slug deleted. Its
//     deterministic `oh-<eventId>` slug was its idempotency; that role moved to the label
//     `open_house:<eventId>`.
//
// BUILT here, not merged: `marketing_campaign_id`. It is an FK to marketing_campaigns that had
// ZERO writers in the tree, which is why lib/marketing/campaign-measurer.ts always reported 0
// scans for every campaign. It is a FORWARD link and is NOT the same thing as
// direct_mail_campaigns.qr_code_id, which is a separate reverse link that already worked.
