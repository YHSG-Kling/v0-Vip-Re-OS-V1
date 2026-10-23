"use client"

/**
 * PresentationViewer — slide-by-slide renderer for the listing presentation
 * deck assembled by the Sprint J builder. Keyboard arrow navigation, mobile
 * tap navigation, and a "present" full-screen mode the agent can walk a
 * seller through at the kitchen table.
 *
 * Layouts supported (matches SlideDeckSlide["layout"] in the builder):
 *   title | value-range | net-sheet | marketing | timeline | next-steps | comps
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, FileText, Home, BarChart, Megaphone, Calendar, ListChecks } from "lucide-react"

export interface Presentation {
  id:                 string
  propertyAddress:    string | null
  state:              string | null
  appointmentAt:      string | null
  builtAt:            string
  cmaSnapshot: {
    low:        number
    mid:        number
    high:       number
    confidence: number
    narrative:  string
  }
  netSheet: Array<{
    pricePoint:               "conservative" | "target" | "aspirational"
    listPrice:                number
    estimatedCommission:      number
    estimatedClosingCosts:    number
    estimatedSellerProceeds:  number
    breakdown?: Record<string, number | undefined>
  }>
  marketingPlan: {
    comingSoonStrategy: string
    photographyPlan:    string
    openHousePlan:      string
    digitalChannels:    string[]
    printChannels:      string[]
    mlsHighlights:      string[]
    predictedDom:       number | null
    recommendedTier:    "essential" | "premium" | "luxury"
  } | null
  slideDeck: Array<{
    title:   string
    layout:  "title" | "value-range" | "comps" | "marketing" | "net-sheet" | "timeline" | "next-steps"
    content: unknown
  }>
  packetDocumentId: string | null
  status:           string
  agentName:        string | null
  brokerageName:    string | null
}

const layoutIcons: Record<Presentation["slideDeck"][number]["layout"], React.ElementType> = {
  title:        Home,
  "value-range": BarChart,
  comps:        BarChart,
  marketing:    Megaphone,
  "net-sheet":  FileText,
  timeline:     Calendar,
  "next-steps": ListChecks,
}

export default function PresentationViewer({ presentation }: { presentation: Presentation }) {
  const [slideIdx, setSlideIdx] = useState(0)
  const [presentMode, setPresentMode] = useState(false)
  const slide = presentation.slideDeck[slideIdx]
  const total = presentation.slideDeck.length

  // Keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") setSlideIdx(i => Math.min(total - 1, i + 1))
      if (e.key === "ArrowLeft")                   setSlideIdx(i => Math.max(0, i - 1))
      if (e.key === "Escape" && presentMode)       setPresentMode(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [total, presentMode])

  if (!slide) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Presentation has no slides yet.
      </div>
    )
  }

  const Icon = layoutIcons[slide.layout]

  return (
    <div className={presentMode
      ? "fixed inset-0 z-50 bg-slate-900 text-white overflow-y-auto"
      : "min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900"
    }>
      {/* Header bar (hidden in present mode unless hovered) */}
      {!presentMode && (
        <div className="border-b bg-white dark:bg-slate-950 sticky top-0 z-10">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/listings"><ChevronLeft className="h-4 w-4" /></Link>
              </Button>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">
                  {presentation.propertyAddress ?? "Listing presentation"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {presentation.agentName ?? "Agent"}{presentation.brokerageName ? ` · ${presentation.brokerageName}` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="outline">{slideIdx + 1} / {total}</Badge>
              <Button size="sm" variant="outline" onClick={() => setPresentMode(true)} className="gap-1">
                <Maximize2 className="h-3.5 w-3.5" /> Present
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Slide */}
      <div className={presentMode ? "px-8 py-12 max-w-5xl mx-auto" : "max-w-5xl mx-auto px-4 py-8"}>
        <Card className={presentMode ? "border-slate-700 bg-slate-800 text-white" : ""}>
          <CardContent className="p-8 sm:p-12 min-h-[60vh]">
            <div className="flex items-center gap-2 mb-6">
              <Icon className={presentMode ? "h-5 w-5 text-emerald-400" : "h-5 w-5 text-emerald-600"} />
              <h2 className={`text-xl sm:text-2xl font-semibold ${presentMode ? "text-white" : "text-slate-900 dark:text-slate-100"}`}>
                {slide.title}
              </h2>
            </div>
            <SlideContent slide={slide} presentation={presentation} presentMode={presentMode} />
          </CardContent>
        </Card>

        {/* Per-slide nav */}
        <div className="flex items-center justify-between mt-4">
          <Button variant="outline" disabled={slideIdx === 0} onClick={() => setSlideIdx(i => i - 1)}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          {presentMode && (
            <Button variant="outline" size="sm" onClick={() => setPresentMode(false)}>
              <Minimize2 className="h-3.5 w-3.5 mr-1" /> Exit present mode
            </Button>
          )}
          {slideIdx < total - 1 ? (
            <Button onClick={() => setSlideIdx(i => i + 1)}>
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : presentation.packetDocumentId ? (
            <Button asChild>
              <Link href={`/dashboard/listings/new?documentId=${presentation.packetDocumentId}`}>
                Sign listing agreement <ChevronRight className="h-4 w-4 ml-1" />
              </Link>
            </Button>
          ) : (
            /* Not a control — the deck simply ends here when no listing packet
               was generated for this presentation, so there is nothing to sign
               yet. Rendered as the status it is rather than as a dead button. */
            <span className="text-sm text-muted-foreground px-3">End of deck</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Slide content layouts ─────────────────────────────────────────────────

function SlideContent({
  slide, presentation, presentMode,
}: {
  slide:        Presentation["slideDeck"][number]
  presentation: Presentation
  presentMode:  boolean
}) {
  const muted = presentMode ? "text-slate-300" : "text-muted-foreground"

  switch (slide.layout) {
    case "title": {
      const c = slide.content as { propertyAddress?: string; subtitle?: string }
      return (
        <div className="text-center py-12">
          <p className={`text-xs uppercase tracking-wider ${muted}`}>{c.subtitle ?? ""}</p>
          <p className={`text-3xl sm:text-4xl font-semibold mt-3 ${presentMode ? "text-white" : ""}`}>
            {c.propertyAddress ?? presentation.propertyAddress ?? ""}
          </p>
          <p className={`mt-6 text-sm ${muted}`}>
            Prepared by {presentation.agentName ?? "your agent"}{presentation.brokerageName ? ` · ${presentation.brokerageName}` : ""}
          </p>
        </div>
      )
    }

    case "value-range": {
      const c = slide.content as { low: number; mid: number; high: number; narrative: string }
      return (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Conservative", value: c.low,  border: presentMode ? "border-slate-600" : "border-slate-300" },
              { label: "Target",       value: c.mid,  border: presentMode ? "border-emerald-500" : "border-emerald-500", highlight: true },
              { label: "Aspirational", value: c.high, border: presentMode ? "border-slate-600" : "border-slate-300" },
            ].map(p => (
              <div key={p.label} className={`rounded-lg border-2 p-4 text-center ${p.border} ${p.highlight ? (presentMode ? "bg-emerald-950/40" : "bg-emerald-50") : ""}`}>
                <p className={`text-xs uppercase tracking-wider ${muted}`}>{p.label}</p>
                <p className={`text-2xl font-semibold mt-1 ${presentMode ? "text-white" : ""}`}>${p.value.toLocaleString()}</p>
              </div>
            ))}
          </div>
          {c.narrative && (
            <div className={`rounded-lg p-4 ${presentMode ? "bg-slate-700" : "bg-slate-50 dark:bg-slate-800"}`}>
              <p className={`text-sm leading-relaxed ${presentMode ? "text-slate-200" : ""}`}>{c.narrative}</p>
            </div>
          )}
        </div>
      )
    }

    case "net-sheet": {
      const c = slide.content as { rows: Presentation["netSheet"] }
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={presentMode ? "border-b border-slate-700" : "border-b"}>
              <tr>
                <th className="text-left py-3">Price point</th>
                <th className="text-right py-3">List price</th>
                <th className="text-right py-3">Commission</th>
                <th className="text-right py-3">Closing costs</th>
                <th className={`text-right py-3 font-semibold ${presentMode ? "text-emerald-400" : "text-emerald-600"}`}>Net to you</th>
              </tr>
            </thead>
            <tbody>
              {(c.rows ?? presentation.netSheet).map(row => (
                <tr key={row.pricePoint} className={`border-b ${presentMode ? "border-slate-700" : ""}`}>
                  <td className="py-3 font-medium capitalize">{row.pricePoint}</td>
                  <td className="text-right">${row.listPrice.toLocaleString()}</td>
                  <td className={`text-right ${muted}`}>-${row.estimatedCommission.toLocaleString()}</td>
                  <td className={`text-right ${muted}`}>-${row.estimatedClosingCosts.toLocaleString()}</td>
                  <td className={`text-right font-semibold ${presentMode ? "text-emerald-400" : "text-emerald-600"}`}>
                    ${row.estimatedSellerProceeds.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "marketing": {
      const c = slide.content as Presentation["marketingPlan"]
      if (!c) return <p className={muted}>No marketing plan defined.</p>
      return (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold mb-1">Recommended tier</p>
            <Badge className="capitalize">{c.recommendedTier}</Badge>
          </div>
          <Section title="Coming Soon strategy" muted={muted}>{c.comingSoonStrategy}</Section>
          <Section title="Photography" muted={muted}>{c.photographyPlan}</Section>
          <Section title="Open house plan" muted={muted}>{c.openHousePlan}</Section>
          <div className="grid grid-cols-2 gap-4">
            <BulletList title="Digital" items={c.digitalChannels} muted={muted} />
            <BulletList title="Print" items={c.printChannels} muted={muted} />
          </div>
          <BulletList title="MLS highlights" items={c.mlsHighlights} muted={muted} />
          {c.predictedDom != null && (
            <p className={`text-xs ${muted}`}>Predicted days on market: <span className={presentMode ? "text-white" : "text-foreground"}>{c.predictedDom}</span></p>
          )}
        </div>
      )
    }

    case "timeline": {
      const c = slide.content as { steps: Array<{ day: string; label: string }> }
      return (
        <ol className="space-y-3">
          {(c.steps ?? []).map((s, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className={`shrink-0 inline-flex items-center justify-center rounded-full h-6 w-6 text-xs font-semibold ${presentMode ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-700"}`}>
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{s.day}</p>
                <p className={`text-sm ${muted}`}>{s.label}</p>
              </div>
            </li>
          ))}
        </ol>
      )
    }

    case "next-steps": {
      const c = slide.content as { forms?: string[]; state?: string; note?: string }
      return (
        <div className="space-y-3">
          {c.note && <p className={`text-sm ${muted}`}>{c.note}</p>}
          {(c.forms ?? []).length > 0 && (
            <ul className="space-y-1.5">
              {(c.forms ?? []).map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={presentMode ? "text-emerald-400" : "text-emerald-600"}>✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }

    default:
      return <pre className={`text-xs ${muted}`}>{JSON.stringify(slide.content, null, 2)}</pre>
  }
}

function Section({ title, muted, children }: { title: string; muted: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-semibold mb-1">{title}</p>
      <p className={`text-sm ${muted}`}>{children}</p>
    </div>
  )
}

function BulletList({ title, items, muted }: { title: string; items: string[]; muted: string }) {
  return (
    <div>
      <p className="text-sm font-semibold mb-1">{title}</p>
      <ul className={`text-sm space-y-0.5 ${muted}`}>
        {items.map((item, i) => <li key={i}>· {item}</li>)}
      </ul>
    </div>
  )
}
