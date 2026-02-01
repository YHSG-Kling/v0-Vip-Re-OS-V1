import { TemplateBuilder } from '@/app/components/newsletter/template-builder'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Newsletter Templates | Real Estate CRM',
  description: 'Create and manage professional newsletter templates for your brokerage',
}

export default async function NewsletterTemplatesPage() {
  return (
    <div className="container mx-auto p-6">
      <TemplateBuilder />
    </div>
  )
}
