"use client"

/**
 * THE MARKETING COPY, WRITABLE AT LAST.
 *
 * `listings.public_remarks` is the listing's public marketing description. It is
 * read all over this product — the public listing page, the seller portal, the
 * brochure generator, the social carousel, the video director, IDX search results —
 * and, critically, it is the text the Fair Housing / MLS copy review runs against,
 * whose findings become launch blockers on the lifecycle page.
 *
 * NOTHING IN THE DASHBOARD COULD WRITE IT.
 *
 * The only two writers were:
 *   · app/actions/ai-marketing-automation.ts, on INSERT — it can seed the remarks
 *     when it CREATES a listing, and can never touch an existing one; and
 *   · app/actions/ai-content-generation.tsx::saveDescriptionToListing, which is
 *     itself orphaned and requires an ai_generated_content row id the listing rail
 *     never produces.
 *
 * So the intelligence card immediately above this one renders "This listing has no
 * public remarks yet — there is nothing to review. Add the marketing description
 * first", and there was no first. The copy gate could refuse a launch over copy the
 * agent had no way to write or fix.
 *
 * Two complete, exported, caller-less kernel actions close it exactly, and the
 * kernel's own docstring names the pairing — generateListingDescription "does NOT
 * write — returns text for caller to save via saveListingDraft":
 *
 *   generateListingDescriptionAction  → AI draft, brand-voiced + guardian-checked
 *   saveListingDraftAction            → persists it to listings.public_remarks
 *
 * The agent stays in the loop between them: generated text lands in an editable box,
 * never straight into the column. Saving reports the SERVER's verdict; a refused
 * write says so and the text stays on screen so nothing is lost.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, Save, TriangleAlert, CircleCheck, RotateCcw } from "lucide-react"
import { generateListingDescriptionAction, saveListingDraftAction } from "@/app/actions/listings-kernel"

type Style = "standard" | "luxury" | "family" | "investment"

const STYLES: Array<{ value: Style; label: string }> = [
  { value: "standard", label: "Standard" },
  { value: "luxury", label: "Luxury" },
  { value: "family", label: "Family" },
  { value: "investment", label: "Investment" },
]

interface Props {
  listingId: string
  /** The stored public_remarks, read server-side. */
  initialRemarks: string | null
}

export function ListingDescriptionComposer({ listingId, initialRemarks }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const stored = (initialRemarks ?? "").trim()
  const [draft, setDraft] = useState(stored)
  const [style, setStyle] = useState<Style>("standard")
  const [busy, setBusy] = useState<"generate" | "save" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [ignoredFields, setIgnoredFields] = useState<string[]>([])

  const dirty = draft.trim() !== stored

  function generate() {
    setError(null)
    setSaved(false)
    setBusy("generate")
    startTransition(async () => {
      try {
        const res = (await generateListingDescriptionAction({ listingId, style })) as {
          success: boolean
          error?: string
          description?: string
        }
        // READ THE SERVER'S VERDICT. A kernel result that reports failure by
        // returning { success:false } rather than throwing must not look like a
        // successful generation that happened to produce nothing.
        if (!res.success || !res.description) {
          setError(res.error ?? "The description could not be generated.")
          return
        }
        setDraft(res.description)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "The description could not be generated.")
      } finally {
        setBusy(null)
      }
    })
  }

  function save() {
    const text = draft.trim()
    if (!text) {
      setError("There is nothing to save — write or generate a description first.")
      return
    }
    setError(null)
    setSaved(false)
    setIgnoredFields([])
    setBusy("save")
    startTransition(async () => {
      try {
        const res = (await saveListingDraftAction({
          listingId,
          updates: { public_remarks: text },
        })) as { success: boolean; error?: string; ignoredFields?: string[] }

        if (!res.success) {
          // The draft stays on screen. A refused save must never look like a
          // save that worked, and must never cost the agent their text.
          setError(res.error ?? "The description was not saved.")
          return
        }
        setIgnoredFields(res.ignoredFields ?? [])
        setSaved(true)
        // The copy gate and the launch blockers on this page are computed from
        // public_remarks — re-read the page so they reflect the new text (and so
        // the previous Fair Housing verdict is correctly marked stale).
        router.refresh()
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "The description was not saved.")
      } finally {
        setBusy(null)
      }
    })
  }

  return (
    <section className="space-y-3 border-t pt-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Sparkles className="h-4 w-4" />
            Public marketing description
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            This is the copy the Fair Housing &amp; MLS review above runs against, and the text the
            public listing page, brochure and seller portal all render.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-[11px]">
            <span className="block text-muted-foreground mb-1">Voice</span>
            <select
              className="border rounded px-2 py-1 text-xs bg-background"
              value={style}
              onChange={(e) => setStyle(e.target.value as Style)}
              disabled={pending}
            >
              {STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="secondary" onClick={generate} disabled={pending}>
            {busy === "generate" && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
            {stored ? "Rewrite with AI" : "Draft with AI"}
          </Button>
        </div>
      </div>

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setSaved(false)
        }}
        rows={7}
        disabled={pending}
        placeholder="Describe the property for buyers. Generated copy lands here for you to edit before it is saved — it is never written straight to the listing."
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <Badge variant="outline">{draft.trim().length} characters</Badge>
          {!stored && <Badge variant="outline" className="border-amber-300 text-amber-700">Never saved</Badge>}
          {dirty && stored && (
            <Badge variant="outline" className="border-amber-300 text-amber-700">Unsaved changes</Badge>
          )}
          {saved && !dirty && (
            <span className="text-emerald-700 flex items-center gap-1">
              <CircleCheck className="h-3.5 w-3.5" />
              Saved to the listing
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(stored)
                setError(null)
                setSaved(false)
              }}
              disabled={pending}
            >
              <RotateCcw className="h-3 w-3 mr-1.5" />
              Revert
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            {busy === "save" ? (
              <Loader2 className="h-3 w-3 mr-2 animate-spin" />
            ) : (
              <Save className="h-3 w-3 mr-2" />
            )}
            Save description
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600 flex items-start gap-1.5">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>{error}</span>
        </p>
      )}

      {ignoredFields.length > 0 && (
        <p className="text-[11px] text-amber-700">
          These fields are not editable here and were ignored: {ignoredFields.join(", ")}.
        </p>
      )}

      {saved && (
        <p className="text-[11px] text-muted-foreground">
          The saved copy has not been reviewed yet — run the Fair Housing &amp; MLS review above before
          launching, or the launch gate will hold on an unreviewed description.
        </p>
      )}
    </section>
  )
}
