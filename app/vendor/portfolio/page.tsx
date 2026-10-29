import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readRoleGrants, selectVendorId } from '@/lib/auth/role-grants'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Image, ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function VendorPortfolioPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Same vendor-resolution shape as the rest of /vendor — read every grant and
  // choose, because user_role_assignments is UNIQUE on (user_id, role), not on
  // user_id, and `.maybeSingle()` over two vendor-bearing grants is an error that
  // supabase-js resolves into a silent "no vendor".
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    console.error('[vendor/portfolio] role grant read failed:', grantsResult.error)
  }
  const { vendorId: portfolioVendorId } = grantsResult.ok
    ? selectVendorId(grantsResult.grants)
    : { vendorId: null }

  const { data: vendor } = portfolioVendorId
    ? await supabase
        .from('vendors')
        .select('id, name, category, notes, rating, website')
        .eq('id', portfolioVendorId)
        .maybeSingle()
    : { data: null }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/vendor/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Image className="w-6 h-6 text-purple-600" />
              My Portfolio
            </h1>
          </div>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link href="/vendor/portfolio/upload">
            <Plus className="w-4 h-4 mr-2" />
            Add Work (not available yet)
          </Link>
        </Button>
      </div>
      {vendor ? (
        <Card>
          <CardHeader><CardTitle className="text-base">{vendor.name} — {vendor.category}</CardTitle></CardHeader>
          <CardContent>
            {vendor.notes && <p className="text-sm text-gray-600 mb-3">{vendor.notes}</p>}
            {vendor.website && <a href={vendor.website} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">{vendor.website}</a>}
            {vendor.rating > 0 && <p className="text-sm mt-2">Rating: {vendor.rating}/5</p>}
            {/* Wave 146 (lane 146H, ruling 16): this line used to read "No portfolio items yet. Add your
                completed work…" — an empty state the page could not know (there is no portfolio store to
                read) inviting an upload that discarded its files. It now says what is true. */}
            <p className="text-sm text-gray-600 mt-4 text-center py-4">Portfolio uploads are not available yet — agents see the profile above and your reviews.</p>
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="text-center py-12 text-gray-500">No vendor profile found. Contact your administrator.</CardContent></Card>
      )}
    </div>
  )
}
