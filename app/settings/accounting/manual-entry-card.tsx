"use client"

/**
 * MANUAL ENTRY — the missing half app/actions/accounting-sync.ts:pushAccountingEntry
 * was built for and never had (orphan doctrine §1.2, this lane).
 *
 * pushAccountingEntry is the ONE brokerage-level QuickBooks entry point that can
 * post an arbitrary invoice, journal entry, or expense with EXACT caller-supplied
 * account/customer references — the generic core the two tenant-mapped pushes
 * (lib/finance/accounting-egress.ts:pushExpenseToAccounting / pushCommissionToAccounting,
 * already wired autonomously off logScopedExpense and commission creation) do NOT
 * cover, because those two resolve refs from tax_categories.provider_account_id and
 * refuse honestly when a category has no mapping. Its own header recorded exactly
 * why it stayed unwired: the one candidate surface (a push button on a sync-error
 * row) cannot be built honestly because sync_errors carries no amount or account
 * ref — a push from there would have to INVENT the figures it posts to the
 * brokerage's real books, which this repo does not do (CLAUDE.md: never fabricate
 * a provider result).
 *
 * This form is the honest alternative: a finance admin who already knows the exact
 * QuickBooks account/customer references (the mapped ones from the Tax Mapping tab,
 * or one typed from their own QuickBooks) supplies them directly. Nothing here is
 * invented — every field is either picked from a REAL tax_categories mapping this
 * brokerage configured, or typed by the human authorizing the entry.
 *
 * GATE: pushAccountingEntry re-checks BROKERAGE_FINANCE_ADMIN_USER_TYPES and the
 * session's own brokerage_id server-side (CLAUDE.md §4) — this form is mounted only
 * on a page already gated the same way (app/settings/accounting/page.tsx), which is
 * belt-and-suspenders, not the boundary itself.
 */

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Send, CheckCircle2, XCircle } from "lucide-react"
import { pushAccountingEntry } from "@/app/actions/accounting-sync"
import { useToast } from "@/hooks/use-toast"

interface TaxCategory {
  id: string
  category_name: string
  provider_account_id: string | null
  is_active: boolean
}

type EntryKind = "expense" | "invoice" | "journal"

export function ManualEntryCard({ categories }: { categories: TaxCategory[] }) {
  const { toast } = useToast()
  const mapped = categories.filter((c) => c.is_active && c.provider_account_id)

  const [kind, setKind] = useState<EntryKind>("expense")
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [expenseAccountRef, setExpenseAccountRef] = useState("")
  const [paymentAccountRef, setPaymentAccountRef] = useState("")
  const [customerRef, setCustomerRef] = useState("")
  const [debitAccountRef, setDebitAccountRef] = useState("")
  const [creditAccountRef, setCreditAccountRef] = useState("")

  const [submitting, setSubmitting] = useState(false)
  const [lastResult, setLastResult] = useState<
    { ok: true; externalId?: string } | { ok: false; error: string } | null
  >(null)

  const amountNumber = Number(amount)
  const canSubmit =
    !submitting &&
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    (kind === "expense"
      ? !!expenseAccountRef && !!paymentAccountRef
      : kind === "invoice"
        ? !!customerRef.trim()
        : !!debitAccountRef && !!creditAccountRef)

  const handleSubmit = async () => {
    setSubmitting(true)
    setLastResult(null)
    try {
      const result =
        kind === "expense"
          ? await pushAccountingEntry({
              kind: "expense",
              amount: amountNumber,
              expenseAccountRef,
              paymentAccountRef,
              description: description || undefined,
            })
          : kind === "invoice"
            ? await pushAccountingEntry({
                kind: "invoice",
                amount: amountNumber,
                customerRef: customerRef.trim(),
                description: description || undefined,
              })
            : await pushAccountingEntry({
                kind: "journal",
                description: description || undefined,
                lines: [
                  { amount: amountNumber, accountRef: debitAccountRef, postingType: "Debit" },
                  { amount: amountNumber, accountRef: creditAccountRef, postingType: "Credit" },
                ],
              })

      if (result.ok) {
        // The provider's OWN response, never a fabricated success — result.result
        // is exactly what QuickBooksProvider returned, and pushAccountingEntry has
        // already recorded it in accounting_sync_log before this ever resolves.
        setLastResult({ ok: true, externalId: result.result.externalId })
        toast({
          title: "Posted to QuickBooks",
          description: result.result.externalId
            ? `QuickBooks id ${result.result.externalId}. See Sync History for the record.`
            : "Entry accepted. See Sync History for the record.",
        })
        setAmount("")
        setDescription("")
      } else {
        setLastResult({ ok: false, error: result.error })
        toast({ title: "Entry not posted", description: result.error, variant: "destructive" })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unexpected error"
      setLastResult({ ok: false, error: msg })
      toast({ title: "Entry not posted", description: msg, variant: "destructive" })
    }
    setSubmitting(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual Entry</CardTitle>
        <CardDescription>
          Post one invoice, journal entry, or expense straight to the brokerage&apos;s QuickBooks
          company — for whatever the automatic commission and expense syncs don&apos;t cover.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label>Entry type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as EntryKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expense">Expense (Purchase)</SelectItem>
              <SelectItem value="invoice">Invoice</SelectItem>
              <SelectItem value="journal">Journal entry</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label>Amount</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>

        {kind === "expense" && (
          <>
            <div className="grid gap-2">
              <Label>Expense account</Label>
              {mapped.length > 0 ? (
                <Select value={expenseAccountRef} onValueChange={setExpenseAccountRef}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a mapped category" />
                  </SelectTrigger>
                  <SelectContent>
                    {mapped.map((c) => (
                      <SelectItem key={c.id} value={c.provider_account_id as string}>
                        {c.category_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No mapped categories yet — map one under Tax Mapping first.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Payment account</Label>
              {mapped.length > 0 ? (
                <Select value={paymentAccountRef} onValueChange={setPaymentAccountRef}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a mapped account" />
                  </SelectTrigger>
                  <SelectContent>
                    {mapped.map((c) => (
                      <SelectItem key={c.id} value={c.provider_account_id as string}>
                        {c.category_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Map a &quot;payment_account&quot; category under Tax Mapping to enable this.
                </p>
              )}
            </div>
          </>
        )}

        {kind === "invoice" && (
          <div className="grid gap-2">
            <Label>QuickBooks customer ID</Label>
            <Input
              value={customerRef}
              onChange={(e) => setCustomerRef(e.target.value)}
              placeholder="e.g. 42 (from QuickBooks → Customers)"
            />
          </div>
        )}

        {kind === "journal" && (
          <>
            <div className="grid gap-2">
              <Label>Debit account</Label>
              {mapped.length > 0 ? (
                <Select value={debitAccountRef} onValueChange={setDebitAccountRef}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a mapped account" />
                  </SelectTrigger>
                  <SelectContent>
                    {mapped.map((c) => (
                      <SelectItem key={c.id} value={c.provider_account_id as string}>
                        {c.category_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No mapped categories yet — map one under Tax Mapping first.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Credit account</Label>
              {mapped.length > 0 ? (
                <Select value={creditAccountRef} onValueChange={setCreditAccountRef}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a mapped account" />
                  </SelectTrigger>
                  <SelectContent>
                    {mapped.map((c) => (
                      <SelectItem key={c.id} value={c.provider_account_id as string}>
                        {c.category_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No mapped categories yet — map one under Tax Mapping first.
                </p>
              )}
            </div>
          </>
        )}

        <div className="grid gap-2">
          <Label>Description (optional)</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this entry is for"
            rows={2}
          />
        </div>

        <Button onClick={handleSubmit} disabled={!canSubmit} className="w-full">
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Posting...
            </>
          ) : (
            <>
              <Send className="w-4 h-4 mr-2" />
              Post to QuickBooks
            </>
          )}
        </Button>

        {lastResult && (
          <div
            className={`flex items-start gap-2 text-sm rounded-md p-3 ${
              lastResult.ok
                ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"
                : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            {lastResult.ok ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span>
              {lastResult.ok
                ? `Posted${lastResult.externalId ? ` — QuickBooks id ${lastResult.externalId}` : ""}.`
                : lastResult.error}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
