"use client"

// app/components/features/admin/domain-coherence/DomainCoherenceWorkspace.tsx
// Input contract:  initialReport: CoherenceReport (from RSC), brokerageId: string
// Output contract: renders 6-tab workspace — Routes, Ownership, Duplicates,
//                  Providers, Contracts, Navigation
// Tables read:     none (all data from kernel registry commands)
// Tables written:  none

import { useState, useTransition } from "react"
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, ArrowRight, ExternalLink } from "lucide-react"
import Link from "next/link"
import {
  actionGenerateDomainCoherenceReport,
  actionNormalizeNavigationVisibility,
} from "@/app/actions/admin/domain-coherence"
import {
  enumerateDomainRoutes,
  validateCanonicalManagerUsage,
  validateProviderBackedFeatures,
  type CoherenceReport,
  type RouteEntry,
  type NormalizeNavInput,
} from "@/lib/kernel/routes"

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_COLORS = {
  clean: "bg-green-100 text-green-800 border-green-200",
  needs_review: "bg-amber-100 text-amber-800 border-amber-200",
  critical: "bg-red-100 text-red-800 border-red-200",
} as const

const SEVERITY_ICON = {
  info: <CheckCircle2 className="h-4 w-4 text-blue-500 shrink-0" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  critical: <XCircle className="h-4 w-4 text-red-500 shrink-0" />,
} as const

const CLASSIFICATION_BADGE = {
  canonical: "bg-green-100 text-green-800",
  redirect_to: "bg-blue-100 text-blue-800",
  remove: "bg-red-100 text-red-800",
  supporting_child: "bg-gray-100 text-gray-700",
} as const

const PERSONA_TYPES = [
  "public",
  "authenticated",
  "agent",
  "broker",
  "superadmin",
] as const

const KERNEL_MODULES = [
  "lib/kernel/portal.ts",
  "lib/kernel/billing.ts",
  "lib/kernel/vendors.ts",
  "lib/kernel/education.ts",
  "lib/kernel/video.ts",
  "lib/kernel/lead-magnets.ts",
  "lib/kernel/communication-compliance.ts",
  "lib/kernel/forms.ts",
  "lib/kernel/routes.ts",
  "lib/kernel/transactions.ts",
  "lib/kernel/listings.ts",
]

const PROVIDER_DOMAINS = [
  "portal", "billing", "vendors", "education", "video",
  "lead_magnets", "compliance", "forms", "transactions", "listings",
]

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  initialReport: CoherenceReport
}

export function DomainCoherenceWorkspace({ initialReport }: Props) {
  const [report, setReport] = useState<CoherenceReport>(initialReport)
  const [isPending, startTransition] = useTransition()
  const [navPreviewType, setNavPreviewType] = useState<NormalizeNavInput["userType"]>("broker")
  const [navVisible, setNavVisible] = useState<RouteEntry[]>([])
  const [navHidden, setNavHidden] = useState<RouteEntry[]>([])
  const [navLoaded, setNavLoaded] = useState(false)

  // Static data from kernel (no async needed — pure registry)
  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const managerValidation = validateCanonicalManagerUsage({ kernelModules: KERNEL_MODULES })
  const providerValidation = validateProviderBackedFeatures({ domains: PROVIDER_DOMAINS })

  function handleRefresh() {
    startTransition(async () => {
      const result = await actionGenerateDomainCoherenceReport()
      if (result.success) setReport(result.data)
    })
  }

  function handleNavPreview(userType: NormalizeNavInput["userType"]) {
    setNavPreviewType(userType)
    startTransition(async () => {
      const result = await actionNormalizeNavigationVisibility({ userType, routes })
      if (result.success) {
        setNavVisible(result.data.visible)
        setNavHidden(result.data.hidden)
        setNavLoaded(true)
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Domain Coherence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Route registry audit — {report.totalRoutes} routes across {Object.keys(report).length} domains.
            Generated {new Date(report.generatedAt).toLocaleString()}.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Badge className={`border ${STATUS_COLORS[report.overallStatus]} font-medium`}>
            {report.overallStatus === "clean" && "Clean"}
            {report.overallStatus === "needs_review" && "Needs Review"}
            {report.overallStatus === "critical" && "Critical"}
          </Badge>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isPending}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isPending ? "animate-spin" : ""}`} />
            Re-run Audit
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-foreground">{report.canonicalCount}</p>
            <p className="text-xs text-muted-foreground">Canonical Routes</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-blue-600">{report.redirectCount}</p>
            <p className="text-xs text-muted-foreground">Redirecting (legacy)</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-600">{report.findings.filter(f => f.severity === "warning").length}</p>
            <p className="text-xs text-muted-foreground">Warnings</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-red-600">{report.findings.filter(f => f.severity === "critical").length}</p>
            <p className="text-xs text-muted-foreground">Critical Issues</p>
          </CardContent>
        </Card>
      </div>

      {/* 6-tab workspace */}
      <Tabs defaultValue="routes">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="routes">Routes Audit</TabsTrigger>
          <TabsTrigger value="ownership">Manager Ownership</TabsTrigger>
          <TabsTrigger value="duplicates">Duplicate Detection</TabsTrigger>
          <TabsTrigger value="providers">Provider Validation</TabsTrigger>
          <TabsTrigger value="contracts">Contract Integrity</TabsTrigger>
          <TabsTrigger value="navigation">Navigation Preview</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Routes Audit ─────────────────────────────────────── */}
        <TabsContent value="routes" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Route Registry — {routes.length} total</CardTitle>
              <CardDescription>
                Every known route classified by domain, kernel owner, and access level.
                Persona-specific legacy routes are included for visibility.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Path</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Kernel Owner</TableHead>
                    <TableHead>Persona</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.map(r => (
                    <TableRow key={r.id} className={r.isPersonaSpecific ? "bg-amber-50/50" : ""}>
                      <TableCell className="font-mono text-xs max-w-[200px] truncate">
                        {r.path}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{r.domain}</span>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${CLASSIFICATION_BADGE[r.classification]}`}>
                          {r.classification}
                        </Badge>
                        {r.redirectTarget && (
                          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                            <ArrowRight className="h-3 w-3" />
                            {r.redirectTarget}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">{r.accessLevel}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground max-w-[160px] truncate">
                        {r.kernelOwner}
                      </TableCell>
                      <TableCell>
                        {r.isPersonaSpecific && (
                          <Badge className="text-xs bg-amber-100 text-amber-800">legacy</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Manager Ownership ────────────────────────────────── */}
        <TabsContent value="ownership" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Kernel Module Ownership Matrix</CardTitle>
              <CardDescription>
                Each kernel module must own at least one canonical route.
                Unverified modules have no routes claiming them as owner.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4 mb-4">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span>{managerValidation.verified} verified</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span>{managerValidation.unverified} unverified</span>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kernel Module</TableHead>
                    <TableHead>Canonical Routes</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {managerValidation.modules.map(mod => (
                    <TableRow key={mod.module}>
                      <TableCell className="font-mono text-xs">{mod.module}</TableCell>
                      <TableCell className="text-sm">{mod.canonicalRouteCount}</TableCell>
                      <TableCell>
                        {mod.status === "verified" ? (
                          <Badge className="bg-green-100 text-green-800 text-xs">Verified</Badge>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-800 text-xs">Unverified</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Duplicate Detection ──────────────────────────────── */}
        <TabsContent value="duplicates" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Duplicate Manager Surfaces</CardTitle>
              <CardDescription>
                Domains where more than one canonical route claims ownership.
                Each domain must have exactly one canonical route.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {report.duplicateSets.length === 0 ? (
                <div className="flex items-center gap-2 p-4 bg-green-50 rounded-lg border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <p className="text-sm text-green-800">No duplicate manager surfaces detected.</p>
                </div>
              ) : (
                report.duplicateSets.map(set => (
                  <Card key={set.domain} className="border-amber-200 bg-amber-50/40">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">Domain: <span className="text-amber-700">{set.domain}</span></p>
                        <Badge className="bg-amber-100 text-amber-800 text-xs">{set.duplicates.length + 1} surfaces</Badge>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <Badge className="bg-green-100 text-green-800 text-xs shrink-0 mt-0.5">Keep</Badge>
                          <p className="font-mono text-xs">{set.canonical.path}</p>
                        </div>
                        {set.duplicates.map(dup => (
                          <div key={dup.id} className="flex items-start gap-2">
                            <Badge className="bg-red-100 text-red-800 text-xs shrink-0 mt-0.5">Redirect/Remove</Badge>
                            <p className="font-mono text-xs">{dup.path}</p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 4: Provider Validation ──────────────────────────────── */}
        <TabsContent value="providers" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Provider-Backed Feature Validation</CardTitle>
              <CardDescription>
                Verifies each business domain has a canonical route registered and a kernel owner assigned.
                Domains without a canonical route cannot receive provider-cascaded data.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Kernel Owner</TableHead>
                    <TableHead>Canonical Route</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providerValidation.results.map(r => (
                    <TableRow key={r.domain}>
                      <TableCell className="text-sm font-medium">{r.domain}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.kernelOwner ?? <span className="text-red-500">— missing</span>}
                      </TableCell>
                      <TableCell>
                        {r.hasCanonicalRoute ? (
                          <Badge className="bg-green-100 text-green-800 text-xs">Present</Badge>
                        ) : (
                          <Badge className="bg-red-100 text-red-800 text-xs">Missing</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 5: Contract Integrity ───────────────────────────────── */}
        <TabsContent value="contracts" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Contract Integrity Findings</CardTitle>
              <CardDescription>
                Route registry validation: persona routes classified correctly,
                redirect targets present, removal reasons documented.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.findings.length === 0 ? (
                <div className="flex items-center gap-2 p-4 bg-green-50 rounded-lg border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <p className="text-sm text-green-800">All contracts pass validation. No issues found.</p>
                </div>
              ) : (
                report.findings.map((f, i) => (
                  <div key={i} className={`p-4 rounded-lg border flex gap-3 ${
                    f.severity === "critical" ? "bg-red-50 border-red-200" :
                    f.severity === "warning" ? "bg-amber-50 border-amber-200" :
                    "bg-blue-50 border-blue-200"
                  }`}>
                    {SEVERITY_ICON[f.severity]}
                    <div className="space-y-1 min-w-0">
                      <p className="text-sm font-medium">{f.message}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        Affected: {f.affected.join(", ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Fix: {f.recommendation}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 6: Navigation Preview ───────────────────────────────── */}
        <TabsContent value="navigation" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Role-Based Navigation Preview</CardTitle>
              <CardDescription>
                Preview which canonical routes are visible for each user type.
                Only canonical routes pass the access level filter.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {PERSONA_TYPES.map(type => (
                  <Button
                    key={type}
                    size="sm"
                    variant={navPreviewType === type ? "default" : "outline"}
                    onClick={() => handleNavPreview(type)}
                    disabled={isPending}
                  >
                    {type}
                  </Button>
                ))}
              </div>

              {navLoaded && (
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-semibold text-green-700 mb-2">
                      Visible ({navVisible.length})
                    </p>
                    <div className="space-y-1.5">
                      {navVisible.map(r => (
                        <div key={r.id} className="flex items-center justify-between p-2 bg-green-50 border border-green-200 rounded text-xs">
                          <span className="font-mono truncate max-w-[200px]">{r.path}</span>
                          <span className="text-muted-foreground shrink-0 ml-2">{r.domain}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-2">
                      Hidden ({navHidden.length})
                    </p>
                    <div className="space-y-1.5">
                      {navHidden.slice(0, 10).map(r => (
                        <div key={r.id} className="flex items-center justify-between p-2 bg-muted/40 border border-border rounded text-xs opacity-60">
                          <span className="font-mono truncate max-w-[200px]">{r.path}</span>
                          <span className="text-muted-foreground shrink-0 ml-2">{r.accessLevel}</span>
                        </div>
                      ))}
                      {navHidden.length > 10 && (
                        <p className="text-xs text-muted-foreground pl-2">+{navHidden.length - 10} more hidden</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!navLoaded && (
                <p className="text-sm text-muted-foreground">Select a user type above to preview navigation visibility.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
