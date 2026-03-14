import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Plug, CheckCircle2, AlertTriangle, Settings } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const KNOWN_INTEGRATIONS = [
  { name: 'HeyGen (Video AI)', envKey: 'HEYGEN_API_KEY', category: 'AI', description: 'AI video generation for personalized property videos' },
  { name: 'Vapi.ai (Voice AI)', envKey: 'VAPI_API_KEY', category: 'AI', description: 'AI voice agent for ISA calling and qualification' },
  { name: 'Supabase', envKey: 'NEXT_PUBLIC_SUPABASE_URL', category: 'Database', description: 'Primary database and authentication' },
  { name: 'GoHighLevel', envKey: 'GHL_API_KEY', category: 'CRM', description: 'CRM and marketing automation bridge' },
  { name: 'Twilio', envKey: 'TWILIO_ACCOUNT_SID', category: 'Communications', description: 'SMS and voice calling infrastructure' },
  { name: 'Stripe', envKey: 'STRIPE_SECRET_KEY', category: 'Billing', description: 'Subscription billing and payment processing' },
  { name: 'OpenAI / Anthropic', envKey: 'ANTHROPIC_API_KEY', category: 'AI', description: 'Core AI model for content generation' },
  { name: 'Dotloop', envKey: 'DOTLOOP_API_KEY', category: 'Transactions', description: 'E-signature and transaction document management' },
  { name: 'IDX Broker', envKey: 'IDXBROKER_API_KEY', category: 'MLS', description: 'MLS listing data integration' },
]

export default async function AdminIntegrationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (!['admin', 'superadmin'].includes(profile?.role)) redirect('/dashboard')

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Plug className="w-6 h-6 text-blue-600" />
            Platform Integrations
          </h1>
          <p className="text-gray-500 text-sm">Manage all third-party service connections</p>
        </div>
        <Link href="/settings/integrations">
          <Button variant="outline" size="sm">
            <Settings className="w-4 h-4 mr-2" />
            Integration Settings
          </Button>
        </Link>
      </div>

      <div className="grid gap-4">
        {['AI', 'Database', 'CRM', 'Communications', 'Billing', 'Transactions', 'MLS'].map((category) => {
          const categoryIntegrations = KNOWN_INTEGRATIONS.filter((i) => i.category === category)
          if (categoryIntegrations.length === 0) return null
          return (
            <div key={category}>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{category}</h3>
              <div className="grid md:grid-cols-2 gap-3">
                {categoryIntegrations.map((integration) => (
                  <Card key={integration.name}>
                    <CardContent className="p-4 flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{integration.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{integration.description}</p>
                      </div>
                      <Badge className="bg-green-100 text-green-700 border-green-200 text-xs shrink-0">Connected</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
