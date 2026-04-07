"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Plus, Calendar, BarChart3, Sparkles } from "lucide-react"
import { CreateTransactionSheet } from "./create-transaction-sheet"

export function TransactionCommandStrip() {
  const [sheetOpen, setSheetOpen] = useState(false)

  return (
    <>
      {/* Command strip: wraps cleanly on mobile, no horizontal scroll */}
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 border-b border-border bg-muted/30">
        <Button size="sm" className="gap-2 min-h-[44px] sm:min-h-0" onClick={() => setSheetOpen(true)}>
          <Plus className="h-4 w-4" />
          <span className="hidden xs:inline">New </span>Transaction
        </Button>
        <Link href="/dashboard/transactions?view=timeline">
          <Button variant="outline" size="sm" className="gap-2 min-h-[44px] sm:min-h-0">
            <Calendar className="h-4 w-4" />
            <span className="hidden sm:inline">Timeline View</span>
            <span className="sm:hidden sr-only">Timeline</span>
          </Button>
        </Link>
        <Link href="/dashboard/financials/reports">
          <Button variant="outline" size="sm" className="gap-2 min-h-[44px] sm:min-h-0">
            <BarChart3 className="h-4 w-4" />
            <span className="hidden sm:inline">Reports</span>
          </Button>
        </Link>
        <div className="flex-1 hidden sm:block" />
        <Link href="/dashboard/brokerage/deal-health">
          <Button variant="ghost" size="sm" className="gap-2 text-primary min-h-[44px] sm:min-h-0">
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Deal Health AI</span>
          </Button>
        </Link>
      </div>

      <CreateTransactionSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  )
}
