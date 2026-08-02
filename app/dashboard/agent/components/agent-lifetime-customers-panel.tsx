"use client"

import Link from "next/link"
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Heart, Home, Loader2 } from "lucide-react"
import { LifeSignalBadge } from "@/app/components/shared/LifeSignalBadge"
import { sendAnniversaryMessage } from "@/app/actions/lifetime-customer-touchpoints"

interface Anniversary {
  id: string
  actual_close_date: string
  property_address: string
  sale_price?: number
  contacts: { id: string; first_name: string; last_name: string }
}

interface LifeChange {
  id: string
  change_type: string
  detected_at: string
  contacts: { id: string; first_name: string; last_name: string } | null
}

interface AgentLifetimeCustomersPanelProps {
  anniversaries: Anniversary[]
  lifeChanges: LifeChange[]
  loading: boolean
}

export function AgentLifetimeCustomersPanel({
  anniversaries,
  lifeChanges,
  loading
}: AgentLifetimeCustomersPanelProps) {
  // Above the loading early-return on purpose: hooks cannot be called
  // conditionally, and this component returns a skeleton before this point.
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sendResult, setSendResult] = useState<{ id: string; ok: boolean; message: string } | null>(null)

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-red-500" />
            Lifetime Customer Opportunities
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-20 bg-muted rounded animate-pulse" />
          ))}
        </CardContent>
      </Card>
    )
  }

  const hasAnniversaries = anniversaries.length > 0
  const hasLifeChanges = lifeChanges.length > 0
  const isEmpty = !hasAnniversaries && !hasLifeChanges

  // Which anniversary this is. Deliberately the CALENDAR-YEAR difference, the
  // same arithmetic the touchpoint cron uses, because this number is spoken to
  // the client ("it's been N years"). Elapsed-days/365 floors an anniversary
  // that is a few days away down to N-1, so the card and the message the button
  // sends would disagree about how long they have owned the house.
  const getYearsCount = (dateStr: string) =>
    new Date().getFullYear() - new Date(dateStr).getFullYear()

  // sendAnniversaryMessage has BOTH failure modes: it RETURNS {success:false}
  // when the contact has no email or the compliance gate refuses, and it THROWS
  // when the session or the contact row is missing. Checking only one of those
  // reports a refusal as a send.
  const handleSendAnniversary = async (ann: Anniversary) => {
    setSendingId(ann.id)
    setSendResult(null)
    try {
      const res = await sendAnniversaryMessage(ann.contacts.id, getYearsCount(ann.actual_close_date))
      setSendResult(
        res.success
          ? { id: ann.id, ok: true, message: "Anniversary message sent" }
          : { id: ann.id, ok: false, message: res.error ?? "The message was not sent" },
      )
    } catch (err: any) {
      setSendResult({ id: ann.id, ok: false, message: err?.message ?? "The message was not sent" })
    } finally {
      setSendingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="h-5 w-5 text-red-500" />
          Lifetime Customer Opportunities
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div className="text-center py-6">
            <Heart className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <Link href="/lifetime-customers" className="text-sm text-primary hover:underline">
              Open Relationship Intelligence →
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Anniversaries - Top 3 */}
            {hasAnniversaries && (
              <div className="space-y-3">
                {anniversaries.slice(0, 3).map((ann) => (
                  <div key={ann.id} className="p-3 bg-muted/50 rounded-lg">
                    <div className="flex items-start gap-2">
                      <Home className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-medium">
                          {ann.contacts.first_name}&apos;s Home Anniversary
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {getYearsCount(ann.actual_close_date)} years · {ann.property_address}
                        </p>
                        <div className="flex gap-2 mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={sendingId === ann.id}
                            onClick={() => handleSendAnniversary(ann)}
                          >
                            {sendingId === ann.id && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            {sendingId === ann.id ? "Sending…" : "Send AI Message"}
                          </Button>
                          <Link href={`/portal/${ann.contacts.id}`}>
                            <Button variant="ghost" size="sm" className="h-7 text-xs">
                              Open Portal
                            </Button>
                          </Link>
                        </div>
                        {sendResult?.id === ann.id && (
                          <p
                            className={`text-xs mt-1 ${sendResult.ok ? "text-emerald-600" : "text-destructive"}`}
                          >
                            {sendResult.message}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Life Changes - Max 2 */}
            {hasLifeChanges && (
              <div className="space-y-2">
                {lifeChanges.slice(0, 2).map((change) => (
                  <div key={change.id} className="flex items-center justify-between">
                    <LifeSignalBadge
                      signal={{
                        id: change.id,
                        change_type: change.change_type,
                        detected_at: change.detected_at,
                        contacts: change.contacts,
                      }}
                    />
                    {change.contacts && (
                      <Link href={`/crm/contacts/${change.contacts.id}`} className="text-xs text-primary hover:underline">
                        Open Record
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="pt-2">
              <Link href="/lifetime-customers" className="text-sm text-primary hover:underline">
                View All Lifetime Customers →
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
