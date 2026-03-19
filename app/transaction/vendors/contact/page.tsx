'use client'
import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Users, ArrowLeft, Send } from 'lucide-react'
import Link from 'next/link'

export default function VendorContactPage() {
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({ vendor_type: '', message: '', urgency: 'normal' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => { setSent(true); setLoading(false) }, 1000)
  }

  if (sent) {
    return (
      <div className="p-6 max-w-md text-center">
        <div className="text-green-600 text-5xl mb-4">&#10003;</div>
        <h2 className="text-xl font-bold mb-2">Request Sent</h2>
        <p className="text-muted-foreground mb-4">Your vendor coordination request has been submitted.</p>
        <Link href="/transaction/vendors"><Button variant="outline">Back to Vendors</Button></Link>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/transaction/vendors"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="w-6 h-6 text-orange-600" />
          Contact Vendor
        </h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Vendor Type Needed</Label>
              <Input value={form.vendor_type} onChange={e => setForm({...form, vendor_type: e.target.value})} placeholder="e.g. Inspector, Appraiser, Handyman" required />
            </div>
            <div>
              <Label>Message / Request Details</Label>
              <Textarea value={form.message} onChange={e => setForm({...form, message: e.target.value})} placeholder="Describe what you need..." rows={4} required />
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="bg-orange-600 hover:bg-orange-700 text-white" disabled={loading}>
                <Send className="w-4 h-4 mr-2" />
                {loading ? 'Sending...' : 'Send Request'}
              </Button>
              <Link href="/transaction/vendors"><Button variant="outline" type="button">Cancel</Button></Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
