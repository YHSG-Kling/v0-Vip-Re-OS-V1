"use client"

/**
 * THE Lead Magnets workspace — one surface for every persona.
 *
 * There used to be three near-identical copies of this screen:
 *   app/dashboard/agent/lead-magnets/page.tsx  (the advanced one — GBP tab)
 *   app/dashboard/admin/lead-magnets/page.tsx  (same screen, broker label)
 *   app/actions/lead-magnets.tsx               (a page component parked in
 *                                               app/actions/ with zero importers)
 * All three rendered the same four components with the same props and drifted
 * apart feature by feature: only the agent copy ever got PublishGuideToGbp, only
 * the agent copy read magnet_type. Consolidated per keep-the-advanced-one: this
 * is the agent copy, plus the brokerage-wide list that the admin copy's header
 * promised but never actually delivered (it passed an agent scope too).
 *
 * Marketing namespace rather than /agent or /admin because all three personas
 * reach it from the same "Marketing & Content" nav group — a shared screen
 * should not live behind one persona's path prefix.
 *
 * Wave 141 (lane 141E): a DRAFT state (AI drafts, clones and hand-built magnets
 * open on "Review & publish" first; the preview iframe shows a draft with
 * ?preview=1, which /lm/[slug] serves only to this tenant), and the proactive
 * idea panel ("Draft this with AI" pre-fills the builder).
 */

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { suggestLeadMagnetIdeasAction } from "@/app/actions/lead-magnets-actions"
import { MagnetLibrary } from "@/app/components/features/lead-magnets/MagnetLibrary"
import { MagnetBuilder } from "@/app/components/features/lead-magnets/MagnetBuilder"
import { MagnetDraftReview } from "@/app/components/features/lead-magnets/MagnetDraftReview"
import { QRCodeGenerator } from "@/app/components/features/lead-magnets/QRCodeGenerator"
import { PerformanceDashboard } from "@/app/components/features/lead-magnets/PerformanceDashboard"
import { PublishGuideToGbp } from "@/app/components/features/lead-magnets/PublishGuideToGbp"
import type { CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, BarChart2, FileText, QrCode, Magnet, Building2, Lightbulb, PencilLine, Wand2 } from "lucide-react"

type View = "library" | "new" | "detail"

/** Personas that see the whole brokerage's magnets. Mirrors the action's gate
 *  (isAdminOrBroker — the ONE tenant roster; operational marketing surface, so
 *  team_lead is included per the owner ruling). 'superadmin' was dead here:
 *  0 live rows store that users.user_type. */
const BROKERAGE_WIDE_ROLES = ["admin", "broker", "broker_owner", "broker_admin", "team_lead"]
const ALLOWED_ROLES = ["agent", "team_leader", ...BROKERAGE_WIDE_ROLES]

interface UserContext {
  userId: string
  brokerageId: string
  userType: string
}

interface SelectedMagnet {
  id: string
  name: string
  slug: string
  magnetType?: string
  qrCodeId?: string
  /** Wave 141: a draft opens on review first and previews with ?preview=1. */
  isDraft: boolean
}

interface Suggestion { key: string; kind: string; magnetType: string; concept: string; why: string; magnetId: string | null }

/** Wave 141: the OS's own ideas (seasonal / local-market / audience gap / underperformer / test). */
function LeadMagnetSuggestions({ onUse }: { onUse: (s: Suggestion) => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    suggestLeadMagnetIdeasAction().then((r) => {
      if (!live) return
      if (!r.success) { setNote(r.error ?? "Ideas unavailable"); setItems([]); return }
      setItems(r.suggestions as Suggestion[])
    })
    return () => { live = false }
  }, [])
  if (items === null) return null
  if (items.length === 0) return note ? <p className="text-xs text-muted-foreground">{note}</p> : null
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">Ideas worth drafting</p>
        </div>
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.key} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border p-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm">{s.concept}</p>
                <p className="text-xs text-muted-foreground">{s.kind.replace(/_/g, " ")} — {s.why}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => onUse(s)}>
                <Wand2 className="h-4 w-4 mr-1" /> Draft this with AI
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export default function LeadMagnetsPage() {
  const [ctx, setCtx] = useState<UserContext | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [view, setView] = useState<View>("library")
  const [selected, setSelected] = useState<SelectedMagnet | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [prefill, setPrefill] = useState<{ concept: string; magnetType: CreateLeadMagnetInput["magnetType"] } | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    async function loadUser() {
      const supabase = createClient()
      const { data: { user }, error } = await supabase.auth.getUser()
      if (error || !user) { setAuthError("Not authenticated"); return }

      const { data: profile } = await supabase
        .from("users")
        .select("user_type, brokerage_id")
        .eq("id", user.id)
        .single()

      if (!profile || !ALLOWED_ROLES.includes(profile.user_type)) {
        setAuthError("Insufficient permissions")
        return
      }

      setCtx({
        userId: user.id,
        brokerageId: profile.brokerage_id ?? "",
        userType: profile.user_type,
      })
    }
    loadUser()
  }, [])

  const brokerageWide = !!ctx && BROKERAGE_WIDE_ROLES.includes(ctx.userType)

  async function handleSelectMagnet(magnetId: string) {
    if (!ctx) return
    startTransition(async () => {
      const supabase = createClient()
      const { data: form } = await supabase
        .from("lead_capture_forms")
        .select("id, name, slug, magnet_type, is_active, settings")
        .eq("id", magnetId)
        .eq("brokerage_id", ctx.brokerageId)
        .single()

      if (form) {
        // Existing QR for this magnet. Brokerage + slug is already exact (slug is
        // unique per magnet) — deliberately NOT filtered by agent_id: qr_codes.agent_id
        // is a FK to agents(id) and the browser only holds the auth user id, so that
        // filter could never match and hid every QR that had been generated.
        const { data: qr } = await supabase
          .from("qr_codes")
          .select("id")
          .eq("brokerage_id", ctx.brokerageId)
          .eq("purpose", "lead_magnet")
          .ilike("target_url", `%${form.slug}%`)
          .eq("is_active", true)
          .maybeSingle()

        const lifecycle = ((form as { settings?: { lifecycle?: { state?: string } } | null }).settings?.lifecycle ?? null)
        setSelected({
          id: form.id,
          name: form.name,
          slug: form.slug,
          magnetType: (form as { magnet_type?: string }).magnet_type,
          qrCodeId: qr?.id,
          isDraft: lifecycle?.state === "draft",
        })
        setView("detail")
      }
    })
  }

  function handleCreated(magnetId: string, slug: string) {
    setSelected({ id: magnetId, name: slug, slug, isDraft: false })
    setRefreshKey((k) => k + 1)
    setView("detail")
  }

  /** The AI wrote a real draft — open it on review (the same path a clone takes). */
  function handleDrafted(magnetId: string) {
    setRefreshKey((k) => k + 1)
    setPrefill(null)
    void handleSelectMagnet(magnetId)
  }

  function handlePublished(magnetId: string, slug: string) {
    setSelected((prev) => (prev ? { ...prev, isDraft: false, slug } : prev))
    setRefreshKey((k) => k + 1)
    void magnetId
  }

  if (authError) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-destructive">{authError}</p>
      </div>
    )
  }

  if (!ctx) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  const previewSrc = selected ? `/lm/${selected.slug}${selected.isDraft ? "?preview=1" : ""}` : ""

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        {view !== "library" && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setView("library"); setSelected(null); setPrefill(null) }}
            aria-label="Back to library"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Magnet className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold leading-none">
              {view === "library"
                ? brokerageWide ? "Lead Magnets" : "My Lead Magnets"
                : view === "new"
                ? "New Lead Magnet"
                : selected?.name ?? "Lead Magnet Detail"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {view === "library"
                ? brokerageWide
                  ? "Every lead capture campaign in your brokerage"
                  : "Create and manage your lead capture campaigns"
                : view === "new"
                ? "Configure your lead magnet and publishing channels"
                : `/lm/${selected?.slug}${selected?.isDraft ? " (draft)" : ""}`}
            </p>
          </div>
        </div>
      </div>

      {view === "library" && (
        <>
          <LeadMagnetSuggestions
            onUse={(s) => {
              setPrefill({ concept: s.concept, magnetType: s.magnetType as CreateLeadMagnetInput["magnetType"] })
              setView("new")
            }}
          />
          <MagnetLibrary
            key={refreshKey}
            brokerageId={ctx.brokerageId}
            onSelectMagnet={handleSelectMagnet}
            onCreateNew={() => { setPrefill(null); setView("new") }}
          />
        </>
      )}

      {view === "new" && (
        <MagnetBuilder
          brokerageId={ctx.brokerageId}
          onCreated={handleCreated}
          onDrafted={handleDrafted}
          initialConcept={prefill?.concept}
          initialMagnetType={prefill?.magnetType}
        />
      )}

      {view === "detail" && selected && (
        <Tabs defaultValue={selected.isDraft ? "draft" : "analytics"} className="space-y-4">
          <TabsList>
            <TabsTrigger value="draft" className="flex items-center gap-2">
              <PencilLine className="h-4 w-4" />
              {selected.isDraft ? "Review & publish" : "Edit"}
            </TabsTrigger>
            <TabsTrigger value="analytics" className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="qr" className="flex items-center gap-2">
              <QrCode className="h-4 w-4" />
              QR Code
            </TabsTrigger>
            <TabsTrigger value="preview" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="gbp" className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Google Business
            </TabsTrigger>
          </TabsList>

          <TabsContent value="draft">
            <MagnetDraftReview magnetId={selected.id} onPublished={handlePublished} />
          </TabsContent>

          <TabsContent value="analytics">
            <PerformanceDashboard
              magnetId={selected.id}
              brokerageId={ctx.brokerageId}
              magnetName={selected.name}
            />
          </TabsContent>

          <TabsContent value="qr">
            {selected.isDraft ? (
              <p className="text-sm text-muted-foreground">Publish this draft first — a QR code must point at a live page.</p>
            ) : (
              <QRCodeGenerator
                magnetId={selected.id}
                magnetSlug={selected.slug}
                brokerageId={ctx.brokerageId}
                existingQrCodeId={selected.qrCodeId}
              />
            )}
          </TabsContent>

          <TabsContent value="preview">
            <div className="border rounded-xl overflow-hidden bg-muted/20">
              <div className="bg-muted/40 border-b px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">/lm/{selected.slug}</span>
                <span>—</span>
                <span>{selected.isDraft ? "Draft preview (only you can see this)" : "Public landing page preview"}</span>
              </div>
              <iframe
                src={previewSrc}
                title={`Preview of ${selected.name}`}
                className="w-full h-[600px] border-0"
              />
            </div>
          </TabsContent>

          <TabsContent value="gbp">
            <PublishGuideToGbp
              defaultMagnetType={selected.magnetType}
              magnetSlug={selected.slug}
            />
          </TabsContent>
        </Tabs>
      )}
      {isPending && <p className="sr-only">Loading</p>}
    </div>
  )
}
