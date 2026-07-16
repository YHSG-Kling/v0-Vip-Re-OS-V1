'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Package, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { createTitleOrder } from '@/app/actions/partner-orders'

export default function NewTitleOrderPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ property_address: '', client_name: '', close_date: '', notes: '', search_status: 'ordered' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    // Real writer (was a fake-success stub): title_orders row with the search
    // outcome — a clean search is 'clear', a found problem is 'issue'.
    const result = await createTitleOrder({
      propertyAddress: form.property_address,
      closingDate: form.close_date || null,
      status: form.search_status as 'ordered' | 'in_progress' | 'clear' | 'issue',
      searchResult: form.notes || form.client_name
        ? { client_name: form.client_name || null, notes: form.notes || null }
        : null,
    })
    setLoading(false)
    if (result.success) {
      router.push('/title/orders')
    } else {
      setError(result.error ?? 'Failed to create title order')
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/orders"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="w-6 h-6 text-blue-600" />
          New Title Order
        </h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Property Address</Label>
              <Input value={form.property_address} onChange={e => setForm({...form, property_address: e.target.value})} placeholder="123 Main St, City, State" required />
            </div>
            <div>
              <Label>Client Name</Label>
              <Input value={form.client_name} onChange={e => setForm({...form, client_name: e.target.value})} placeholder="Buyer/Seller name" required />
            </div>
            <div>
              <Label>Projected Close Date</Label>
              <Input type="date" value={form.close_date} onChange={e => setForm({...form, close_date: e.target.value})} />
            </div>
            <div>
              <Label>Title Search Status</Label>
              <select
                value={form.search_status}
                onChange={e => setForm({...form, search_status: e.target.value})}
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
              >
                <option value="ordered">Ordered — search not run yet</option>
                <option value="in_progress">Search in progress</option>
                <option value="clear">Search complete — CLEAR</option>
                <option value="issue">Search complete — issue found</option>
              </select>
            </div>
            <div>
              <Label>Search Notes / Findings</Label>
              <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Liens, exceptions, findings…" />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white" disabled={loading}>
                {loading ? 'Creating...' : 'Create Title Order'}
              </Button>
              <Link href="/title/orders"><Button variant="outline" type="button">Cancel</Button></Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
