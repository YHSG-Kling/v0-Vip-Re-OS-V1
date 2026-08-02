"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Zap, CheckCircle2 } from "lucide-react"
import { HotLeadCard } from "@/app/components/shared/HotLeadCard"

interface HotLead {
  id: string
  score: number
  score_factors: Record<string, any>
  contacts: {
    id: string
    first_name: string
    last_name: string
    phone?: string
    email?: string
    source?: string
  } | null
}

interface AgentHotLeadsPanelProps {
  hotLeads: HotLead[]
  agentId: string
  onWhisperBridge: (contactId: string, context: string) => Promise<void>
  onAiVoiceCall: (contactId: string, triggerEvent: string) => Promise<void>
  callingId: string | null
  loading?: boolean
}

export function AgentHotLeadsPanel({
  hotLeads,
  agentId,
  onWhisperBridge,
  onAiVoiceCall,
  callingId,
  loading
}: AgentHotLeadsPanelProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Hot Leads Now
          </CardTitle>
          <CardDescription>These contacts are showing real buying signals right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-muted rounded animate-pulse" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (hotLeads.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            Hot Leads Now
          </CardTitle>
          <CardDescription>These contacts are showing real buying signals right now.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">All high-intent contacts have been actioned — great work.</p>
            {/* Agents work CONTACTS — /leads is the broker/admin desk. */}
            <Link href="/crm" className="text-sm text-primary hover:underline mt-2 inline-block">
              View your contacts →
            </Link>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-amber-500" />
          Hot Leads Now
        </CardTitle>
        <CardDescription>These contacts are showing real buying signals right now.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hotLeads.map((lead) => (
          <HotLeadCard
            key={lead.id}
            lead={lead}
            compact={false}
            onWhisperBridge={onWhisperBridge}
            onAiVoiceCall={onAiVoiceCall}
            callingId={callingId}
          />
        ))}
      </CardContent>
    </Card>
  )
}
