"use client"

import { useActionState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { addVendorPortfolioItem, type VendorPortfolioSubmitState } from "@/app/actions/vendor-portfolio"

/**
 * The portfolio upload form (wave 147, lane 147H) — bound to the server action addVendorPortfolioItem through
 * useActionState: the file is stored, the row written and ledgered, and the result said in words. No timer, no
 * optimistic "Uploading…" that discards the file (the wave-146 defect this page once carried).
 */
export function PortfolioUploadForm() {
  const [state, formAction, pending] = useActionState<VendorPortfolioSubmitState, FormData>(addVendorPortfolioItem, null)
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="portfolio-title">Title</Label>
        <Input id="portfolio-title" name="title" required maxLength={120} placeholder="Kitchen remodel — 1420 Oak St" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portfolio-description">Description (optional)</Label>
        <Textarea id="portfolio-description" name="description" maxLength={2000} rows={3} placeholder="What you did, how long it took, what the client needed." />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portfolio-file">Photo or PDF</Label>
        <Input id="portfolio-file" name="file" type="file" required accept="image/jpeg,image/png,image/webp,application/pdf" />
        <p className="text-xs text-muted-foreground">JPG, PNG, WebP or PDF, up to 7 MB. Agents in your brokerage see it beside your reviews.</p>
      </div>
      {state && (
        <p className={`text-sm ${state.ok ? "text-foreground" : "text-destructive"}`} role={state.ok ? "status" : "alert"}>
          {state.message} {state.ok && <Link href="/vendor/portfolio" className="font-medium text-primary underline-offset-4 hover:underline">See your portfolio</Link>}
        </p>
      )}
      <Button type="submit" disabled={pending}>{pending ? "Uploading…" : "Upload"}</Button>
    </form>
  )
}
