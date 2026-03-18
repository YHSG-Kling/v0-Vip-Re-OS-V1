'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Phone, ExternalLink } from 'lucide-react'

interface HotLeadCardProps {
  lead: {
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
  onWhisperBridge: (contactId: string, context: string) => Promise<void>
  onVapiBot: (contactId: string, triggerEvent: string) => Promise<void>
  callingId: string | null
  compact?: boolean
}

export function HotLeadCard({
  lead,
  onWhisperBridge,
  onVapiBot,
  callingId,
  compact = false,
}: HotLeadCardProps) {
  const [loading, setLoading] = useState(false)

  if (!lead.contacts) {
    return null
  }

  // Get top 2 score factors
  const factors = Object.entries(lead.score_factors || {})
    .slice(0, 2)
    .map(([key]) => key.replace(/_/g, ' ').toLowerCase())

  const scoreColor =
    lead.score >= 70 ? 'bg-green-100 text-green-800' : lead.score >= 50 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'

  const handleWhisperCall = async () => {
    setLoading(true)
    try {
      await onWhisperBridge(lead.contacts!.id, `Score ${lead.score}. ${factors.join(', ')}`)
    } finally {
      setLoading(false)
    }
  }

  const handleVapiCall = async () => {
    setLoading(true)
    try {
      await onVapiBot(lead.contacts!.id, 'hot_lead_score')
    } finally {
      setLoading(false)
    }
  }

  const isWhisperCalling = callingId === `${lead.contacts.id}whisper`
  const isVapiCalling = callingId === `${lead.contacts.id}vapi`

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 p-3 border rounded-lg bg-background">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">
              {lead.contacts.first_name} {lead.contacts.last_name}
            </span>
            <Badge className={scoreColor}>{lead.score}</Badge>
          </div>
          {lead.contacts.source && <p className="text-xs text-muted-foreground">{lead.contacts.source}</p>}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleWhisperCall}
            disabled={loading}
          >
            {isWhisperCalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
          </Button>
          <Link href={`/leads/${lead.id}`}>
            <Button size="sm" variant="ghost">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <Card className="p-4">
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-medium">
              {lead.contacts.first_name} {lead.contacts.last_name}
            </p>
            {lead.contacts.source && <Badge variant="secondary">{lead.contacts.source}</Badge>}
          </div>
          <Badge className={`${scoreColor} text-lg px-3 py-1`}>{lead.score}</Badge>
        </div>

        {factors.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium">Score Factors:</p>
            <ul className="text-sm space-y-0.5">
              {factors.map((factor) => (
                <li key={factor} className="text-muted-foreground">
                  • {factor}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleWhisperCall}
            disabled={loading}
            className="flex-1"
          >
            {isWhisperCalling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Calling...
              </>
            ) : (
              <>
                <Phone className="h-4 w-4 mr-2" />
                Call with AI Briefing
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleVapiCall}
            disabled={loading}
            className="flex-1"
          >
            {isVapiCalling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Calling...
              </>
            ) : (
              <>
                <Phone className="h-4 w-4 mr-2" />
                AI Voice Call
              </>
            )}
          </Button>
          <Link href="/leads">
            <Button size="sm" variant="ghost">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  )
}
