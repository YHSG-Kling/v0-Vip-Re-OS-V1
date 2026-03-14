import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Image, ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function VendorPortfolioPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, name, category, notes, rating, website, portfolio_urls')
    .eq('user_id', user.id)
    .maybeSingle()

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
        <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
          <Plus className="w-4 h-4 mr-2" />
          Add Work
        </Button>
      </div>
      {vendor ? (
        <Card>
          <CardHeader><CardTitle className="text-base">{vendor.name} — {vendor.category}</CardTitle></CardHeader>
          <CardContent>
            {vendor.notes && <p className="text-sm text-gray-600 mb-3">{vendor.notes}</p>}
            {vendor.website && <a href={vendor.website} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">{vendor.website}</a>}
            {vendor.rating > 0 && <p className="text-sm mt-2">Rating: {vendor.rating}/5</p>}
            {(!vendor.portfolio_urls || vendor.portfolio_urls.length === 0) && (
              <p className="text-sm text-gray-400 mt-4 text-center py-4">No portfolio items yet. Add your completed work to attract more clients.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="text-center py-12 text-gray-500">No vendor profile found. Contact your administrator.</CardContent></Card>
      )}
    </div>
  )
}
