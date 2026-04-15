"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Building2, Shield, ExternalLink, CheckCircle2 } from "lucide-react"
import { AgentSignaturePanel } from "../components/os/agent-signature-panel"

interface AgentBrandingClientProps {
  agentSignature: string | null
  brokerageSignature: string | null
  brokerageName: string | null
  brokerageLogoUrl: string | null
  isBrokerageAdmin: boolean
}

export function AgentBrandingClient({
  agentSignature,
  brokerageSignature,
  brokerageName,
  brokerageLogoUrl,
  isBrokerageAdmin,
}: AgentBrandingClientProps) {
  return (
    <div className="space-y-8">
      {/* Email Signature */}
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">Email Signature</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Appended to every outbound email. Your personal signature takes precedence over the brokerage default.
          </p>
        </div>
        <AgentSignaturePanel
          currentSignature={agentSignature}
          brokerageSignature={brokerageSignature}
        />
      </section>

      <Separator />

      {/* Compliance Logo */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Brokerage Compliance Logo
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Your brokerage logo is required on all marketing materials per NAR and state regulations.
              This logo is managed by your brokerage administrator.
            </p>
          </div>
          {isBrokerageAdmin && (
            <Button variant="outline" size="sm" asChild className="shrink-0 gap-1.5">
              <a href="/settings/branding">
                <ExternalLink className="h-3.5 w-3.5" />
                Edit in Brokerage Settings
              </a>
            </Button>
          )}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {brokerageName ?? "Your Brokerage"}
            </CardTitle>
            <CardDescription className="text-xs">
              This logo appears on your forms, marketing materials, and email footers for compliance.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {brokerageLogoUrl ? (
              <div className="space-y-3">
                <div className="rounded-lg border bg-white p-4 flex items-center justify-center min-h-[80px]">
                  <img
                    src={brokerageLogoUrl}
                    alt={brokerageName ?? "Brokerage logo"}
                    className="max-h-16 w-auto object-contain"
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Compliance logo configured
                </div>
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed bg-muted/20 p-6 text-center space-y-2">
                <Building2 className="h-8 w-8 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">No brokerage logo uploaded yet</p>
                {isBrokerageAdmin ? (
                  <Button size="sm" variant="outline" asChild className="gap-1.5">
                    <a href="/settings/branding">
                      Upload Logo in Brokerage Settings
                    </a>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Contact your brokerage administrator to upload the compliance logo.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="rounded-lg border bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-400 space-y-1">
          <p className="font-medium">Compliance Reminder</p>
          <p>
            State real estate regulations and NAR guidelines require your brokerage name and logo on all
            advertising materials including emails, social posts, and printed collateral.
          </p>
        </div>
      </section>
    </div>
  )
}
