'use client'
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArrowLeft, PhoneCall } from 'lucide-react'
import Link from 'next/link'

export default function ISADialPage() {
  const [number, setNumber] = useState('')
  const [calling, setCalling] = useState(false)

  const handleDial = () => {
    if (!number.trim()) return
    setCalling(true)
    // Trigger voice call via Vapi/Twilio
    setTimeout(() => setCalling(false), 2000)
  }

  const DIAL_PAD = ['1','2','3','4','5','6','7','8','9','*','0','#']

  return (
    <div className="p-6 max-w-sm mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/isa/calling"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold">Quick Dial</h1>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-center">Dial a Number</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={number}
            onChange={e => setNumber(e.target.value)}
            placeholder="(555) 000-0000"
            className="text-center text-xl font-mono h-12"
            type="tel"
          />
          <div className="grid grid-cols-3 gap-2">
            {DIAL_PAD.map(key => (
              <Button
                key={key}
                variant="outline"
                className="h-12 text-lg font-semibold"
                onClick={() => setNumber(prev => prev + key)}
              >
                {key}
              </Button>
            ))}
          </div>
          <Button
            className="w-full h-12 bg-green-600 hover:bg-green-700 text-white text-lg"
            onClick={handleDial}
            disabled={calling || !number.trim()}
          >
            <PhoneCall className="w-5 h-5 mr-2" />
            {calling ? 'Connecting...' : 'Call'}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setNumber(prev => prev.slice(0, -1))}
          >
            Backspace
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
