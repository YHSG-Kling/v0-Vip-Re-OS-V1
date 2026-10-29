import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Upload, Info } from 'lucide-react'

export const dynamic = 'force-dynamic'

/**
 * /vendor/portfolio/upload — an HONEST "not available yet" state (wave 146, lane 146H; owner ruling 16:
 * "no dead controls or misleading statuses"; the wave-141 lane rule: a surface that cannot be wired is
 * hidden behind an honest "not available yet" state, never a dead click).
 *
 * WHAT WAS HERE: a client form titled "Upload Portfolio Work" whose submit handler was
 * `setLoading(true); setTimeout(() => router.push('/vendor/portfolio'), 1000)` — the button read
 * "Uploading…", the files and the description were discarded, and the vendor was returned to a
 * portfolio that could never show them. MEASURED: no portfolio table exists in the live schema
 * (scripts/live-tables.ts has vendor_marketplace_profiles, vendor_reviews, vendor_jobs … and no
 * portfolio / gallery store) and no action under app/actions writes one, so there was nothing to wire
 * the form TO. The capability is MISSING (storage + a vendor-scoped writer + a reader on the vendor
 * directory) and is routed in lane 146H's notes ("## Outside-lane"); this page no longer pretends.
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
          <Upload className="w-6 h-6 text-purple-700" />
          Upload Portfolio Work
        </h1>
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
            <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-900">Portfolio uploads are not available yet</p>
              <p className="text-sm text-amber-900">
                Nothing you upload can be stored or shown to agents yet, so this page does not take files.
                What agents see today is your profile — your company name, category, website and notes — and
                your reviews.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/vendor/settings">Update my profile</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/vendor/reviews">See my reviews</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
