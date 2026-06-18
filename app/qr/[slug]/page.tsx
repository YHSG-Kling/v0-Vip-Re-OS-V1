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
      agent_user_id:agent_id,
      listing_id
    `)
    .eq('slug', slug)
    .eq('is_active', true)
    .single()

  if (error || !qr) {
    notFound()
  }

  // Fetch agent profile if present
  let agentName: string | null = null
  let agentPhoto: string | null = null

  if (qr.agent_user_id) {
    const { data: agent } = await supabase
      .from('users')
      .select('first_name, last_name')
      .eq('id', qr.agent_user_id)
      .maybeSingle()

    agentName = agent ? `${agent.first_name || ''} ${agent.last_name || ''}`.trim() || null : null
    agentPhoto = null // User profiles don't have photos in this schema
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
