"use client"

/**
 * Generated-document library list — the produced-PDF rail's client surface.
 * Mirrors the Document Center's shape (search box, left type rail, divide-y
 * rows) without touching its component: client_documents (uploaded/received)
 * and generated_documents (platform-produced) stay separate rails.
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { FileOutput, Search, ExternalLink } from "lucide-react"
import type { GeneratedDocumentRow } from "@/app/actions/generated-documents"

// FOLDER_LABELS-style const (document-center.ts:47) over the 8 documentType
// values the producer union writes (client-document-producer.ts:80).
const TYPE_LABELS: Record<string, string> = {
  cma: "CMAs",
  net_sheet: "Net Sheets",
  buyer_guide: "Buyer Guides",
  seller_guide: "Seller Guides",
  listing_presentation: "Listing Presentations",
  listing_brochure: "Listing Brochures",
  listing_packet: "Listing Packets",
  recruiting_pitch: "Recruiting Pitches",
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—"
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function GeneratedLibraryClient({ documents }: { documents: GeneratedDocumentRow[] }) {
  const [search, setSearch] = useState("")
  const [activeType, setActiveType] = useState<string | null>(null)

  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of documents) counts.set(d.documentType, (counts.get(d.documentType) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [documents])

  const filtered = useMemo(() => {
    return documents.filter((d) => {
      if (activeType && d.documentType !== activeType) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        return (
          d.title.toLowerCase().includes(q) ||
          d.contactName?.toLowerCase().includes(q) ||
          d.listingAddress?.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [documents, activeType, search])

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileOutput className="h-6 w-6 text-blue-600" />
            Generated Documents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every PDF the platform produced for you — CMAs, guides, presentations, packets.
          </p>
        </div>
        <Link href="/dashboard/documents" className="text-sm text-primary hover:underline">
          ← Document Center
        </Link>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title, contact, or property…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        {/* Type rail */}
        <div className="space-y-1">
          <button
            onClick={() => setActiveType(null)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
              activeType === null ? "bg-blue-50 text-blue-900 font-medium" : "hover:bg-gray-50"
            }`}
          >
            <span>All types</span>
            <span className="text-xs text-muted-foreground">{documents.length}</span>
          </button>
          {types.map(([type, count]) => (
            <button
              key={type}
              onClick={() => setActiveType(activeType === type ? null : type)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                activeType === type ? "bg-blue-50 text-blue-900 font-medium" : "hover:bg-gray-50"
              }`}
            >
              <span>{TYPE_LABELS[type] ?? type.replace(/_/g, " ")}</span>
              <span className="text-xs text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>

        {/* Rows */}
        <Card>
          <CardContent className="p-0">
            {filtered.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {documents.length === 0
                  ? "Nothing generated yet — CMAs, guides and presentations you produce will collect here."
                  : "No documents match this filter."}
              </p>
            ) : (
              <div className="divide-y">
                {filtered.map((d) => (
                  <div key={d.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{d.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {(TYPE_LABELS[d.documentType] ?? d.documentType.replace(/_/g, " ")).replace(/s$/, "")}
                        {/* listing-packet rows carry only listing_id — the address IS their "For". */}
                        {d.contactName
                          ? ` · for ${d.contactName}`
                          : d.listingAddress
                          ? ` · for ${d.listingAddress}`
                          : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(d.createdAt).toLocaleDateString()}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap w-16 text-right">
                      {formatSize(d.fileSizeBytes)}
                    </span>
                    {/* Plain anchor on purpose — this rail's PDFs are hosted via
                        hostRenderedMedia (public media host, we own the URL). The
                        governed-URL custody wrapper serves the PRIVATE
                        client-documents bucket (client_documents rows), not this. */}
                    {d.blobUrl ? (
                      <a
                        href={d.blobUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">No file</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
