import { createServiceClient } from '@/lib/supabase/service'
import { publiclyVisibleListingStatuses } from '@/lib/listings/listing-status-sync'
// WAVE 152 (lane 152C): the ONE lifecycle classifier and the ONE unavailable-code wording — the same words the scan door
// gives, so the two doors to a code never disagree (a missing code is a helpful notice too, never a bare 404).
import { resolveQrScanDestination, qrContinueLabel, qrLifecycleState, qrUnavailableNotice, isAbsentColumnRefusal } from '@/lib/marketing/qr-contract'
import { loadQrTenantHosts } from '@/lib/marketing/qr-governance'
import QRLandingClient from './QRLandingClient'

interface PageProps {
  params: Promise<{ slug: string }>
}

/**
 * The same honest refusal /api/qr/scan gives, in the same words — this is the
 * OTHER door to a QR code. The scan route can only speak for scans it routes;
 * a bookmarked or shared /qr/<slug> link reaches this page directly, so a
 * paused or expired code has to be refused here too or the two doors disagree.
 */
function QRRefusalNotice({ heading, detail, action }: { heading: string; detail: string; action: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-8">
      <div className="w-full max-w-md text-center space-y-2">
        <h1 className="text-xl font-semibold text-foreground">{heading}</h1>
        <p className="text-base leading-relaxed text-muted-foreground">{detail}</p>
        <p className="text-base leading-relaxed text-muted-foreground">{action}</p>
      </div>
    </div>
  )
}

const LANDING_COLUMNS_LEGACY = 'id, slug, label, purpose, brokerage_id, agent_id, listing_id, target_url, destination_type, is_active, expires_at'

export default async function QRLandingPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = createServiceClient()

  // `is_active` is NOT part of the lookup: a paused code and a slug that never
  // existed are different facts and get different answers. WAVE 152: the m945
  // retirement columns are read when present; before m945 the read degrades.
  let { data: qr, error } = await supabase
    .from('qr_codes')
    .select(`${LANDING_COLUMNS_LEGACY}, retired_at, retired_reason`)
    .eq('slug', slug)
    .maybeSingle()
  if (error && isAbsentColumnRefusal(error)) {
    ({ data: qr, error } = await supabase.from('qr_codes').select(LANDING_COLUMNS_LEGACY).eq('slug', slug).maybeSingle())
  }

  if (error) {
    console.error('[qr landing] code lookup refused:', error.message)
    return <QRRefusalNotice {...qrUnavailableNotice('error')} />
  }
  if (!qr) {
    return <QRRefusalNotice {...qrUnavailableNotice('missing')} />
  }

  const state = qrLifecycleState(qr as Parameters<typeof qrLifecycleState>[0])
  if (state !== 'active') {
    return <QRRefusalNotice {...qrUnavailableNotice(state)} />
  }

  // Fetch agent profile if present. qr_codes.agent_id is an agents.id (FK → agents.id), so resolve
  // the name THROUGH agents → users. (Previously this looked the agents.id up directly in `users`,
  // so the agent name never resolved and every QR landing showed an unbranded page.)
  let agentName: string | null = null
  // C15 (wave 148): THE one brand rule — the code's agent by full name, else its brokerage (the submit door re-renders it).
  let consentBrandName = 'our brokerage'
  let agentPhoto: string | null = null

  if (qr.agent_id) {
    const { data: agent } = await supabase
      .from('agents')
      .select('users(first_name, last_name)')
      .eq('id', qr.agent_id)
      .maybeSingle()

    const u = Array.isArray(agent?.users) ? agent?.users[0] : agent?.users
    agentName = u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || null : null
    agentPhoto = null // agents has no avatar column in this schema
  }

  {
    const { resolveConsentBrand } = await import('@/lib/contact-pipeline/contact-capture')
    consentBrandName = await resolveConsentBrand(supabase, { agentId: qr.agent_id ?? null, brokerageId: qr.brokerage_id })
  }

  // Fetch listing info if linked
  let listingAddress: string | null = null
  if (qr.listing_id) {
    // C12 (wave 147, lane 147F — owner ruling 8): a public QR landing names only a PUBLICLY VISIBLE listing — never an
    // archived or off-market one (the shared predicate + the archive filter; the code's form still works without it).
    const { data: listing } = await supabase
      .from('listings')
      .select('address')
      .eq('id', qr.listing_id)
      .in('status', publiclyVisibleListingStatuses())
      .is('deleted_at', null)
      .maybeSingle()

    listingAddress = listing?.address ?? null
  }

  // ── THE CODE'S INTENDED DESTINATION, OFFERED (wave 141F) ────────────────────
  // /api/qr/scan already redirects an allow-listed in-app destination straight
  // through, so a scanner only lands HERE when the code's destination IS this
  // form, when the link was opened directly, or when the destination is an https
  // host we do not own — which is never auto-followed (no open redirect) and is
  // offered instead as a link the person taps. The same pure resolver decides
  // both doors, so they cannot disagree.
  // The tenant's verified custom domains serve this app (wave 152) — the same origins the scan door passes.
  const tenantDomains = qr.brokerage_id ? (await loadQrTenantHosts(supabase, qr.brokerage_id)).customDomains.map((d) => `https://${d}`) : []
  const destination = resolveQrScanDestination({
    slug,
    targetUrl: qr.target_url ?? null,
    appOrigins: [process.env.NEXT_PUBLIC_APP_URL ?? null, ...tenantDomains],
  })
  const continueTo =
    destination.kind === 'in_app'
      ? { href: destination.path, label: qrContinueLabel(qr.destination_type, false), external: false }
      : destination.external
        ? { href: destination.external.url, label: `${qrContinueLabel(qr.destination_type, true)} (${destination.external.host})`, external: true }
        : null

  return (
    <QRLandingClient
      slug={slug}
      qrCodeId={qr.id}
      label={qr.label}
      purpose={qr.purpose ?? null}
      agentName={agentName}
      consentBrandName={consentBrandName}
      agentPhoto={agentPhoto}
      listingAddress={listingAddress}
      continueTo={continueTo}
    />
  )
}
