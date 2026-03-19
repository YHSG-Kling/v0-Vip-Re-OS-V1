'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Calendar, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

export default function NewClosingPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ property_address: '', client_name: '', close_date: '', close_time: '10:00', location: '' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => { router.push('/title/closing') }, 1000)
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/title/closing"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Calendar className="w-6 h-6 text-purple-600" />
          Schedule New Closing
        </h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Property Address</Label>
              <Input value={form.property_address} onChange={e => setForm({...form, property_address: e.target.value})} required placeholder="123 Main St" />
            </div>
            <div>
              <Label>Client Name</Label>
              <Input value={form.client_name} onChange={e => setForm({...form, client_name: e.target.value})} required placeholder="Client name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Closing Date</Label>
                <Input type="date" value={form.close_date} onChange={e => setForm({...form, close_date: e.target.value})} required />
              </div>
              <div>
                <Label>Closing Time</Label>
                <Input type="time" value={form.close_time} onChange={e => setForm({...form, close_time: e.target.value})} />
              </div>
            </div>
            <div>
              <Label>Location</Label>
              <Input value={form.location} onChange={e => setForm({...form, location: e.target.value})} placeholder="Office address or virtual" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white" disabled={loading}>
                {loading ? 'Scheduling...' : 'Schedule Closing'}
              </Button>
              <Link href="/title/closing"><Button variant="outline" type="button">Cancel</Button></Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
