"use client"

/**
 * SiteChatLauncher — the LIVE AI on the tenant website (owner rule: the
 * site doesn't just show the business, it ANSWERS questions). A floating
 * launcher that opens the brokerage's existing embeddable AI chat
 * (/widget/[brokerageSlug] — the same inventory-aware, identity-fronted,
 * compliance-gated assistant that answers the phone), so /site and /team
 * visitors talk to the tenant's named assistant without any tenant setup.
 */
import { useState } from "react"

export function SiteChatLauncher({
  brokerageSlug,
  accentColor,
  assistantLabel,
  widgetQuery,
}: {
  brokerageSlug: string
  accentColor: string
  assistantLabel?: string | null
  /** Tier scope for the widget identity ("team=<slug>" | "agent=<slug>"). */
  widgetQuery?: string | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-5 z-50 w-[min(400px,calc(100vw-2.5rem))] h-[min(600px,70vh)] rounded-2xl shadow-2xl border overflow-hidden bg-background">
          <iframe
            src={`/widget/${brokerageSlug}${widgetQuery ? `?${widgetQuery}` : ""}`}
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
