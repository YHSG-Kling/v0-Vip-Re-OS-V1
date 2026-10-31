import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Image, ArrowLeft, Plus, FileText } from 'lucide-react'
import Link from 'next/link'
import { listMyVendorPortfolio } from '@/app/actions/vendor-portfolio'
import { RemovePortfolioItemButton } from './remove-portfolio-item-button'

export const dynamic = 'force-dynamic'

/**
 * /vendor/portfolio — the vendor's work samples (wave 147, lane 147H; owner ruling 9: build what said "not available
 * yet"). It used to read the vendors row and say "Portfolio uploads are not available yet" because no store existed;
 * the store is m906 (public.vendor_portfolio_items), the writer and readers are app/actions/vendor-portfolio.ts, and
 * agents see the same items in the vendor directory. The vendor is resolved from the SESSION's grants inside the
 * action (requireVendorActor); a database without m906 reads an honest "missing from this database" note naming it.
 */
export default async function VendorPortfolioPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const res = await listMyVendorPortfolio()

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/vendor/dashboard"><Button variant="ghost" size="sm" aria-label="Back to the vendor dashboard"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Image className="w-6 h-6 text-primary" />
              My Portfolio
            </h1>
            <p className="text-sm text-muted-foreground">Work samples agents in your brokerage see beside your reviews.</p>
          </div>
        </div>
        {res.ok && res.available && (
          <Button size="sm" asChild>
            <Link href="/vendor/portfolio/upload">
              <Plus className="w-4 h-4 mr-2" />
              Add work
            </Link>
          </Button>
        )}
      </div>

      {!res.ok ? (
        <Card><CardContent className="py-8 text-center text-sm text-destructive">{res.error}</CardContent></Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{res.vendor ? `${res.vendor.name}${res.vendor.category ? ` — ${res.vendor.category}` : ''}` : 'Your work'}</CardTitle>
          </CardHeader>
          <CardContent>
            {res.note && <p className="mb-4 rounded-md border bg-muted p-3 text-sm text-foreground" role="status">{res.note}</p>}
            {res.available && res.items.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No work samples yet. <Link href="/vendor/portfolio/upload" className="font-medium text-primary underline-offset-4 hover:underline">Add your first one</Link> — a photo of finished work or a PDF.
              </p>
            )}
            {res.items.length > 0 && (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {res.items.map((it) => (
                  <li key={it.id} className="rounded-lg border bg-card p-3 space-y-2">
                    {it.url && it.mediaKind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.url} alt={it.title} className="h-40 w-full rounded object-cover" />
                    ) : (
                      <a href={it.url ?? undefined} target="_blank" rel="noreferrer" className="flex h-40 items-center justify-center gap-2 rounded bg-muted text-sm text-foreground">
                        <FileText className="h-5 w-5" /> {it.url ? 'Open PDF' : 'File unavailable'}
                      </a>
                    )}
                    <p className="font-medium text-foreground">{it.title}</p>
                    {it.description && <p className="text-sm text-muted-foreground">{it.description}</p>}
                    <RemovePortfolioItemButton itemId={it.id} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
