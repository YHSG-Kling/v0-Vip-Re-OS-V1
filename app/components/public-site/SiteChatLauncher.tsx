"use client"

/**
 * SiteChatLauncher — the LIVE AI on the tenant website (owner rule: the
 * site doesn't just show the business, it ANSWERS questions). A floating
 * launcher that opens the brokerage's assistant, so /site and /team
 * visitors talk to the tenant's named assistant without any tenant setup.
 *
 * TWO BACKENDS, one launcher, chosen server-side (never a second launcher
 * per surface, §6): when the tenant has an ACTIVE embed_widgets row
 * (lib/embed/resolve-site-embed.ts resolves it — a real, already-existing
 * setting, never fabricated), `livePublicId` is set and this opens
 * /embed/[publicId] — the FULL D-ID Express v4 Agents SDK experience
 * (text/voice/live avatar, lead capture), the same system that already
 * backs the embeddable widget on third-party sites (owner ruling, wave 58:
 * "d-id express v4 for live agent for website, widget, in portal as
 * options"). Otherwise it falls back to the text-only
 * /widget/[brokerageSlug] door exactly as before — no capability lost, no
 * live avatar promised where nothing is configured for it.
 */
import { useState, useMemo } from "react"

export function SiteChatLauncher({
  brokerageSlug,
  accentColor,
  assistantLabel,
  widgetQuery,
  livePublicId,
}: {
  brokerageSlug: string
  accentColor: string
  assistantLabel?: string | null
  /** Tier scope for the widget identity ("team=<slug>" | "agent=<slug>"). */
  widgetQuery?: string | null
  /** embed_widgets.public_id for an ACTIVE, tenant-configured live-agent
   *  embed — resolveSiteLiveAgentEmbed's result. Omit/null for text-only. */
  livePublicId?: string | null
}) {
  const [open, setOpen] = useState(false)
  // A fresh per-mount visitor id for the embed session mint — the embed
  // system's own dedupe/resume lives on the session token it issues, not on
  // this id staying stable across visits, so a per-open id is sufficient and
  // needs no localStorage dependency.
  const visitorId = useMemo(
    () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `v-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    [],
  )
  const iframeSrc = livePublicId
    ? `/embed/${livePublicId}?v=${encodeURIComponent(visitorId)}`
    : `/widget/${brokerageSlug}${widgetQuery ? `?${widgetQuery}` : ""}`
  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-5 z-50 w-[min(400px,calc(100vw-2.5rem))] h-[min(600px,70vh)] rounded-2xl shadow-2xl border overflow-hidden bg-background">
          <iframe
            src={iframeSrc}
            title={assistantLabel ?? "AI assistant"}
            className="w-full h-full border-0"
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close chat" : `Chat with ${assistantLabel ?? "our AI assistant"}`}
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full px-5 py-3.5 text-white font-semibold shadow-xl hover:opacity-90 transition-opacity"
        style={{ backgroundColor: accentColor }}
      >
        {open ? (
          <span aria-hidden>✕</span>
        ) : (
          <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
        <span>{open ? "Close" : `Ask ${assistantLabel ?? "us"} anything`}</span>
      </button>
    </>
  )
}
