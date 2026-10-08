import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Package, ArrowLeft, Plus } from 'lucide-react'
import Link from 'next/link'
import { TitleOrderRow } from './title-order-row'

export const dynamic = 'force-dynamic'

/**
 * The reader for `title_orders`.
 *
 * DEFECT FIXED (w6s3): this page is called "Title Orders", `/title/orders/new`
 * writes a `title_orders` row through `partner-orders.ts:createTitleOrder` and then
 * `router.push('/title/orders')` — and this page listed `transactions`, not
 * `title_orders`. So every order a title partner created came back "created" and
 * then was nowhere to be seen, and `revalidatePath('/title/orders')` in the writer
 * refreshed a list that could never contain it. The `transactions` read also carried
 * NO tenant predicate of its own.
 *
 * It now lists the orders themselves, brokerage-scoped on the predicate as well as by
 * RLS (`title_orders_select` = is_platform_admin() OR has_brokerage_access(brokerage_id),
 * verified live), and `error` is destructured — supabase-js resolves a refused query,
 * and rendering a refusal as "No title orders" would be a false all-clear on a page
 * whose whole job is telling a closing team whether title is clear.
 */
export default async function TitleOrdersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const ctx = await getAgentContext()
  if (!ctx.brokerageId) {
    return (
      <div className="p-6 space-y-6">
        <Header count={0} />
        <Card>
          <CardContent className="text-center py-12 text-gray-500">
            This account is not attached to a brokerage, so it has no title orders to show.
          </CardContent>
        </Card>
      </div>
    )
  }

  const { data: orders, error } = await supabase
    .from('title_orders')
    .select('id, property_address, status, closing_date, completed_at, created_at, search_result, transaction_id')
    .eq('brokerage_id', ctx.brokerageId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    return (
      <div className="p-6 space-y-6">
        <Header count={0} />
        <Card>
          <CardContent className="text-center py-12 text-red-600">
            Title orders could not be loaded: {error.message}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <Header count={orders?.length ?? 0} />
      {(!orders || orders.length === 0) ? (
        <Card><CardContent className="text-center py-12 text-gray-500">No title orders yet</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {orders.map((o: any) => (
            <TitleOrderRow
              key={o.id}
              order={{
                id: o.id,
                property_address: o.property_address,
                status: o.status,
                closing_date: o.closing_date,
                completed_at: o.completed_at,
                created_at: o.created_at,
                search_result: o.search_result ?? null,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Header({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Link href="/title/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="w-6 h-6 text-blue-600" />
            Title Orders
          </h1>
          <p className="text-gray-500 text-sm">{count} {count === 1 ? 'order' : 'orders'}</p>
        </div>
      </div>
      <Link href="/title/orders/new">
        <Button size="sm" className="gap-1.5"><Plus className="w-4 h-4" /> New order</Button>
      </Link>
    </div>
  )
}
