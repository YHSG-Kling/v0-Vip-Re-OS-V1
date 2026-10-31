import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Upload } from 'lucide-react'
import { PortfolioUploadForm } from './portfolio-upload-form'

export const dynamic = 'force-dynamic'

/**
 * /vendor/portfolio/upload — the real upload (wave 147, lane 147H; owner ruling 9).
 *
 * HISTORY: wave 146H replaced a fake form (its submit was `setTimeout(() => router.push(...), 1000)`; files discarded)
 * with an honest "Portfolio uploads are not available yet" state, because there was nothing to wire it TO — no store,
 * no writer, no reader. Lane 147H built the missing half: the m906 store (public.vendor_portfolio_items), the writer
 * app/actions/vendor-portfolio.ts addVendorPortfolioItem (session-proved vendor via requireVendorActor, a private
 * `documents` object, withActionLedger vendor.portfolio_item.add) and the readers (/vendor/portfolio and the vendor
 * directory). The form below posts to that server action — no timer, no discard.
 */
export default async function VendorPortfolioUploadPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/vendor/portfolio" aria-label="Back to portfolio"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Upload className="w-6 h-6 text-primary" />
          Add portfolio work
        </h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <PortfolioUploadForm />
        </CardContent>
      </Card>
    </div>
  )
}
