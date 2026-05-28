"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Loader2, DollarSign, Banknote } from "lucide-react"
import { initiateVendorPayout } from "@/app/actions/vendor-payments"

interface Props {
  vendorId: string
  availableAmount: number
  stripeReady: boolean
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export function VendorPayoutButton({ vendorId, availableAmount, stripeReady }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [method, setMethod] = useState<"stripe" | "cash_app" | "check" | "manual">("stripe")
  const [cashAppRef, setCashAppRef] = useState("")
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  async function handlePayout() {
    setLoading(true)
    setResult(null)
    try {
      const res = await initiateVendorPayout({
        vendorId,
        amount: availableAmount,
        method,
        cashAppReference: method === "cash_app" ? cashAppRef : undefined,
      })
      if (res.success) {
        setResult({ ok: true, msg: "Payout initiated! Funds will arrive within 1–3 business days." })
      } else {
        setResult({ ok: false, msg: res.error ?? "Payout failed" })
      }
    } catch {
      setResult({ ok: false, msg: "Unexpected error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        className="w-full gap-2 bg-green-600 hover:bg-green-700"
        onClick={() => setOpen(true)}
      >
        <Banknote className="h-4 w-4" />
        Request Payout — {fmt(availableAmount)} available
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-green-600" />
              Request Payout
            </SheetTitle>
            <SheetDescription>
              {fmt(availableAmount)} available to withdraw
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-medium block mb-2">Payout method</label>
              <div className="grid grid-cols-2 gap-2">
                {(["stripe", "cash_app", "check", "manual"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`p-2 rounded border text-sm capitalize transition-colors ${
                      method === m
                        ? "border-primary bg-primary/5 font-medium"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {m === "cash_app" ? "Cash App" : m === "manual" ? "Manual" : m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
              {method === "stripe" && !stripeReady && (
                <p className="text-xs text-amber-700 mt-1">
                  Stripe not yet connected — set up on this page first.
                </p>
              )}
            </div>

            {method === "cash_app" && (
              <div>
                <label className="text-sm font-medium block mb-1">Cash App $Cashtag</label>
                <input
                  type="text"
                  value={cashAppRef}
                  onChange={(e) => setCashAppRef(e.target.value)}
                  placeholder="$YourCashtag"
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
            )}

            {result && (
              <div
                className={`p-3 rounded text-sm ${
                  result.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
                }`}
              >
                {result.msg}
              </div>
            )}

            <Button
              className="w-full gap-2"
              onClick={handlePayout}
              disabled={loading || (method === "stripe" && !stripeReady) || !!result?.ok}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Banknote className="h-4 w-4" />
              )}
              {result?.ok ? "Payout Requested" : `Withdraw ${fmt(availableAmount)}`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
