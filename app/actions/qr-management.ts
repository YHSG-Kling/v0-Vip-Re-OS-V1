'use server'

// QR MANAGEMENT — the READ side of the QR manager, plus the one management
// write the surface needs (pause / resume).
//
// OWNER RULING, verbatim: "qr codes need a page to keep an eye on all active,
// inactive codes or creating a qr code manually plus tracking linked to
// campaign."
//
// ONE PAGE, ROLE-SCOPED DATA. /dashboard/agent/qr-codes is the one tenant board for every
// seat — a solo subscriber, an agent seat, a team lead, an office head and an account admin.
// WAVE 153 (lane 153E): the scope is lib/marketing/qr-governance.ts resolveQrAuthority —
//   · the seat must be live (not suspended, not a revoked agent record)
//   · a SOLO-plan subscriber            → their whole account (tier parity)
//   · tenant leadership / single-office tenant admin → every code in the account
//   · an office head                    → their offices' codes (multi-location)
//   · the LEAD of a team                → that team's codes
//   · everyone else                     → the codes they created or that are filed to them
// and the governed doors enforce the SAME answer, so the list and the actions never disagree.
// 'superadmin' is absent because it is dead as users.user_type; platform staff reach a tenant
// through the act-as seam and arrive carrying the tenant's own user_type.
//
// TEAM IS A FACT, NOT A SEAT: leading a team is `teams.team_lead_id = users.id`
// (lib/kernel/resolve-user-office.ts resolveViewerHierarchy), the same anchor m473 put on
// every RLS lane. A user_type 'team_lead' who leads no team row leads nothing.
//
// GATE-THEN-SERVICE: the reads run on the service client because a team lead and
// a broker must see codes minted by OTHER agents, and qr_codes' RLS is written
// for the owner. The gate written here is therefore the only gate — every query
// below carries `.eq('brokerage_id', ctx.brokerageId)` from the SESSION, never
// from an argument.

import { createServiceClient } from '@/lib/supabase/service'
import { resolveActingContext, resolveWriteContext } from '@/lib/platform/acting-context'
// WAVE 152 (lane 152C): the governed lifecycle / duplicate / activity doors and the one lifecycle classifier. This file
// stays the board's SESSION gate (tenant from the session, read-only impersonation refused) in front of them.
// WAVE 153 (lane 153E): + the ONE QR authority and the board's scoped reads (codes in scope, link pickers).
import { changeQrLifecycle, duplicateQrDesign, loadQrActivity, resolveQrAuthority, listQrCodesInScope, loadQrLinkTargets, type QrActor, type QrLifecycleAction, type QrActivity } from '@/lib/marketing/qr-governance'
import { qrLifecycleState, type QrLifecycleState, type QrMintContext, type QrDestinationVersion } from '@/lib/marketing/qr-contract'

/**
 * The name a human reads on the board, resolved from the row's own subject.
 *
 * A label of the form `<kind>:<uuid>` is an IDEMPOTENCY KEY, not a title — it is
 * what stops a second mint for the same listing/open house/magnet creating a
 * second code. A label WITHOUT that shape was typed by a person on the manual
 * create form, and is the best name there is. So: prefer the subject we can
 * name (the listing address, then the campaign), fall back to the typed label,
 * and only ever show a bare key if the subject row has since been deleted —
 * in which case the key is genuinely all that is left, and saying so beats
 * inventing a title.
 *
 * NOT EXPORTED. This file carries "use server", and Next.js requires every
 * export of such a module to be an async Server Action — a non-async export
 * fails the production build (it compiles fine under tsc, which is why the
 * type-check missed it). Making it async to satisfy that rule would be worse
 * than wrong: it is a pure naming function called once per row, and turning it
 * into a Server Action would put a network round-trip behind a string. Its only
 * caller is loadQrCodesForCaller below, so module-private is both the fix and
 * the honest shape.
 */
function qrDisplayName(input: {
  label: string
  listingLine: string | null
  campaignName: string | null
}): string {
  const isGeneratedKey = /^[a-z_]+:[0-9a-f-]{8,}$/i.test(input.label)
  if (!isGeneratedKey) return input.label
  if (input.listingLine) return input.listingLine
  if (input.campaignName) return input.campaignName
  return input.label
}

/** NOT EXPORTED (same reason as qrDisplayName above): the board's wave-152 provenance + lifecycle fields for one row. */
function provenanceOf(c: Record<string, any>, creatorNames: Map<string, string>): Pick<QrManagerCode,
  'lifecycle_state' | 'token_scope' | 'placement' | 'mail_layout' | 'tracking' | 'print_size_in' | 'consent_context' | 'destination_versions' | 'creator_name'> {
  const ctx = (c.mint_context ?? {}) as Partial<QrMintContext>
  const history = Array.isArray(c.destination_history) ? (c.destination_history as QrDestinationVersion[]) : []
  return {
    lifecycle_state:      qrLifecycleState(c),
    token_scope:          ctx.token_scope ?? null,
    placement:            ctx.placement ?? null,
    mail_layout:          ctx.mail_layout ?? null,
    tracking:             ctx.tracking === 'disabled' ? 'disabled' : 'enabled',
    print_size_in:        typeof ctx.print_size_in === 'number' ? ctx.print_size_in : null,
    consent_context:      ctx.consent_context ?? null,
    destination_versions: history.length,
    creator_name:         c.created_by_user_id ? creatorNames.get(c.created_by_user_id) ?? null : null,
  }
}

/** WAVE 153 (153E): + 'office' — an office head on a multi-location account manages their offices' codes. 'brokerage' is
 *  the whole-account scope (a solo subscriber's whole business included); the label the board prints says which. */
export type QrScopeKind = 'agent' | 'team' | 'office' | 'brokerage'

export interface QrManagerCode {
  id:                   string
  slug:                 string
  label:                string
  purpose:              string | null
  target_url:           string | null
  destination_type:     string | null
  listing_id:           string | null
  scan_count:           number
  lead_count:           number
  is_active:            boolean
  created_at:           string
  /** m-era column, never enforced until /api/qr/scan started checking it. */
  expires_at:           string | null
  marketing_campaign_id: string | null
  /** FORWARD link: marketing_campaigns.campaign_name via qr_codes.marketing_campaign_id. */
  campaign_name:        string | null
  /** REVERSE link: direct_mail_campaigns.campaign_name via direct_mail_campaigns.qr_code_id. */
  mail_campaign_name:   string | null
  agent_id:             string | null
  /** Owner's display name — only meaningful above agent scope. */
  agent_name:           string | null
  /** What the board renders: the subject's own name, never a bare idempotency key. */
  display_name:         string
  /** WAVE 152 (152C) — the ONE lifecycle classifier's answer (active · paused · expired · retired · revoked). */
  lifecycle_state:      QrLifecycleState
  /** Provenance (m945 mint_context): token scope, placement, mail layout, tracking, print size, consent context. Null
   *  where the code was minted before wave 152 or the field was not stated — shown as "not recorded", never guessed. */
  token_scope:          string | null
  placement:            string | null
  mail_layout:          string | null
  tracking:             'enabled' | 'disabled'
  print_size_in:        number | null
  consent_context:      string | null
  /** How many destination versions the code has (1 = never changed; 0 = minted before version history). */
  destination_versions: number
  /** The person who minted it (m945 created_by_user_id → users name), null for an automatic or older code. */
  creator_name:         string | null
  /** WAVE 153 (153E): the viewer minted this code themselves (the board's "Only codes I created" filter). */
  created_by_me:        boolean
}

/** WAVE 153 (153E): one placement's codes, RAW scans and consented Contacts (never pooled across placements). */
export interface QrPlacementRollup {
  placement:         string
  codeCount:         number
  rawScans:          number
  consentedContacts: number
}

/** WAVE 153 (153E): a listing a new code may be linked to — only listings the viewer may put a code on. */
export interface QrLinkableListing {
  id:     string
  line:   string
  status: string | null
}

export interface QrCampaignRollup {
  campaignId:   string
  campaignName: string
  codeCount:    number
  scans:        number
  leads:        number
}

export interface QrLinkableCampaign {
  id:   string
  name: string
}

export type QrManagerData =
  | {
      ok: true
      scope:      QrScopeKind
      scopeLabel: string
      codes:      QrManagerCode[]
      /** Scans/leads rolled up by the FORWARD campaign link only. */
      campaigns:  QrCampaignRollup[]
      /** The campaigns a new code may be linked to (the viewer's own, shared with their team or the whole account). */
      linkableCampaigns: QrLinkableCampaign[]
      /** WAVE 153 (153E): the listings a new code may be linked to (own, or in a team / office the viewer leads). */
      linkableListings: QrLinkableListing[]
      /** WAVE 153 (153E): raw scans + consented Contacts per placement. */
      placements: QrPlacementRollup[]
      /** WAVE 153 (153E): why this scope (the facts / grants that decided it). */
      scopeBasis: string[]
      /** WAVE 153 (153E): every seat that can see the board can create codes (filed to their own record, or to none). */
      canCreate: true
    }
  | { ok: false; error: string }


/**
 * Every QR code the caller is entitled to see, with both campaign linkages
 * resolved and a per-campaign scan rollup.
 */
export async function loadQrCodesForCaller(): Promise<QrManagerData> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? 'Not authenticated' }
  if (!ctx.brokerageId) {
    return { ok: false, error: 'Your sign-in isn\'t attached to an account yet, so QR codes aren\'t available. Finish your account setup, then try again.' }
  }

  const svc = createServiceClient()
  const brokerageId = ctx.brokerageId

  // WAVE 153 (lane 153E) — ONE AUTHORITY FOR THE LIST AND EVERY DOOR. Owner (verbatim, 2026-11-14): "qr codes can be
  // used by tenant and seat holders. you redid the qr code section for brokerage/teams but agents and solo agent tenants
  // use qr codes."
  // TOMBSTONE: the inline SCOPE LADDER that lived here (BROKERAGE_SCOPE_ROLES by user_type → whole brokerage; a led team
  // → that team's agents; else the caller's own agents row, REFUSING a seat without one). It disagreed with the doors —
  // they let ANY seat change ANY code in the account — it never saw a SOLO subscriber whose one seat is user_type
  // 'agent' as owning their whole account (their automatic, agent-less codes were invisible to them), it had no office
  // scope for a multi-location tenant, and it hid codes a person CREATED but filed elsewhere. SURVIVOR:
  // lib/marketing/qr-governance.ts resolveQrAuthority (seat · solo plan · resolveViewerHierarchy) + listQrCodesInScope,
  // the same answer the mint / edit / lifecycle / duplicate / activity doors now enforce.
  const actor: QrActor = { brokerageId, userId: ctx.userId, agentId: ctx.agentId ?? null, userType: ctx.userType }
  const authority = await resolveQrAuthority(actor, { client: svc })
  if (!authority.ok) return { ok: false, error: authority.message }
  const auth = authority.authority
  const scope: QrScopeKind = auth.kind === 'tenant' ? 'brokerage' : auth.kind === 'offices' ? 'office' : auth.kind === 'teams' ? 'team' : 'agent'
  const scopeLabel = auth.kind === 'tenant'
    ? (auth.solo ? 'Every QR code in your business' : 'Every QR code in your account')
    : auth.kind === 'offices' ? "QR codes for the offices you lead"
    : auth.kind === 'teams' ? "Your team's QR codes"
    : 'Your QR codes'

  const listed = await listQrCodesInScope(actor, auth, { client: svc })
  if (!listed.ok) return { ok: false, error: listed.message }
  // The campaigns and listings a NEW code can be linked to — the same rules the mint enforces. Fetched whether or not any
  // codes exist: the first code an agent mints is the one most worth linking.
  const targets = await loadQrLinkTargets(actor, auth, { client: svc })
  const linkableCampaigns: QrLinkableCampaign[] = targets.campaigns
  const linkableListings: QrLinkableListing[] = targets.listings
  const shared = { scope, scopeLabel, scopeBasis: auth.basis, canCreate: true as const, linkableCampaigns, linkableListings }

  const codeRows = listed.rows as Array<Record<string, any>>
  if (codeRows.length === 0) {
    return { ok: true, ...shared, codes: [], campaigns: [], placements: [] }
  }

  // ── Campaign linkage, BOTH directions, kept apart on purpose ───────────────
  // qr_codes.marketing_campaign_id is the FORWARD link (the marketing campaign
  // this code belongs to). direct_mail_campaigns.qr_code_id is the REVERSE link
  // (the mail piece that carries this code) — a different fact, and the one the
  // scan route already attributes against. Neither stands in for the other, so
  // the page shows both rather than a single "campaign" that would be a guess.
  const campaignIds = [...new Set(codeRows.map((c) => c.marketing_campaign_id).filter(Boolean))] as string[]
  const campaignNames = new Map<string, string>()
  if (campaignIds.length > 0) {
    const { data: campaigns, error: campaignsError } = await svc
      .from('marketing_campaigns')
      .select('id, campaign_name')
      .eq('brokerage_id', brokerageId)
      .in('id', campaignIds)
    if (campaignsError) {
      console.error('[qr-management] campaign names not resolved:', campaignsError.message)
    }
    for (const c of (campaigns ?? []) as Array<{ id: string; campaign_name: string | null }>) {
      campaignNames.set(c.id, c.campaign_name ?? 'Untitled campaign')
    }
  }

  const mailNames = new Map<string, string>()
  {
    const { data: mail, error: mailError } = await svc
      .from('direct_mail_campaigns')
      .select('id, campaign_name, qr_code_id')
      .eq('brokerage_id', brokerageId)
      .in('qr_code_id', codeRows.map((c) => c.id))
    if (mailError) {
      console.error('[qr-management] direct-mail linkage not resolved:', mailError.message)
    }
    for (const m of (mail ?? []) as Array<{ campaign_name: string | null; qr_code_id: string | null }>) {
      if (m.qr_code_id) mailNames.set(m.qr_code_id, m.campaign_name ?? 'Untitled mail campaign')
    }
  }

  // ── Listing addresses, for the DISPLAY NAME ────────────────────────────────
  // `label` stopped being a human name when the mint paths were collapsed onto
  // one idempotency key: an auto-minted listing code is labelled
  // `listing:<uuid>`, an open house `open_house:<uuid>`, a magnet
  // `lead_magnet:<uuid>`. That key is correct — it is what makes a second mint
  // for the same subject a no-op — but rendering it raw would name this board's
  // rows after uuids. The address is not lost; it is read back from listing_id,
  // which every listing row now carries.
  const listingIds = [...new Set(codeRows.map((c) => c.listing_id).filter(Boolean))] as string[]
  const listingAddresses = new Map<string, string>()
  if (listingIds.length > 0) {
    const { data: listings, error: listingsError } = await svc
      .from('listings')
      .select('id, address, city, state')
      .eq('brokerage_id', brokerageId)
      .in('id', listingIds)
    if (listingsError) {
      console.error('[qr-management] listing addresses not resolved:', listingsError.message)
    }
    for (const l of (listings ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>) {
      const line = [l.address, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ')
      if (line) listingAddresses.set(l.id, line)
    }
  }

  // ── Owner names — only fetched when the caller can see other people's codes ──
  const agentNames = new Map<string, string>()
  if (scope !== 'agent') {
    const ownerIds = [...new Set(codeRows.map((c) => c.agent_id).filter(Boolean))] as string[]
    if (ownerIds.length > 0) {
      const { data: owners, error: ownersError } = await svc
        .from('agents')
        .select('id, user_id')
        .eq('brokerage_id', brokerageId)
        .in('id', ownerIds)
      if (ownersError) {
        console.error('[qr-management] code owners not resolved:', ownersError.message)
      }
      const userIds = (owners ?? []).map((a: { user_id: string | null }) => a.user_id).filter(Boolean) as string[]
      if (userIds.length > 0) {
        const { data: users, error: usersError } = await svc
          .from('users')
          .select('id, first_name, last_name')
          .in('id', userIds)
        if (usersError) {
          console.error('[qr-management] owner names not resolved:', usersError.message)
        }
        const byUser = new Map<string, string>()
        for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
          byUser.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unnamed')
        }
        for (const a of (owners ?? []) as Array<{ id: string; user_id: string | null }>) {
          if (a.user_id && byUser.has(a.user_id)) agentNames.set(a.id, byUser.get(a.user_id)!)
        }
      }
    }
  }

  // ── Creator names (wave 152): who minted each code (m945 created_by_user_id, a users.id
  // stamped from the SESSION at mint time). Read for every scope — provenance, not ownership.
  const creatorNames = new Map<string, string>()
  {
    const creatorIds = [...new Set(codeRows.map((c) => c.created_by_user_id).filter(Boolean))] as string[]
    if (creatorIds.length > 0) {
      const { data: creators, error: creatorsError } = await svc
        .from('users')
        .select('id, first_name, last_name')
        .eq('brokerage_id', brokerageId)
        .in('id', creatorIds)
      if (creatorsError) console.error('[qr-management] creator names not resolved:', creatorsError.message)
      for (const u of (creators ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
        creatorNames.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Unnamed')
      }
    }
  }

  const codes: QrManagerCode[] = codeRows.map((c) => ({
    id:                    c.id,
    slug:                  c.slug,
    label:                 c.label ?? c.slug,
    purpose:               c.purpose ?? null,
    target_url:            c.target_url ?? null,
    destination_type:      c.destination_type ?? null,
    listing_id:            c.listing_id ?? null,
    scan_count:            c.scan_count ?? 0,
    lead_count:            c.lead_count ?? 0,
    is_active:             !!c.is_active,
    created_at:            c.created_at,
    expires_at:            c.expires_at ?? null,
    marketing_campaign_id: c.marketing_campaign_id ?? null,
    campaign_name:         c.marketing_campaign_id ? campaignNames.get(c.marketing_campaign_id) ?? null : null,
    mail_campaign_name:    mailNames.get(c.id) ?? null,
    agent_id:              c.agent_id ?? null,
    agent_name:            c.agent_id ? agentNames.get(c.agent_id) ?? null : null,
    display_name:          qrDisplayName({
      label:        c.label ?? c.slug,
      listingLine:  c.listing_id ? listingAddresses.get(c.listing_id) ?? null : null,
      campaignName: c.marketing_campaign_id ? campaignNames.get(c.marketing_campaign_id) ?? null : null,
    }),
    ...provenanceOf(c, creatorNames),
    created_by_me:         !!c.created_by_user_id && c.created_by_user_id === ctx.userId,
  }))

  // WAVE 153 (153E) — PLACEMENT ANALYTICS: the same design on a postcard, a yard sign and a social graphic is three codes,
  // so ROI per placement is never pooled. Counted from the codes themselves: RAW scans (qr_codes.scan_count — bots and
  // repeats included; each code's details panel separates human-likely visits) and consented Contacts (lead_count, the
  // submit door's counter). Appointments and closings are the ROI reader's (lib/intelligence/roi-ledger.ts); not here.
  const byPlacement = new Map<string, QrPlacementRollup>()
  for (const code of codes) {
    const key = code.placement ?? 'not_stated'
    const r = byPlacement.get(key) ?? { placement: key, codeCount: 0, rawScans: 0, consentedContacts: 0 }
    r.codeCount += 1
    r.rawScans += code.scan_count
    r.consentedContacts += code.lead_count
    byPlacement.set(key, r)
  }

  // Scans per campaign, from the codes CURRENTLY linked to each campaign. This
  // is the same arithmetic lib/marketing/campaign-measurer.ts applies to
  // marketing_campaigns.impressions, so the two surfaces cannot disagree.
  const rollup = new Map<string, QrCampaignRollup>()
  for (const code of codes) {
    if (!code.marketing_campaign_id) continue
    const existing = rollup.get(code.marketing_campaign_id) ?? {
      campaignId:   code.marketing_campaign_id,
      campaignName: code.campaign_name ?? 'Unnamed campaign',
      codeCount:    0,
      scans:        0,
      leads:        0,
    }
    existing.codeCount += 1
    existing.scans     += code.scan_count
    existing.leads     += code.lead_count
    rollup.set(code.marketing_campaign_id, existing)
  }

  return {
    ok: true,
    ...shared,
    codes,
    campaigns: [...rollup.values()].sort((a, b) => b.scans - a.scans),
    placements: [...byPlacement.values()].sort((a, b) => b.rawScans - a.rawScans),
  }
}

/** The SESSION actor for the governed doors — the gate's own facts, never an argument. */
function actorFrom(ctx: { brokerageId: string | null; userId: string; agentId: string | null; userType: string }): QrActor | null {
  return ctx.brokerageId ? { brokerageId: ctx.brokerageId, userId: ctx.userId, agentId: ctx.agentId ?? null, userType: ctx.userType } : null
}

/** The ONE session gate in front of the governed lifecycle door (module-private — not an endpoint). */
async function gatedLifecycle(qrCodeId: string, action: QrLifecycleAction, reason: string | null): Promise<{ ok: true; state: QrLifecycleState; changed: boolean } | { ok: false; error: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const actor = actorFrom(ctx)
  if (!actor) return { ok: false, error: 'Your sign-in isn\'t attached to an account yet, so QR codes aren\'t available. Finish your account setup, then try again.' }
  const res = await changeQrLifecycle({ qrCodeId, action, reason }, actor)
  return res.ok ? res : { ok: false, error: res.message }
}

/**
 * Pause or resume one code. "Keep an eye on all active, inactive codes" only
 * means something if the state is reversible from the same surface that lists
 * it — an inactive code is a paused campaign, not a deleted one.
 *
 * WAVE 152 (152C): the raw `is_active` UPDATE that lived here (no evidence, and it could
 * "resume" a code that must never route again) now goes through the ONE lifecycle door —
 * lib/marketing/qr-governance.ts changeQrLifecycle (the transition table, a counted write,
 * ledgered `marketing.qr.lifecycle`). A retired code is refused, never resumed.
 *
 * ★ ACT-AS WRITE SEAM ★ — read_only impersonation is refused before the
 * service-client write, which this gate alone protects. The tenant is taken
 * from the session and the UPDATE re-asserts it, so a caller cannot pause
 * another brokerage's code by id.
 */
export async function setQrCodeActive(input: {
  qrCodeId: string
  isActive: boolean
}): Promise<{ ok: true; isActive: boolean; state: QrLifecycleState } | { ok: false; error: string }> {
  if (!input?.qrCodeId) return { ok: false, error: 'No QR code id supplied.' }
  const res = await gatedLifecycle(input.qrCodeId, input.isActive ? 'resume' : 'pause', null)
  return res.ok ? { ok: true, isActive: res.state === 'active' || res.state === 'expired', state: res.state } : res
}

/**
 * Retire one code for good — or turn it off because its destination became UNSAFE (a
 * reason is required and kept on the record). Retirement is TERMINAL: the code never
 * routes again and its row is never deleted (it records what was printed and mailed).
 * To print again, duplicate it (duplicateQrCode) — a new unique token.
 */
export async function retireQrCode(input: {
  qrCodeId: string
  unsafe?: boolean
  reason?: string
}): Promise<{ ok: true; state: QrLifecycleState; changed: boolean } | { ok: false; error: string }> {
  if (!input?.qrCodeId) return { ok: false, error: 'No QR code id supplied.' }
  return gatedLifecycle(input.qrCodeId, input.unsafe ? 'revoke_unsafe' : 'retire', input.reason?.trim() || null)
}

/**
 * Duplicate a code's design ON PURPOSE — same destination, purpose and context, a NEW
 * unpredictable token (two printed runs stay separately measurable). Idempotent per key:
 * a double click returns the same new code.
 */
export async function duplicateQrCode(input: {
  qrCodeId: string
  idempotencyKey: string
  label?: string
}): Promise<{ ok: true; replayed: boolean; code: { id: string; slug: string; label: string; scanUrl: string; targetUrl: string } } | { ok: false; error: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  const actor = actorFrom(ctx)
  if (!actor) return { ok: false, error: 'Your sign-in isn\'t attached to an account yet, so QR codes aren\'t available. Finish your account setup, then try again.' }
  const res = await duplicateQrDesign({ sourceQrCodeId: input?.qrCodeId, idempotencyKey: input?.idempotencyKey, label: input?.label ?? null }, actor)
  if (!res.ok) return { ok: false, error: res.message }
  const { id, slug, label, scanUrl, targetUrl } = res.code
  return { ok: true, replayed: res.replayed, code: { id, slug, label, scanUrl, targetUrl } }
}

/**
 * One code's scan history and aggregate outcomes for the board: raw scans, human-likely
 * visits, unique visitor-days (only where a visitor key exists), consented submissions —
 * never a person (no visitor key or contact id leaves the server).
 */
export async function loadQrCodeActivity(qrCodeId: string): Promise<{ ok: true; activity: QrActivity } | { ok: false; error: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? 'Not authenticated' }
  const actor = actorFrom(ctx)
  if (!actor) return { ok: false, error: 'Your sign-in isn\'t attached to an account yet, so QR codes aren\'t available. Finish your account setup, then try again.' }
  const res = await loadQrActivity(qrCodeId, actor)
  return res.ok ? res : { ok: false, error: res.message }
}
