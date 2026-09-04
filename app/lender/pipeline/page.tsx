import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TrendingUp, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { lenderVendorForUser, lenderVendorTransactionIds, lenderFilterIds } from '@/lib/kernel/lender-linkage'

export const dynamic = 'force-dynamic'

/**
 * LOAN PIPELINE — the lender's OWN assigned deals.
 *
 * WHAT WAS WRONG, AND WHY IT RENDERED AS AN EMPTY PRODUCT RATHER THAN AN ERROR.
 * This page checked only that SOMEBODY was signed in and then selected from
 * `transactions` with NO assignment filter at all — every deal in the database,
 * trimmed to 50. It survived only because RLS refused it: public.transactions
 * carries five SELECT policies and the external-partner one reads
 * `current_user_type() = 'vendor' AND vendor_has_transaction_access(id)`. A user
 * typed 'lender' matches NONE of the five, so the read came back EMPTY — and
 * supabase-js RESOLVES a refusal (CLAUDE.md §3), so `{ data }` alone turned a
 * denied query into a clean, permanent "0 active loans". The page was dead for
 * every lender who ever opened it.
 *
 * THE FIX IS NOT A RENAME. Under the owner's ruling — "lender is not a user
 * type, it is a vendor category" — a lender is a VENDOR whose vendors.category
 * is 'lender', so the existing vendor policy admits them, and the deals are the
 * ones their vendor is ASSIGNED to (vendor_assignments). That is exactly the
 * path the sibling surfaces already use:
 *   app/lender/dashboard/page.tsx:33-45
 *   app/(external-portal)/lender/transactions/page.tsx:20-26
 * and it is resolved here through the ONE source of truth,
 * lib/kernel/lender-linkage.ts — not a second copy of the query.
 *
 * The read's `error` is READ. "Nobody could check" must never render as
 * "checked, and you have nothing" (CLAUDE.md §4, fail closed).
 */
export default async function LenderPipelinePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // LENDERS ARE VENDORS — resolve the caller's own lender vendor from the
  // SESSION (user_role_assignments.vendor_id → a lender-category vendor).
  // Nothing here comes from the request.
  const lenderVendor = await lenderVendorForUser(supabase, user.id)

  const header = (
    <div className="flex items-center gap-3">
      <Link href="/lender/dashboard">
        <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
      </Link>
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-blue-600" />
          Loan Pipeline
        </h1>
      </div>
    </div>
  )

  if (!lenderVendor) {
    return (
      <div className="p-6 space-y-6">
        {header}
        <Card>
          <CardContent className="text-center py-12 text-gray-500">
            This account is not linked to a lender on the vendor bench, so it has no loan
            pipeline. Ask the brokerage to invite you as a vendor in the lender category.
          </CardContent>
        </Card>
      </div>
    )
  }

  // Only the transactions this lender vendor is assigned to, pinned to its own
  // brokerage. lenderFilterIds keeps the `.in()` non-empty — an empty PostgREST
  // `.in()` can error, and "no deals" must not read as "the query broke".
  const txnIds = lenderFilterIds(
    await lenderVendorTransactionIds(supabase, lenderVendor.vendorId, lenderVendor.brokerageId),
  )

  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('id, property_address, status, contract_price:purchase_price, client_name, close_date, transaction_type:deal_type, created_at')
    .in('id', txnIds)
    .order('close_date', { ascending: true })
    .limit(50)

  // §3 — a refused read resolves. Say so instead of showing an empty pipeline.
  if (error) {
    return (
      <div className="p-6 space-y-6">
        {header}
        <Card>
          <CardContent className="text-center py-12 text-red-600">
            Your pipeline could not be read just now, so it is not being shown. This is not
            an empty pipeline — please retry.
          </CardContent>
        </Card>
      </div>
    )
  }

  const rows = transactions ?? []

  const statusGroups: Record<string, any[]> = {}
  rows.forEach((t: any) => {
    const key = t.status || 'unknown'
    if (!statusGroups[key]) statusGroups[key] = []
    statusGroups[key].push(t)
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/lender/dashboard">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-blue-600" />
            Loan Pipeline
          </h1>
          <p className="text-gray-500 text-sm">
            {rows.length} active loans · {lenderVendor.name ?? 'your lender bench'}
          </p>
        </div>
      </div>

      {Object.entries(statusGroups).map(([status, items]) => (
        <div key={status}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
            {status.replace(/_/g, ' ')}
            <Badge variant="outline">{items.length}</Badge>
          </h3>
          <div className="space-y-2">
            {items.map((t: any) => (
              <Card key={t.id}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t.property_address || 'Address TBD'}</p>
                    <p className="text-sm text-gray-500">{t.client_name} · {t.transaction_type}</p>
                    {t.close_date && <p className="text-xs text-gray-400">Close: {new Date(t.close_date).toLocaleDateString()}</p>}
                  </div>
                  <div className="text-right">
                    {t.contract_price && (
                      <p className="font-semibold text-green-700">${t.contract_price.toLocaleString()}</p>
                    )}
                    <Badge variant="outline" className="text-xs">{status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <Card>
          <CardContent className="text-center py-12 text-gray-500">
            No active loans in your pipeline
          </CardContent>
        </Card>
      )}
    </div>
  )
}
