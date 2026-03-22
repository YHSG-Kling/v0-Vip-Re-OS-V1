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
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Button size="sm" className="gap-2" onClick={() => setSheetOpen(true)}>
          <Plus className="h-4 w-4" />
          New Transaction
        </Button>
        <Link href="/dashboard/transactions?view=timeline">
          <Button variant="outline" size="sm" className="gap-2">
            <Calendar className="h-4 w-4" />
            Timeline View
          </Button>
        </Link>
        <Link href="/dashboard/financials/reports">
          <Button variant="outline" size="sm" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Reports
          </Button>
        </Link>
        <div className="flex-1" />
        <Link href="/dashboard/brokerage/deal-health">
          <Button variant="ghost" size="sm" className="gap-2 text-primary">
            <Sparkles className="h-4 w-4" />
            Deal Health AI
          </Button>
        </Link>
      </div>

      <CreateTransactionSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  )
}
