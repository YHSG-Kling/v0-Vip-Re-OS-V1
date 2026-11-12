'use client'

// app/get-started/prospect-chat.tsx — THE WEBSITE PROSPECT CHAT WIDGET (lane 76B).
// The public-site door onto the platform's ONE prospect brain
// (app/api/platform/prospect-chat/route.ts). Mounted on /get-started and /demo.
// The route keeps no session: the transcript lives in this component and is
// sent whole on every turn (bounded server-side), and the prospect's identity
// is whatever email THEY give in the conversation — never an id in the body.
import { useState, useRef, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, MessageSquare } from 'lucide-react'

interface Msg { role: 'user' | 'assistant'; content: string }

export function ProspectChat({ brandName }: { brandName: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [messages, open])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next); setDraft(''); setBusy(true)
    try {
      const res = await fetch('/api/platform/prospect-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      const data = (await res.json().catch(() => null)) as { reply?: string; error?: string } | null
      const reply = data?.reply ?? (res.status === 429 ? 'Give it a moment and try again.' : 'Sorry — something went wrong. Book a demo or start a trial above and a person will follow up.')
      setMessages([...next, { role: 'assistant', content: reply }])
    } catch {
      setMessages([...next, { role: 'assistant', content: 'Sorry — something went wrong. Book a demo or start a trial above and a person will follow up.' }])
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <div className="text-center">
        <Button variant="outline" onClick={() => setOpen(true)}>
          <MessageSquare className="h-4 w-4 mr-2" />Ask the {brandName} assistant
        </Button>
        <p className="text-[11px] text-muted-foreground mt-2">An AI assistant — it can answer product questions, book a live demo, send you the signup link, or get a person to follow up.</p>
      </div>
    )
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="text-xs text-muted-foreground">You&apos;re chatting with the {brandName} AI assistant. It can book a live demo, send the signup link, or hand you to a person.</div>
        <div className="max-h-72 overflow-y-auto space-y-2 text-sm">
          {messages.length === 0 && <p className="text-muted-foreground">Ask anything about the platform — plans, what it runs, how a demo works.</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              <span className={'inline-block rounded-lg px-3 py-2 ' + (m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{m.content}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send() } }} />
          <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
