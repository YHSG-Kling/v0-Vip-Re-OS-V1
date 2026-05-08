/**
 * /embed/[publicId]
 *
 * The iframe loaded by /api/embed/script. Mounts the EmbedWidget — a public,
 * anon-friendly variant of AgentsWidget with lead-capture flow built in.
 *
 * No Supabase auth here — visitors are unauthenticated. The session route
 * authorizes via the embed's allowed_domains + cap-checks the brokerage's
 * tier limits before issuing a D-ID client_key.
 */

import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { EmbedWidget } from "./embed-widget"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ publicId: string }>
  searchParams: Promise<{ v?: string; origin?: string; ref?: string }>
}

export default async function EmbedPage({ params, searchParams }: PageProps) {
  const { publicId } = await params
  const { v: visitorId, origin, ref: referrer } = await searchParams

  if (!publicId || !visitorId) notFound()

  const supabase = createServiceClient()
  const { data: widget } = await supabase
    .from("embed_widgets")
    .select("public_id, label, welcome_message, enabled_modes, lead_capture_mode, lead_capture_fields, allowed_domains, style, is_active, brokerage_id")
    .eq("public_id", publicId)
    .maybeSingle()

  if (!widget || !widget.is_active) notFound()

  // Origin allowlist enforcement at iframe-load time. The script-tag check
  // protects the bubble; this guards against someone embedding the iframe
  // directly via <iframe src="…/embed/abc">.
  const allowed = (widget.allowed_domains ?? []) as string[]
  if (allowed.length > 0 && origin && !allowed.includes(origin)) {
    notFound()
  }

  return (
    <html lang="en">
      <head>
        <title>{`Chat with ${widget.label}`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
        <style>{`
          html, body { margin: 0; padding: 0; height: 100%; background: #fff; font-family: system-ui, -apple-system, sans-serif; }
          #root { height: 100%; }
        `}</style>
      </head>
      <body>
        <div id="root">
          <EmbedWidget
            publicId={publicId}
            visitorId={visitorId}
            origin={origin ?? null}
            referrer={referrer ?? null}
            welcomeMessage={widget.welcome_message ?? null}
            enabledModes={widget.enabled_modes as ("text" | "live")[]}
            leadCaptureMode={widget.lead_capture_mode as "immediate" | "after_first_message" | "optional"}
            leadCaptureFields={widget.lead_capture_fields as string[]}
            label={widget.label ?? "Chat"}
            style={widget.style as Record<string, any>}
          />
        </div>
      </body>
    </html>
  )
}
