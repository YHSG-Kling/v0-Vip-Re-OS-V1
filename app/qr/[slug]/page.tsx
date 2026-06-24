import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import QRLandingClient from './QRLandingClient'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function QRLandingPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = createServiceClient()

  const { data: qr, error } = await supabase
    .from('qr_codes')
    .select(`
      id,
      slug,
      label,
      purpose,
      brokerage_id,
      agent_id,
      listing_id
    `)
    .eq('slug', slug)
    .eq('is_active', true)
    .single()

  if (error || !qr) {
    notFound()
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
