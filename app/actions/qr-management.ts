'use server'

// QR MANAGEMENT — the READ side of the QR manager, plus the one management
// write the surface needs (pause / resume).
//
// OWNER RULING, verbatim: "qr codes need a page to keep an eye on all active,
// inactive codes or creating a qr code manually plus tracking linked to
// campaign."
//
// ONE PAGE, ROLE-SCOPED DATA. /dashboard/agent/qr-codes was reachable from the
// agent sidebar only and read `.eq('agent_id', ctx.agentId)` — a broker who
// reached the URL directly saw their own (usually empty) list, not their
// brokerage's. Rather than fork a second broker page, the scope is resolved
// here:
//   · broker / broker_owner / broker_admin / admin → the whole brokerage
//   · the LEAD of a team                            → that team's agents
//   · everyone else                                 → their own codes
// SCOPE LADDER (kept inline — a shared admin predicate would move roles between
// tiers). 'superadmin' is absent because it is dead as users.user_type; platform
// staff reach a tenant through the act-as seam and arrive carrying the tenant's
// own user_type.
//
// TEAM IS A FACT, NOT A SEAT: leading a team is `teams.team_lead_id = users.id`
// (lib/teams/team-scope.ts), the same anchor m473 put on every RLS lane. A
// user_type 'team_lead' who leads no team row leads nothing and falls to their
// own codes.
//
// GATE-THEN-SERVICE: the reads run on the service client because a team lead and
// a broker must see codes minted by OTHER agents, and qr_codes' RLS is written
// for the owner. The gate written here is therefore the only gate — every query
// below carries `.eq('brokerage_id', ctx.brokerageId)` from the SESSION, never
// from an argument.

import { createServiceClient } from '@/lib/supabase/service'
import { resolveActingContext, resolveWriteContext } from '@/lib/platform/acting-context'
import { resolveAgentIdInBrokerage } from '@/lib/kernel/agent-identity'
import { resolveLedTeamId } from '@/lib/teams/team-scope'

const BROKERAGE_SCOPE_ROLES = new Set(['broker', 'broker_owner', 'broker_admin', 'admin'])

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
 */
export function qrDisplayName(input: {
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

export type QrScopeKind = 'agent' | 'team' | 'brokerage'

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
      /** The brokerage's campaigns, for the create form's campaign picker. */
      linkableCampaigns: QrLinkableCampaign[]
    }
  | { ok: false; error: string }

const CODE_COLUMNS =
  'id, slug, label, purpose, target_url, destination_type, listing_id, scan_count, ' +
  'lead_count, is_active, created_at, expires_at, marketing_campaign_id, agent_id'

/**
 * Every QR code the caller is entitled to see, with both campaign linkages
 * resolved and a per-campaign scan rollup.
 */
export async function loadQrCodesForCaller(): Promise<QrManagerData> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? 'Not authenticated' }
  if (!ctx.brokerageId) {
    return { ok: false, error: 'No brokerage on your account — QR codes are scoped to a brokerage.' }
  }

  const svc = createServiceClient()
  const brokerageId = ctx.brokerageId

  let scope: QrScopeKind = 'agent'
  let scopeLabel = 'Your QR codes'
  let agentIds: string[] | null = null   // null = no agent narrowing (brokerage scope)

  if (BROKERAGE_SCOPE_ROLES.has(ctx.userType)) {
    scope = 'brokerage'
    scopeLabel = 'Every QR code in your brokerage'
  } else {
    // The team question first — a lead who is also user_type 'agent' (the live
    // shape, per m473) still leads their team's codes.
    const led = await resolveLedTeamId(svc, ctx.userId)
    // DESTRUCTURE THE REFUSAL: "the read was refused" must never be reported as
    // "you lead nothing", which would silently narrow a lead to their own codes.
    if (!led.ok) return { ok: false, error: led.error }

    if (led.teamId) {
      const { data: teamAgents, error: teamAgentsError } = await svc
        .from('agents')
        .select('id')
        .eq('brokerage_id', brokerageId)
        .eq('team_id', led.teamId)
      if (teamAgentsError) {
        return { ok: false, error: `Could not resolve your team's agents: ${teamAgentsError.message}` }
      }
      scope = 'team'
      scopeLabel = "Your team's QR codes"
      // The lead's OWN agents row is unioned in rather than assumed to carry
      // team_id — agent_team_id()'s resolution order lets someone lead a team
      // their agents row is not filed under, and a lead who cannot see their own
      // codes on their own team's board is the obvious way to get this wrong.
      const ownAgentId = await resolveAgentIdInBrokerage(svc, ctx.userId, brokerageId)
      agentIds = [...new Set([
        ...(teamAgents ?? []).map((a: { id: string }) => a.id),
        ...(ownAgentId ? [ownAgentId] : []),
      ])]
    } else {
      const agentId = await resolveAgentIdInBrokerage(svc, ctx.userId, brokerageId)
      if (!agentId) {
        return { ok: false, error: 'No agent record in this brokerage — QR codes are filed against an agent.' }
      }
      agentIds = [agentId]
    }
  }

  let query = svc
    .from('qr_codes')
    .select(CODE_COLUMNS)
    .eq('brokerage_id', brokerageId)
    .order('created_at', { ascending: false })
  if (agentIds) query = query.in('agent_id', agentIds)

  const { data: rows, error: rowsError } = await query
  if (rowsError) return { ok: false, error: `Could not load QR codes: ${rowsError.message}` }

  // The campaigns a NEW code can be linked to. Fetched whether or not any codes
  // exist — the first code an agent mints is the one most worth linking.
  const { data: linkable, error: linkableError } = await svc
    .from('marketing_campaigns')
    .select('id, campaign_name, created_at')
    .eq('brokerage_id', brokerageId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (linkableError) {
    console.error('[qr-management] campaign picker list not resolved:', linkableError.message)
  }
  const linkableCampaigns: QrLinkableCampaign[] =
    ((linkable ?? []) as Array<{ id: string; campaign_name: string | null }>).map((c) => ({
      id:   c.id,
      name: c.campaign_name ?? 'Untitled campaign',
    }))

  const codeRows = (rows ?? []) as Array<Record<string, any>>
  if (codeRows.length === 0) {
    return { ok: true, scope, scopeLabel, codes: [], campaigns: [], linkableCampaigns }
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
  }))

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
    scope,
    scopeLabel,
    codes,
    campaigns: [...rollup.values()].sort((a, b) => b.scans - a.scans),
    linkableCampaigns,
  }
}

/**
 * Pause or resume one code. "Keep an eye on all active, inactive codes" only
 * means something if the state is reversible from the same surface that lists
 * it — an inactive code is a paused campaign, not a deleted one.
 *
 * ★ ACT-AS WRITE SEAM ★ — read_only impersonation is refused before the
 * service-client write, which this gate alone protects. The tenant is taken
 * from the session and the UPDATE re-asserts it, so a caller cannot pause
 * another brokerage's code by id.
 */
export async function setQrCodeActive(input: {
  qrCodeId: string
  isActive: boolean
}): Promise<{ ok: true; isActive: boolean } | { ok: false; error: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!ctx.brokerageId) {
    return { ok: false, error: 'No brokerage on your account — QR codes are scoped to a brokerage.' }
  }
  if (!input?.qrCodeId) return { ok: false, error: 'No QR code id supplied.' }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from('qr_codes')
    .update({ is_active: input.isActive })
    .eq('id', input.qrCodeId)
    .eq('brokerage_id', ctx.brokerageId)
    .select('id, is_active')
    .maybeSingle()

  if (error) return { ok: false, error: `Could not update this QR code: ${error.message}` }
  if (!data) {
    return { ok: false, error: 'That QR code is not in your brokerage.' }
  }
  return { ok: true, isActive: !!data.is_active }
}
