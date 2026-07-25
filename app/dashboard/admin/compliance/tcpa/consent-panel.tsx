"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { ShieldCheck, Loader2, Phone } from "lucide-react"
import { recordContactConsentAction } from "@/app/actions/tcpa-compliance"

export interface MissingConsentContact {
  id: string
  name: string
  phone: string | null
}

/**
 * Actionable TCPA control: the contacts that are reachable-by-phone but have NO
 * express written consent on file (so non-transactional SMS/calls to them are
 * blocked by the gate). Staff records consent here after obtaining it — writing
 * the real consent columns + the contact_consent_events audit trail.
 */
export function ConsentPanel({ initialMissing }: { initialMissing: MissingConsentContact[] }) {
  const [missing, setMissing] = useState(initialMissing)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  async function record(contactId: string) {
    setBusyId(contactId)
    try {
      const res = await recordContactConsentAction({
        contactId,
        consented: true,
        note: notes[contactId]?.trim() || undefined,
      })
      if (res.success) {
        toast.success("Consent recorded", { description: "The contact can now receive consented outreach." })
        setMissing((prev) => prev.filter((c) => c.id !== contactId))
      } else {
        toast.error(res.error ?? "Could not record consent")
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Record express consent
        </CardTitle>
        <CardDescription className="text-xs">
          Contacts with a phone but no TCPA consent on file — non-transactional SMS/calls to them are
          blocked. After obtaining written/verbal consent, record it here (writes the consent columns
          + an audit event). Note how consent was obtained.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {missing.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Every phone-reachable contact has consent on file. 🎉
          </p>
        ) : (
          <div className="divide-y">
            {missing.map((c) => (
              <div key={c.id} className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{c.name || "Unnamed contact"}</p>
                  {c.phone && (
                    <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {c.phone}
                    </p>
                  )}
                </div>
                <Input
                  value={notes[c.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                  placeholder="How obtained (e.g. open-house sign-in)"
                  className="h-8 text-xs sm:w-64"
                />
                <Button size="sm" onClick={() => record(c.id)} disabled={busyId === c.id}>
                  {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Record consent"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
