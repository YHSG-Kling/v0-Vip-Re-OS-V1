// app/trust/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TRUST & SECURITY PAGE — the security-posture surface a brokerage's
// broker/owner (or their IT reviewer) looks for before buying. Every claim on
// this page describes a mechanism that actually exists in this codebase (RLS
// tenant isolation + isolation self-tests, audited staff access/impersonation,
// Stripe-hosted payments, offboarding data export, suppression/consent rails,
// the platform emergency stop, DSAR intake). Deliberately NO certification
// claims — honesty is the posture. Brand-driven like /pricing (the product
// name is a platform setting, never hardcoded).

import type { Metadata } from "next"
import Link from "next/link"
import {
  ShieldCheck, Lock, CreditCard, DatabaseBackup, EyeOff, PhoneOff, Power, FileSearch,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { createServiceClient } from "@/lib/supabase/service"
import { loadProductBrand } from "@/lib/platform/product-brand"

export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const brand = await loadProductBrand(createServiceClient())
  return {
    title: `Trust & Security — ${brand.name}`,
    description: `How ${brand.name} protects your brokerage's data: tenant isolation, audited access, Stripe-hosted payments, portable data, and communication compliance.`,
  }
}

export default async function TrustPage() {
  const brand = await loadProductBrand(createServiceClient())

  const sections: Array<{ icon: React.ReactNode; title: string; body: React.ReactNode }> = [
    {
      icon: <Lock className="h-5 w-5 text-emerald-600" />,
      title: "Tenant isolation, enforced in the database",
      body: (
        <>
          Every brokerage&apos;s data is partitioned by tenant and protected with PostgreSQL row-level
          security — isolation is enforced at the database layer, not just in application code. On top of
          that, automated isolation self-tests continuously probe for cross-tenant leaks, and any finding is
          tracked to resolution on an internal safety board.
        </>
      ),
    },
    {
      icon: <EyeOff className="h-5 w-5 text-emerald-600" />,
      title: "Staff access is audited — including impersonation",
      body: (
        <>
          Platform staff actions run through a capability system (least privilege by role), and sensitive
          operations are written to an append-only audit log with actor, IP, and user agent. When support
          staff view your workspace to help you, the impersonation session itself is recorded — start, end,
          and the real human behind it.
        </>
      ),
    },
    {
      icon: <CreditCard className="h-5 w-5 text-emerald-600" />,
      title: "Payments handled by Stripe",
      body: (
        <>
          Subscriptions, invoices, and card details are processed by Stripe (a PCI-DSS Level 1 service
          provider). Your card number never touches our servers — checkout and the self-serve billing portal
          are Stripe-hosted surfaces.
        </>
      ),
    },
    {
      icon: <DatabaseBackup className="h-5 w-5 text-emerald-600" />,
      title: "Your data stays portable",
      body: (
        <>
          Leaving should never mean losing your business records. A full account export — contacts, leads,
          transactions, communications — is part of offboarding, and privacy requests (access, correction,
          deletion under CCPA/CPRA and GDPR) can be filed any time at{" "}
          <Link href="/privacy/request" className="underline">the privacy request page</Link>. Data is hosted
          on managed cloud infrastructure (Vercel and Supabase) with encryption in transit and at rest.
        </>
      ),
    },
    {
      icon: <PhoneOff className="h-5 w-5 text-emerald-600" />,
      title: "Communication compliance is built in",
      body: (
        <>
          The AI team&apos;s outreach runs through consent and suppression rails: a platform-wide
          do-not-contact suppression list, opt-out handling, TCPA/DNC awareness on calling, and A2P 10DLC
          registration for business texting. Wire-fraud sentinels watch transaction communications for the
          scams that target real-estate closings.
        </>
      ),
    },
    {
      icon: <Power className="h-5 w-5 text-emerald-600" />,
      title: "A real emergency stop",
      body: (
        <>
          Autonomous AI actions are governed by an earned-autonomy system with human approval gates — and the
          platform carries a global circuit breaker that can freeze every autonomous action, for every
          tenant, with one switch. During any incident, status is communicated to customers in-app.
        </>
      ),
    },
    {
      icon: <FileSearch className="h-5 w-5 text-emerald-600" />,
      title: "Where we are honest about maturity",
      body: (
        <>
          We do not currently hold SOC 2 or ISO 27001 certification, and we won&apos;t imply otherwise with
          badge walls. Formal third-party attestation is on our roadmap; in the meantime this page describes
          the controls that actually exist, and we&apos;ll answer security questionnaires directly —{" "}
          <Link href="/support" className="underline">contact us</Link>.
        </>
      ),
    },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-3xl mx-auto px-6 py-14">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-3">
            <ShieldCheck className="h-10 w-10 text-emerald-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Trust &amp; Security</h1>
          <p className="text-muted-foreground mt-3 max-w-xl mx-auto">
            {brand.name} runs your brokerage&apos;s most sensitive asset — your client relationships. Here is
            how that data is protected, in plain language, with no claims we can&apos;t back.
          </p>
        </div>

        <div className="space-y-4">
          {sections.map((s) => (
            <Card key={s.title}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {s.icon}
                  {s.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="text-center mt-10 text-sm text-muted-foreground">
          <p>
            Questions about security, data handling, or retention?{" "}
            <Link href="/privacy/request" className="underline">File a privacy request</Link> or{" "}
            <Link href="/pricing" className="underline">see plans &amp; pricing</Link>.
          </p>
        </div>
      </div>
    </div>
  )
}
