"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { initiateWhisperBridge } from "@/app/actions/voice-call-bridge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { 
  User,
  Phone,
  ExternalLink,
  Activity,
  CheckCircle2,
  XCircle
} from "lucide-react"

interface ContactHistorySheetProps {
  contactId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ContactData {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  buyer_stage: string | null
}

interface ISACall {
  id: string
  appointment_set: boolean
  lead_quality_score: number | null
  created_at: string
  voice_call_id: string | null
}

interface Qualification {
  id: string
  qualification_score: number | null
  qualification_result: string | null
  notes: string | null
  qualified_at: string | null
}

interface EngagementTracking {
  id: string
  event_type: string | null
  channel: string | null
  event_at: string | null
}

export function ContactHistorySheet({ contactId, open, onOpenChange }: ContactHistorySheetProps) {
  const [loading, setLoading] = useState(true)
  const [contact, setContact] = useState<ContactData | null>(null)
  const [calls, setCalls] = useState<ISACall[]>([])
  const [qualifications, setQualifications] = useState<Qualification[]>([])
  const [engagementScore, setEngagementScore] = useState<number | null>(null)
  const [calling, setCalling] = useState(false)

  useEffect(() => {
    if (!contactId || !open) return

    async function fetchData() {
      setLoading(true)
      const supabase = createClient()

      const [contactRes, callsRes, qualRes, engagementRes] = await Promise.all([
        supabase
          .from("contacts")
          .select("id, first_name, last_name, phone, email, buyer_stage")
          .eq("id", contactId)
          .single(),
        supabase
          .from("ai_isa_calls")
          .select("id, appointment_set, lead_quality_score, created_at, voice_call_id")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("ai_isa_qualifications")
          .select("id, qualification_score, qualification_result, notes, qualified_at")
          .eq("contact_id", contactId)
          .order("qualified_at", { ascending: false })
          .limit(5),
        supabase
          .from("ai_isa_engagement_tracking")
          .select("id, event_type, channel, event_at")
          .eq("contact_id", contactId)
          .order("event_at", { ascending: false })
          .limit(1),
      ])

      // supabase-js RESOLVES a failed query — without reading `error` a broken
      // read is indistinguishable from an empty contact.
      const readError = contactRes.error ?? callsRes.error ?? qualRes.error ?? engagementRes.error
      if (readError) toast.error(readError.message)

      setContact(contactRes.data)
      setCalls(callsRes.data || [])
      setQualifications(qualRes.data || [])
      
      // Calculate engagement score from recent activity
      const recentActivity = callsRes.data?.length || 0
      const qualScore = qualRes.data?.[0]?.qualification_score || 0
      setEngagementScore(Math.min(100, recentActivity * 10 + qualScore))

      setLoading(false)
    }

    fetchData()
  }, [contactId, open])

  // "Manual Call" — the agent takes the conversation off the AI ISA and speaks
  // to the lead themselves. initiateWhisperBridge is the platform's manual-call
  // path: Twilio rings the AGENT first, whispers who they are about to be
  // connected to and why, then bridges them to the contact. The whisper text is
  // built from the ISA history already on screen so the agent picks up informed.
  async function handleManualCall() {
    if (!contact) return
    if (!contact.phone) {
      toast.error("This contact has no phone number on file")
      return
    }

    const lastCall = calls[0]
    const lastQual = qualifications[0]
    const parts: string[] = []
    if (lastQual?.qualification_result) parts.push(`last qualified as ${lastQual.qualification_result}`)
    if (typeof lastQual?.qualification_score === "number") parts.push(`score ${lastQual.qualification_score}`)
    if (lastCall) {
      parts.push(
        lastCall.appointment_set
          ? `an appointment was set on the ISA call of ${formatDate(lastCall.created_at)}`
          : `last ISA call ${formatDate(lastCall.created_at)}, no appointment set`,
      )
    }
    if (contact.buyer_stage) parts.push(`buyer stage ${contact.buyer_stage}`)
    const context = parts.length ? parts.join(", ") : "no prior ISA activity on record"

    setCalling(true)
    try {
      const res = await initiateWhisperBridge({ contactId: contact.id, context })
      if (!res?.success) {
        toast.error(res?.error ?? "The call was not placed")
        return
      }
      toast.success("Calling you now — we'll bridge you to the contact when you answer")
    } catch (err: any) {
      toast.error(err?.message ?? "The call was not placed")
    } finally {
      setCalling(false)
    }
  }

  function formatDate(dateString: string | null): string {
    if (!dateString) return "--"
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Contact History
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="space-y-4 mt-6">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : contact ? (
          <div className="mt-6 space-y-6">
            {/* Contact Info */}
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">
                {contact.first_name} {contact.last_name}
              </h3>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Phone className="h-4 w-4" />
                  {contact.phone || "--"}
                </span>
              </div>
              {contact.buyer_stage && (
                <Badge variant="outline">{contact.buyer_stage}</Badge>
              )}
            </div>

            <Separator />

            {/* Engagement Score */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Engagement Score</span>
                <span className="text-2xl font-bold">{engagementScore || 0}</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div 
                  className="h-full bg-primary transition-all"
                  style={{ width: `${engagementScore || 0}%` }}
                />
              </div>
            </div>

            <Separator />

            {/* ISA Calls History */}
            <div>
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <Activity className="h-4 w-4" />
                ISA Call History
              </h4>
              {calls.length === 0 ? (
                <p className="text-sm text-muted-foreground">No ISA calls yet</p>
              ) : (
                <div className="space-y-2">
                  {calls.map((call) => (
                    <div 
                      key={call.id} 
                      className="flex items-center justify-between p-2 rounded border text-sm"
                    >
                      <div className="flex items-center gap-2">
                        {call.appointment_set ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span>{formatDate(call.created_at)}</span>
                      </div>
                      {call.voice_call_id && (
                        <Link 
                          href={`/dashboard/voice/review/${call.voice_call_id}`}
                          className="text-primary hover:underline"
                        >
                          Review
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Qualifications */}
            <div>
              <h4 className="text-sm font-medium mb-3">Qualification Summary</h4>
              {qualifications.length === 0 ? (
                <p className="text-sm text-muted-foreground">No qualifications recorded</p>
              ) : (
                <div className="space-y-2">
                  {qualifications.map((qual) => (
                    <div 
                      key={qual.id} 
                      className="p-2 rounded border text-sm"
                    >
                      <div className="flex items-center justify-between">
                        <Badge 
                          variant={qual.qualification_result === "qualified" ? "default" : "secondary"}
                        >
                          {qual.qualification_result || "Pending"}
                        </Badge>
                        <span className="text-muted-foreground">
                          Score: {qual.qualification_score || "--"}
                        </span>
                      </div>
                      {qual.notes && (
                        <p className="text-xs text-muted-foreground mt-1">{qual.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-4">
              <Button asChild className="flex-1">
                <Link href={`/crm/contacts/${contact.id}`}>
                  View Full Contact
                  <ExternalLink className="h-4 w-4 ml-2" />
                </Link>
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={calling || !contact.phone}
                onClick={handleManualCall}
              >
                <Phone className="h-4 w-4 mr-2" />
                {calling ? "Ringing you…" : "Manual Call"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">Contact not found</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
