// TRACK B: Public form page — server component fetches form by slug
// Form fill = TCPA consent. No lead created.

import { createServiceClient } from '@/lib/supabase/service'
import { notFound } from 'next/navigation'
import FormRenderer from './FormRenderer'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function FormPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = createServiceClient()

  const { data: form } = await supabase
    .from('lead_capture_forms')
    .select('id, name, slug, fields, tcpa_disclosure_text, thank_you_message, redirect_url, brokerage_id')
    .eq('slug', slug)
    .eq('is_active', true)
    .single()

  if (!form) notFound()

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold text-foreground mb-6 text-balance">{form.name}</h1>
        <FormRenderer form={form} />
      </div>
    </main>
  )
}
