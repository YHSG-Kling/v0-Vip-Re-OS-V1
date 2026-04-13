"use client"

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { MagnetLibrary } from "@/app/components/features/lead-magnets/MagnetLibrary"
import { MagnetBuilder } from "@/app/components/features/lead-magnets/MagnetBuilder"
import { QRCodeGenerator } from "@/app/components/features/lead-magnets/QRCodeGenerator"
import { PerformanceDashboard } from "@/app/components/features/lead-magnets/PerformanceDashboard"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, BarChart2, FileText, QrCode, Magnet } from "lucide-react"

type View = "library" | "new" | "detail"

interface UserContext {
  userId: string
  brokerageId: string
  agentId: string
  userType: string
}

interface SelectedMagnet {
  id: string
  name: string
  slug: string
  qrCodeId?: string
}

export default function AdminLeadMagnetsPage() {
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

      if (!profile || !["admin", "broker", "superadmin"].includes(profile.user_type)) {
        setAuthError("Insufficient permissions")
        return
      }

      setCtx({
        userId: user.id,
        brokerageId: profile.brokerage_id,
        agentId: user.id,
        userType: profile.user_type,
      })
    }
    loadUser()
  }, [])

  async function handleSelectMagnet(magnetId: string) {
    if (!ctx) return
    startTransition(async () => {
      const supabase = createClient()
      const { data: form } = await supabase
        .from("lead_capture_forms")
        .select("id, name, slug")
        .eq("id", magnetId)
        .eq("brokerage_id", ctx.brokerageId)
        .single()

      if (form) {
        // Look up QR code for this magnet
        const { data: qr } = await supabase
          .from("qr_codes")
          .select("id")
          .eq("brokerage_id", ctx.brokerageId)
          .eq("purpose", "lead_magnet")
          .ilike("target_url", `%${form.slug}%`)
          .eq("is_active", true)
          .maybeSingle()

        setSelected({ id: form.id, name: form.name, slug: form.slug, qrCodeId: qr?.id })
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
      {/* Header */}
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
              {view === "library" ? "Lead Magnets" : view === "new" ? "New Lead Magnet" : selected?.name ?? "Lead Magnet Detail"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {view === "library"
                ? "Create and manage lead capture campaigns"
                : view === "new"
                ? "Configure your lead magnet and publishing channels"
                : `/lm/${selected?.slug}`}
            </p>
          </div>
        </div>
      </div>

      {/* Library View */}
      {view === "library" && (
        <MagnetLibrary
          key={refreshKey}
          brokerageId={ctx.brokerageId}
          agentId={ctx.agentId}
          onSelectMagnet={handleSelectMagnet}
          onCreateNew={() => setView("new")}
        />
      )}

      {/* Builder View */}
      {view === "new" && (
        <MagnetBuilder
          brokerageId={ctx.brokerageId}
          agentId={ctx.agentId}
          onCreated={handleCreated}
        />
      )}

      {/* Detail View — tabbed: Analytics | QR Code */}
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
              agentId={ctx.agentId}
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
        </Tabs>
      )}
    </div>
  )
}
