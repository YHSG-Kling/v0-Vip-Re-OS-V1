import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
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
function QRRefusalNotice({ heading, detail }: { heading: string; detail: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-8">
      <div className="max-w-md text-center space-y-2">
        <h1 className="text-xl font-semibold text-foreground">{heading}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

export default async function QRLandingPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = createServiceClient()

  // `is_active` is NOT part of the lookup: a paused code and a slug that never
  // existed are different facts and get different answers.
  const { data: qr, error } = await supabase
    .from('qr_codes')
    .select(`
      id,
      slug,
      label,
      purpose,
      brokerage_id,
      agent_id,
      listing_id,
      is_active,
      expires_at
    `)
    .eq('slug', slug)
    .maybeSingle()

  if (error || !qr) {
    notFound()
  }

  if (!qr.is_active) {
    return (
      <QRRefusalNotice
        heading="This code is paused"
        detail="The agent who created this QR code has paused it, so it is not routing scans right now. Please contact them directly."
      />
    )
  }
  if (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now()) {
    return (
      <QRRefusalNotice
        heading="This code has expired"
        detail="This QR code was set to expire and that date has passed, so it no longer routes anywhere. Please contact the agent who shared it for a current link."
      />
    )
  }

  // Fetch agent profile if present. qr_codes.agent_id is an agents.id (FK → agents.id), so resolve
  // the name THROUGH agents → users. (Previously this looked the agents.id up directly in `users`,
  // so the agent name never resolved and every QR landing showed an unbranded page.)
  let agentName: string | null = null
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

  // Fetch listing info if linked
  let listingAddress: string | null = null
  if (qr.listing_id) {
    const { data: listing } = await supabase
      .from('listings')
      .select('address')
      .eq('id', qr.listing_id)
      .maybeSingle()

    listingAddress = listing?.address ?? null
  }

  return (
    <QRLandingClient
      slug={slug}
      qrCodeId={qr.id}
      label={qr.label}
      purpose={qr.purpose ?? null}
      agentName={agentName}
      agentPhoto={agentPhoto}
      listingAddress={listingAddress}
    />
  )
}
