"use client"

import { useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, FileBarChart, ExternalLink } from "lucide-react"
import Link from "next/link"
import { getCMAReports, updateCMAReport } from "@/app/actions/ai-cma"
import { useToast } from "@/hooks/use-toast"

interface CmaHistorySheetProps {
  listingId: string
  agentId: string
  listingAddress: string
}

const PURPOSE_LABELS: Record<string, string> = {
  listing: "Listing Pricing",
  buyer_offer: "Buyer Offer",
  seller_consultation: "Seller Consultation",
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground border-border" },
  shared_with_seller: { label: "Shared", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  expired: { label: "Expired", cls: "bg-red-100 text-red-800 border-red-200" },
  active: { label: "Active", cls: "bg-blue-100 text-blue-800 border-blue-200" },
}

export function CmaHistorySheet({ listingId, agentId, listingAddress }: CmaHistorySheetProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<any[]>([])
  const [toggling, setToggling] = useState<string | null>(null)
  const { toast } = useToast()

  async function loadReports() {
    if (reports.length > 0) return
    setLoading(true)
    try {
      const res = await getCMAReports(agentId)
      if (res.success) {
        // getCMAReports doesn't filter by listingId — filter client-side
        const filtered = (res.reports ?? []).filter((r: any) => r.listing_id === listingId)
        setReports(filtered)
      } else {
        toast({ title: (res as any).error ?? "Failed to load CMAs", variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to load CMAs", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  async function toggleShared(cma: any) {
    const nextStatus = cma.status === "shared_with_seller" ? "draft" : "shared_with_seller"
    setToggling(cma.id)
    try {
      const res = await updateCMAReport(cma.id, { status: nextStatus })
      if (res.success) {
        setReports((prev) =>
          prev.map((r) => (r.id === cma.id ? { ...r, status: nextStatus } : r))
        )
        toast({ title: nextStatus === "shared_with_seller" ? "Marked as shared with seller" : "Marked as draft" })
      } else {
        toast({ title: (res as any).error ?? "Update failed", variant: "destructive" })
      }
    } catch {
      toast({ title: "Update failed", variant: "destructive" })
    } finally {
      setToggling(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (o) loadReports() }}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={(e) => e.preventDefault()}
        >
          <FileBarChart className="h-3 w-3" />
          CMAs
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="text-base">CMA History</SheetTitle>
          <p className="text-xs text-muted-foreground truncate">{listingAddress}</p>
        </SheetHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : reports.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <FileBarChart className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No CMAs generated for this listing yet.</p>
            <Link href={`/listings/${listingId}`}>
              <Button size="sm" variant="outline" className="gap-1.5">
                <ExternalLink className="h-3 w-3" />
                Open Workbench
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((cma) => {
              const statusCfg = STATUS_CONFIG[cma.status] ?? STATUS_CONFIG.draft
              const purpose = PURPOSE_LABELS[cma.purpose ?? "listing"] ?? cma.purpose ?? "—"
              const isShared = cma.status === "shared_with_seller"
              return (
                <div key={cma.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{purpose}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(cma.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <Badge className={`text-[10px] shrink-0 border ${statusCfg.cls}`}>
                      {statusCfg.label}
                    </Badge>
                  </div>

                  {cma.recommended_price && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Recommended Price</span>
                      <span className="font-semibold">${Number(cma.recommended_price).toLocaleString()}</span>
                    </div>
                  )}

                  {cma.price_range_low && cma.price_range_high && (
                    <p className="text-[10px] text-muted-foreground">
                      Range: ${Number(cma.price_range_low).toLocaleString()} – ${Number(cma.price_range_high).toLocaleString()}
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant={isShared ? "secondary" : "outline"}
                      className="h-6 text-[10px] px-2 gap-1"
                      disabled={toggling === cma.id}
                      onClick={() => toggleShared(cma)}
                    >
                      {toggling === cma.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : null}
                      {isShared ? "Unmark Shared" : "Mark Shared with Seller"}
                    </Button>
                    <Link href={`/listings/${listingId}`}>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 gap-1">
                        <ExternalLink className="h-2.5 w-2.5" />
                        Regenerate
                      </Button>
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
