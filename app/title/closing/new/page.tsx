import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Calendar, ArrowLeft, Info } from 'lucide-react'
import { listClosingDealsForTitle, listMyClosingAppointmentProposals } from '@/app/actions/title/closing-appointment'
import { ClosingAppointmentForm } from './closing-appointment-form'

export const dynamic = 'force-dynamic'

/**
 * /title/closing/new — PROPOSE THE CLOSING APPOINTMENT (wave 147, lane 147H; owner ruling 9).
 *
 * HISTORY: a fake "Schedule New Closing" form once stood here (`setTimeout(() => router.push('/title/closing'), 1000)`,
 * nothing written); wave 146H replaced it with an honest state that ended "booking an appointment time and place from
 * here is not available yet" and routed the writer as MISSING.
 *
 * THE BUSINESS RULE (unchanged): a closing DATE is part of the signed contract — set and changed by amendment on the
 * brokerage's transaction, never a free-standing title-side record. What the title company owns is the settlement
 * APPOINTMENT on that date — time and place. Lane 147H built that writer: app/actions/title/closing-appointment.ts
 * proposeClosingAppointment, gated to the deal's title party, lands the proposal as the deal agent's task (the agent
 * confirms with the clients) under withActionLedger.
 *
 * WAVE 149 (lane 149G — owner ruling 17 / C33, REVERSING "a different day is an amendment"): under an "on or before"
 * contract an EARLIER day is within the contract and needs no executed amendment unless the state's sourced rule says
 * so — the door proposes it (lib/transactions/closing-dates.ts assessClosingDateChange judges the day). A later day, or a
 * day the contract fixes ("on"), is still refused as the amendment / extension it is.
 */
export default async function NewClosingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [deals, proposals] = await Promise.all([listClosingDealsForTitle(), listMyClosingAppointmentProposals()])

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/title/closing" aria-label="Back to the closing schedule"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calendar className="w-6 h-6 text-primary" />
          Propose a closing appointment
        </h1>
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border bg-muted p-4" role="note">
            <Info className="w-5 h-5 text-foreground shrink-0 mt-0.5" />
            <p className="text-sm text-foreground">
              The closing date is part of the signed contract and stays on the deal. Propose the time and place; the
              deal&apos;s agent confirms it with the clients. When the contract says &quot;on or before&quot; you may propose an
              earlier day — that needs no amendment. A later day, or a different day when the contract fixes the day, is
              an amendment for the transaction coordinator.
            </p>
          </div>
          {!deals.ok ? (
            <p className="text-sm text-destructive">{deals.error}</p>
          ) : deals.deals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upcoming closings on deals you are a party to. <Link href="/title/orders" className="font-medium text-primary underline-offset-4 hover:underline">See your title orders</Link>.</p>
          ) : (
            <ClosingAppointmentForm deals={deals.deals} />
          )}
        </CardContent>
      </Card>
      {proposals.ok && proposals.proposals.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Your proposals</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {proposals.proposals.map((p) => (
                <li key={p.id} className="rounded border p-3 text-sm">
                  <p className="font-medium text-foreground">{p.title}</p>
                  <p className="text-muted-foreground">Agent&apos;s status: {p.status === 'completed' ? 'confirmed' : p.status ?? 'pending'}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
