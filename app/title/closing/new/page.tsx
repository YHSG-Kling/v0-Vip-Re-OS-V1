import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Calendar, ArrowLeft, Info } from 'lucide-react'

export const dynamic = 'force-dynamic'

/**
 * /title/closing/new — an HONEST state, not a form (wave 146, lane 146H; owner ruling 16: "no dead
 * controls or misleading statuses").
 *
 * WHAT WAS HERE: "Schedule New Closing" — address, client, date, time, location — whose submit handler
 * was `setLoading(true); setTimeout(() => router.push('/title/closing'), 1000)`. The button read
 * "Scheduling…", nothing was written, and the closing never appeared on the schedule, because the
 * schedule (app/title/closing/page.tsx) reads `transactions.close_date` — the DEAL's closing date.
 *
 * That is also the business rule: the closing date is a term of the executed contract, owned by the
 * brokerage's transaction. A change to it is an amendment / addendum on the deal (owner ruling 1, wave
 * 146: addenda between transaction creation and closing go through the versioned governing-terms path),
 * never a free-standing title-side record. What a title company DOES need — proposing an appointment
 * time and place for an existing closing date — has no writer at HEAD; it is routed as MISSING in lane
 * 146H's notes ("## Outside-lane"). Until it exists, this page says so and sends the user to the deal.
 */
export default async function NewClosingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/title/closing" aria-label="Back to the closing schedule"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calendar className="w-6 h-6 text-purple-700" />
          Schedule a Closing
        </h1>
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4" role="status">
            <Info className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-blue-900">Closing dates come from the deal</p>
              <p className="text-sm text-blue-900">
                A closing date is part of the signed contract, so it is set — and changed, by amendment — on the
                brokerage&apos;s transaction. Every deal with a closing date already appears on your closing
                schedule. To move a date, ask the deal&apos;s transaction coordinator; booking an appointment time and
                place from here is not available yet.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/title/closing">Open the closing schedule</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/title/orders">My title orders</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
