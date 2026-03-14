'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Package, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function NewTitleOrderPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ property_address: '', client_name: '', close_date: '', notes: '' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    // In production: call createTransaction action with transaction_type='purchase'
    setTimeout(() => { router.push('/title/orders') }, 1000)
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
              <Label>Notes</Label>
              <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Additional notes..." />
            </div>
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
