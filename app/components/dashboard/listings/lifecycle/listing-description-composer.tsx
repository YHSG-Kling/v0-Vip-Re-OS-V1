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

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, Save, TriangleAlert, CircleCheck, RotateCcw, Megaphone, Inbox } from "lucide-react"
import {
  generateListingDescriptionAction,
  getListingDescriptionDraftAction,
  saveListingDraftAction,
} from "@/app/actions/listings-kernel"
// THE ONE STYLE VOCABULARY (lane 87B) — the agent picks; "family" (familial status,
// Fair Housing) is retired there and "investment" merged onto "investor".
import {
  LISTING_DESCRIPTION_STYLES,
  LISTING_DESCRIPTION_STYLE_LABELS,
  DEFAULT_LISTING_DESCRIPTION_STYLE,
  type ListingDescriptionStyle,
} from "@/lib/listings/listing-description-styles"

type Style = ListingDescriptionStyle

const STYLES: Array<{ value: Style; label: string }> = LISTING_DESCRIPTION_STYLES.map((value) => ({
  value,
  label: LISTING_DESCRIPTION_STYLE_LABELS[value],
}))

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
  const [style, setStyle] = useState<Style>(DEFAULT_LISTING_DESCRIPTION_STYLE)
  // The compliance findings on the last draft — shown, never swallowed (§5: warnings
  // pass through; a hard Fair-Housing flag withholds the copy server-side).
  const [warnings, setWarnings] = useState<string[]>([])
  // The social caption the SAME call wrote — for the new-listing marketing push.
  const [socialCaption, setSocialCaption] = useState<string | null>(null)
  // A draft the new-listing marketing kit already wrote for this listing.
  const [kitDraft, setKitDraft] = useState<{ mlsDescription: string | null; socialCaption: string | null; source: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    getListingDescriptionDraftAction(listingId)
      .then((r) => {
        if (!alive || !r.success || !r.draft?.mlsDescription) return
        setKitDraft({ mlsDescription: r.draft.mlsDescription, socialCaption: r.draft.socialCaption, source: r.draft.source })
      })
      .catch(() => { /* the offer is optional — the composer works without it */ })
    return () => { alive = false }
  }, [listingId])
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
          socialCaption?: string | null
          warnings?: string[]
        }
        setWarnings(res.warnings ?? [])
        // READ THE SERVER'S VERDICT. A kernel result that reports failure by
        // returning { success:false } rather than throwing must not look like a
        // successful generation that happened to produce nothing.
        if (!res.success || !res.description) {
          setError(res.error ?? "The description could not be generated.")
          return
        }
        setDraft(res.description)
        setSocialCaption(res.socialCaption ?? null)
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

      {kitDraft && kitDraft.mlsDescription !== draft.trim() && (
        <div className="rounded-md border border-dashed px-3 py-2 text-xs flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Inbox className="h-3.5 w-3.5" />
            {kitDraft.source === "new_listing_kit"
              ? "Your new-listing marketing kit drafted a description for this listing."
              : "An AI description draft is on file for this listing."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setDraft(kitDraft.mlsDescription ?? "")
              setSocialCaption(kitDraft.socialCaption)
              setSaved(false)
            }}
          >
            Load draft to review
          </Button>
        </div>
      )}

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

      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-700 space-y-0.5">
          <p className="font-medium flex items-center gap-1"><TriangleAlert className="h-3.5 w-3.5" />Compliance notes on this draft</p>
          {warnings.slice(0, 6).map((w, i) => <p key={i}>{w}</p>)}
        </div>
      )}

      {socialCaption && (
        <div className="rounded-md border px-3 py-2 space-y-1">
          <p className="text-[11px] font-medium flex items-center gap-1.5"><Megaphone className="h-3.5 w-3.5" />Social caption for the listing launch</p>
          <p className="text-xs whitespace-pre-wrap">{socialCaption}</p>
          <p className="text-[11px] text-muted-foreground">Copy it into your launch post — the new-listing kit stages the gated social draft.</p>
        </div>
      )}

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
