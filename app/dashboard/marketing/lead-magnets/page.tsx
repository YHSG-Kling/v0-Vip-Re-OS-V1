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
 */

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { MagnetLibrary } from "@/app/components/features/lead-magnets/MagnetLibrary"
import { MagnetBuilder } from "@/app/components/features/lead-magnets/MagnetBuilder"
import { QRCodeGenerator } from "@/app/components/features/lead-magnets/QRCodeGenerator"
import { PerformanceDashboard } from "@/app/components/features/lead-magnets/PerformanceDashboard"
import { PublishGuideToGbp } from "@/app/components/features/lead-magnets/PublishGuideToGbp"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, BarChart2, FileText, QrCode, Magnet, Building2 } from "lucide-react"

type View = "library" | "new" | "detail"

/** Personas that see the whole brokerage's magnets. Mirrors BROKERAGE_WIDE_ROLES in the action. */
const BROKERAGE_WIDE_ROLES = ["admin", "broker", "superadmin"]
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
}

export default function LeadMagnetsPage() {
  const [ctx, setCtx] = useState<UserContext | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [view, setView] = useState<View>("library")
  const [selected, setSelected] = useState<SelectedMagnet | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
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
        .select("id, name, slug, magnet_type")
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

        setSelected({
          id: form.id,
          name: form.name,
          slug: form.slug,
          magnetType: (form as { magnet_type?: string }).magnet_type,
          qrCodeId: qr?.id,
        })
        setView("detail")
      }
    })
  }

  function handleCreated(magnetId: string, slug: string) {
    setSelected({ id: magnetId, name: slug, slug })
    setRefreshKey((k) => k + 1)
    setView("detail")
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

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        {view !== "library" && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setView("library"); setSelected(null) }}
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
                : `/lm/${selected?.slug}`}
            </p>
          </div>
        </div>
      </div>

      {view === "library" && (
        <MagnetLibrary
          key={refreshKey}
          brokerageId={ctx.brokerageId}
          onSelectMagnet={handleSelectMagnet}
          onCreateNew={() => setView("new")}
        />
      )}

      {view === "new" && (
        <MagnetBuilder
          brokerageId={ctx.brokerageId}
          onCreated={handleCreated}
        />
      )}

      {view === "detail" && selected && (
        <Tabs defaultValue="analytics" className="space-y-4">
          <TabsList>
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

          <TabsContent value="analytics">
            <PerformanceDashboard
              magnetId={selected.id}
              brokerageId={ctx.brokerageId}
              magnetName={selected.name}
            />
          </TabsContent>

          <TabsContent value="qr">
            <QRCodeGenerator
              magnetId={selected.id}
              magnetSlug={selected.slug}
              brokerageId={ctx.brokerageId}
              existingQrCodeId={selected.qrCodeId}
            />
          </TabsContent>

          <TabsContent value="preview">
            <div className="border rounded-xl overflow-hidden bg-muted/20">
              <div className="bg-muted/40 border-b px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">/lm/{selected.slug}</span>
                <span>—</span>
                <span>Public landing page preview</span>
              </div>
              <iframe
                src={`/lm/${selected.slug}`}
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
    </div>
  )
}
