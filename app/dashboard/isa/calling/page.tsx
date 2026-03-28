import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Phone,
  PhoneCall,
  ArrowLeft,
  Mic,
  User,
  AlertTriangle,
  Flame,
  TrendingUp,
  Clock,
  ExternalLink,
} from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'AI-ISA Calling Queue | VIP-OS',
  description: 'Priority-sorted outbound calling queue for AI Inside Sales Agent',
}

function getPriorityLabel(score: number | null): { label: string; color: string } {
  if (!score || score < 40) return { label: 'Low', color: 'bg-gray-100 text-gray-600' }
  if (score < 65) return { label: 'Medium', color: 'bg-blue-100 text-blue-700' }
  if (score < 80) return { label: 'High', color: 'bg-amber-100 text-amber-700' }
  return { label: 'Urgent', color: 'bg-red-100 text-red-700' }
}

function formatTimeAgo(dateString: string | null): string {
  if (!dateString) return '--'
  const date = new Date(dateString)
  const now = new Date()
  const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

export default async function ISACallingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  // Check VAPI configuration via ai_isa_settings (brokerage-level)
  const { data: isaSettings } = profile?.brokerage_id
    ? await supabase
        .from('ai_isa_settings')
        .select('vapi_assistant_id, is_active')
        .eq('brokerage_id', profile.brokerage_id)
        .maybeSingle()
    : { data: null }

  const vapiConfigured = !!isaSettings?.vapi_assistant_id
  const isaActive = isaSettings?.is_active ?? false

  // Fetch contacts sorted by urgency (lead_score DESC, then recently added)
  const { data: contacts } = profile?.brokerage_id
    ? await supabase
        .from('contacts')
        .select(
          'id, first_name, last_name, phone, status, contact_type, lead_score, created_at, buyer_stage, seller_stage'
        )
        .eq('brokerage_id', profile.brokerage_id)
        .not('phone', 'is', null)
        .in('status', ['new', 'contacted', 'active'])
        .order('lead_score', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(50)
    : { data: [] }

  const urgentCount = contacts?.filter((c) => (c.lead_score ?? 0) >= 80).length ?? 0
  const highCount =
    contacts?.filter((c) => {
      const s = c.lead_score ?? 0
      return s >= 65 && s < 80
    }).length ?? 0

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/isa">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Phone className="w-6 h-6 text-green-600" />
              AI-ISA Calling Queue
            </h1>
            <p className="text-muted-foreground text-sm">
              {contacts?.length ?? 0} leads &mdash; sorted by urgency
            </p>
          </div>
        </div>
        <Link href="/dashboard/voice/isa">
          <Button className="bg-green-600 hover:bg-green-700 text-white">
            <Mic className="w-4 h-4 mr-2" />
            Open Voice ISA
          </Button>
        </Link>
      </div>

      {/* VAPI not configured banner */}
      {!vapiConfigured && (
        <Alert variant="destructive" className="border-amber-300 bg-amber-50 text-amber-900">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-800">VAPI Assistant Not Configured</AlertTitle>
          <AlertDescription className="text-amber-700">
            AI-automated calling requires a VAPI assistant ID. Manual calls still work — configure
            VAPI in Settings to enable AI outbound dialing.{' '}
            <Link
              href="/settings?tab=ai-isa"
              className="font-semibold underline underline-offset-2 hover:text-amber-900"
            >
              Configure now
              <ExternalLink className="inline w-3 h-3 ml-1" />
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {/* ISA inactive banner */}
      {vapiConfigured && !isaActive && (
        <Alert className="border-blue-200 bg-blue-50">
          <AlertTriangle className="h-4 w-4 text-blue-600" />
          <AlertTitle className="text-blue-800">AI-ISA is Paused</AlertTitle>
          <AlertDescription className="text-blue-700">
            The AI-ISA campaign is currently paused. Enable it in{' '}
            <Link href="/settings?tab=ai-isa" className="font-semibold underline">
              AI-ISA Settings
            </Link>{' '}
            to resume automated outreach.
          </AlertDescription>
        </Alert>
      )}

      {/* Priority summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-red-600" />
              <span className="text-sm font-medium text-red-800">Urgent</span>
            </div>
            <p className="text-2xl font-bold text-red-700 mt-1">{urgentCount}</p>
            <p className="text-xs text-red-600">Score 80+</p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-medium text-amber-800">High Priority</span>
            </div>
            <p className="text-2xl font-bold text-amber-700 mt-1">{highCount}</p>
            <p className="text-xs text-amber-600">Score 65–79</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Total Queue</span>
            </div>
            <p className="text-2xl font-bold mt-1">{contacts?.length ?? 0}</p>
            <p className="text-xs text-muted-foreground">All active leads</p>
          </CardContent>
        </Card>
      </div>

      {/* Queue table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Priority Call Queue</CardTitle>
        </CardHeader>
        <CardContent>
          {!contacts || contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No leads in calling queue
            </p>
          ) : (
            <div className="space-y-2">
              {contacts.map((contact: any) => {
                const priority = getPriorityLabel(contact.lead_score)
                const stage = contact.buyer_stage ?? contact.seller_stage ?? null
                return (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-blue-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {contact.first_name} {contact.last_name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {contact.phone}
                          {stage ? ` · ${stage.replace(/_/g, ' ')}` : ''}
                          {' · '}
                          {formatTimeAgo(contact.created_at)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      {contact.lead_score != null && (
                        <span className="text-xs font-semibold text-muted-foreground w-7 text-right">
                          {contact.lead_score}
                        </span>
                      )}
                      <Badge className={`text-xs ${priority.color}`}>{priority.label}</Badge>
                      <Badge variant="outline" className="text-xs">
                        {contact.status}
                      </Badge>

                      {vapiConfigured ? (
                        <Link href={`/dashboard/voice/isa?contactId=${contact.id}`}>
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white text-xs"
                          >
                            <PhoneCall className="w-3 h-3 mr-1" />
                            AI Call
                          </Button>
                        </Link>
                      ) : (
                        <a href={`tel:${contact.phone}`}>
                          <Button size="sm" variant="outline" className="text-xs">
                            <PhoneCall className="w-3 h-3 mr-1" />
                            Call
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
