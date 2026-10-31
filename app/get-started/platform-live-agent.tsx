'use client'

// app/get-started/platform-live-agent.tsx — THE PLATFORM'S OWN LIVE AGENT on
// its own site (lane 77B, owner verbatim: "the platform should also offer the
// same ai agents like the live agent using d-id because the platform can use
// those ai agents as a demo'd product"). Mounted on /get-started and /demo
// beside the text prospect chat.
//
// ONE component, ONE D-ID SDK plumbing: this is app/embed/[publicId]/
// embed-widget.tsx with `deployment="platform"` — the same widget every
// subscriber's website gets, pointed at the platform's own presenter, session
// route and marker. Nothing here talks to D-ID directly.
//
// `available` is decided on the SERVER (the brand kit has a presenter and the
// showcase tenant exists — app/get-started/page.tsx reads it) so a visitor is
// never offered a live agent that cannot mint; when it is not available the
// text chat beside it is the whole surface.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Video } from 'lucide-react'
import { EmbedWidget } from '@/app/embed/[publicId]/embed-widget'

function visitorIdFor(): string {
  try {
    const key = 'platform_live_agent_visitor'
    const existing = window.localStorage.getItem(key)
    if (existing) return existing
    const fresh = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    window.localStorage.setItem(key, fresh)
    return fresh
  } catch {
    return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

export function PlatformLiveAgent({ brandName, agentName, greeting, available, primaryColor }: {
  brandName: string
  agentName: string
  greeting: string
  available: boolean
  primaryColor: string
}) {
  const [open, setOpen] = useState(false)
  const [visitorId, setVisitorId] = useState<string | null>(null)

  if (!available) return null

  if (!open) {
    return (
      <div className="text-center">
        <Button onClick={() => { setVisitorId(visitorIdFor()); setOpen(true) }}>
          <Video className="h-4 w-4 mr-2" />Talk to {agentName} — the live AI agent
        </Button>
        <p className="text-[11px] text-muted-foreground mt-2">
          Face to face, on camera — the same live agent every {brandName} subscriber&apos;s website gets. Ask it anything, book a live demo, or start your trial right in the conversation.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto">
      <EmbedWidget
        deployment="platform"
        publicId="platform"
        visitorId={visitorId ?? visitorIdFor()}
        origin={typeof window !== 'undefined' ? window.location.origin : null}
        referrer={typeof document !== 'undefined' ? document.referrer || null : null}
        pageUrl={typeof window !== 'undefined' ? window.location.href : null}
        welcomeMessage={greeting}
        enabledModes={['text', 'voice', 'live']}
        leadCaptureMode="optional"
        leadCaptureFields={[]}
        label={`${agentName} · ${brandName}`}
        style={{ bubble_color: primaryColor, text_color: '#ffffff' }}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
