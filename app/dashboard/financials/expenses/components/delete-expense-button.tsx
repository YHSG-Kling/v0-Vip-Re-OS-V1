"use client"

/**
 * Delete-expense affordance for the expense ledger.
 *
 * Wave 4 slice 2: `app/actions/financials.ts:deleteExpense` existed, was
 * correctly scoped (resolves agents.id from the session and requires the row to
 * match BOTH the expense id and that agent), and had no caller anywhere in the
 * tree — so an agent who logged a wrong amount, or logged the same receipt
 * twice, had no way to remove it. Those rows are not cosmetic: they feed the
 * YTD deduction total, the category breakdown and the P&L report, so a bad row
 * silently overstates a tax deduction until someone notices.
 *
 * Deliberately confirm-gated: this is a hard delete of a financial record.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Trash2, Loader2 } from "lucide-react"
import { deleteExpense } from "@/app/actions/financials"

export function DeleteExpenseButton({
  expenseId,
  description,
  amount,
}: {
  expenseId: string
  description: string
  amount: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount || 0)

  function handleConfirm() {
    setError(null)
    startTransition(async () => {
      // The action returns {success,error} — it never throws for a refusal.
      // Surface the refusal instead of closing the dialog on a delete that
      // did not happen.
      const r = await deleteExpense(expenseId).catch(() => ({
        success: false,
        error: "Could not reach the server",
      }))
      if (!r?.success) {
        setError(r?.error ?? "Delete failed")
        return
      }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete expense: ${description}`}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <AlertDialog open={open} onOpenChange={(o) => !isPending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
            <AlertDialogDescription>
              {description || "Business Expense"} — {money}. This permanently removes
              the record and its deduction from your year-to-date totals. It cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-sm text-destructive bg-destructive/5 border border-destructive/40 rounded p-2">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirm()
              }}
              disabled={isPending}
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete expense"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
