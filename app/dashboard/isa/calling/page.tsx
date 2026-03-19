import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Phone, PhoneCall, ArrowLeft, Mic, User } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function ISACallingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('users').select('brokerage_id').eq('id', user.id).single()

  const { data: contacts } = profile?.brokerage_id ? await supabase
    .from('contacts')
    .select('id, first_name, last_name, phone, status, contact_type')
    .eq('brokerage_id', profile.brokerage_id)
    .not('phone', 'is', null)
    .in('status', ['new', 'contacted'])
    .order('created_at', { ascending: false })
    .limit(20) : { data: [] }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/isa"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Phone className="w-6 h-6 text-green-600" />
              Calling Queue
            </h1>
            <p className="text-gray-500 text-sm">{contacts?.length || 0} leads to contact</p>
          </div>
        </div>
        <Link href="/dashboard/voice/isa">
          <Button className="bg-green-600 hover:bg-green-700 text-white">
            <Mic className="w-4 h-4 mr-2" />
            Open Voice ISA
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Call Queue</CardTitle></CardHeader>
        <CardContent>
          {(!contacts || contacts.length === 0) ? (
            <p className="text-sm text-gray-500 text-center py-8">No leads in calling queue</p>
          ) : (
            <div className="space-y-2">
              {contacts.map((contact: any) => (
                <div key={contact.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                      <User className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{contact.first_name} {contact.last_name}</p>
                      <p className="text-xs text-gray-500">{contact.phone} · {contact.contact_type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">{contact.status}</Badge>
                    <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white text-xs">
                      <PhoneCall className="w-3 h-3 mr-1" />
                      Call
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
