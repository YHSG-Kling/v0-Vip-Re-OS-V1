"use client"

// app/components/features/admin/domain-coherence/DomainCoherenceWorkspace.tsx
// Input contract:  initial: the results of SEVEN gated server actions, resolved
//                  by the RSC page; staffRole: the resolved platform role.
// Output contract: renders a 6-tab workspace — Routes, Ownership, Duplicates,
//                  Providers, Contracts, Navigation — always showing the
//                  SERVER's verdict.
// Tables read:     none (registry commands, no DB).
// Tables written:  none.
//
// WHY NO KERNEL IMPORTS HERE: this component used to import
// enumerateDomainRoutes / validateCanonicalManagerUsage /
// validateProviderBackedFeatures from lib/kernel/routes and run them in the
// BROWSER. That shipped the entire platform route registry into the client
// bundle and computed three of the six tabs with no authorization check at all
// — the gated server actions that exist for exactly this job had zero callers.
// Everything below now renders what a gated server action returned.

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
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, ArrowRight, ShieldAlert } from "lucide-react"
import {
  actionEnumerateDomainRoutes,
  actionClassifyRouteOwnership,
  actionDetectDuplicateManagerSurfaces,
  actionValidateCanonicalManagerUsage,
  actionValidateProviderBackedFeatures,
  actionValidateContractIntegrity,
  actionGenerateDomainCoherenceReport,
  actionNormalizeNavigationVisibility,
} from "@/app/actions/admin/domain-coherence"
import type {
  CoherenceReport,
  RouteEntry,
  NormalizeNavInput,
  EnumerateRoutesOutput,
  ClassifyOwnershipOutput,
  DetectDuplicatesOutput,
  ValidateManagerOutput,
  ValidateProvidersOutput,
  ValidateContractsOutput,
} from "@/lib/kernel/routes"

// ─── Action result contract ───────────────────────────────────────────────────

type ActionResult<T> = { success: true; data: T } | { success: false; error: string }

export interface CoherenceInitialData {
  report: ActionResult<CoherenceReport>
  routes: ActionResult<EnumerateRoutesOutput>
  ownership: ActionResult<ClassifyOwnershipOutput>
  duplicates: ActionResult<DetectDuplicatesOutput>
  managers: ActionResult<ValidateManagerOutput>
  providers: ActionResult<ValidateProvidersOutput>
  contracts: ActionResult<ValidateContractsOutput>
}

interface Props {
  initial: CoherenceInitialData
  staffRole: string
}

// Kept in sync with the server page; re-sent on refresh so the SERVER, not the
// browser, decides what the audit covers.
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

const PERSONA_TYPES = [
  "public",
  "authenticated",
  "agent",
  "broker",
  "superadmin",
] as const

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

/**
 * A refused action must NEVER fall through to an empty table that reads
 * "nothing wrong here". Every tab routes its failure through this.
 */
function ActionRefusal({ label, error }: { label: string; error: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4">
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-red-800">{label} could not be produced</p>
        <p className="text-xs text-red-700">{error}</p>
        <p className="text-xs text-red-700">
          This is a refusal, not a clean result. Nothing on this tab has been audited.
        </p>
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DomainCoherenceWorkspace({ initial, staffRole }: Props) {
  const [data, setData] = useState<CoherenceInitialData>(initial)
  const [isPending, startTransition] = useTransition()
  const [navPreviewType, setNavPreviewType] = useState<NormalizeNavInput["userType"]>("broker")
  const [navVisible, setNavVisible] = useState<RouteEntry[]>([])
  const [navHidden, setNavHidden] = useState<RouteEntry[]>([])
  const [navState, setNavState] = useState<"idle" | "loaded" | "refused">("idle")
  const [navError, setNavError] = useState<string>("")

  const routes: RouteEntry[] = data.routes.success ? data.routes.data.routes : []

  function handleRefresh() {
    startTransition(async () => {
      const [report, routesResult, ownership, duplicates, managers, providers, contracts] =
        await Promise.all([
          actionGenerateDomainCoherenceReport(),
          actionEnumerateDomainRoutes({ includePersonaRoutes: true }),
          actionClassifyRouteOwnership(),
          actionDetectDuplicateManagerSurfaces(),
          actionValidateCanonicalManagerUsage({ kernelModules: KERNEL_MODULES }),
          actionValidateProviderBackedFeatures({ domains: PROVIDER_DOMAINS }),
          actionValidateContractIntegrity(),
        ])
      setData({
        report,
        routes: routesResult,
        ownership,
        duplicates,
        managers,
        providers,
        contracts,
      })
    })
  }

  function handleNavPreview(userType: NormalizeNavInput["userType"]) {
    setNavPreviewType(userType)
    startTransition(async () => {
      const result = await actionNormalizeNavigationVisibility({ userType, routes })
      if (result.success) {
        setNavVisible(result.data.visible)
        setNavHidden(result.data.hidden)
        setNavState("loaded")
        setNavError("")
      } else {
        setNavVisible([])
        setNavHidden([])
        setNavState("refused")
        setNavError(result.error)
      }
    })
  }

  const report = data.report.success ? data.report.data : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Domain Coherence</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {report
              ? `Route registry audit — ${report.totalRoutes} routes. Generated ${new Date(report.generatedAt).toLocaleString()}.`
              : "Route registry audit — the coherence report was refused by the server."}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Platform governance surface · signed in as platform role{" "}
            <span className="font-mono">{staffRole}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {report ? (
            <Badge className={`border ${STATUS_COLORS[report.overallStatus]} font-medium`}>
              {report.overallStatus === "clean" && "Clean"}
              {report.overallStatus === "needs_review" && "Needs Review"}
              {report.overallStatus === "critical" && "Critical"}
            </Badge>
          ) : (
            <Badge className="border border-red-200 bg-red-100 text-red-800 font-medium">
              Unavailable
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isPending}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isPending ? "animate-spin" : ""}`} />
            Re-run Audit
          </Button>
        </div>
      </div>

      {/* KPI strip — only rendered from a report the server actually produced. */}
      {report ? (
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
              <p className="text-2xl font-bold text-amber-600">
                {report.findings.filter(f => f.severity === "warning").length}
              </p>
              <p className="text-xs text-muted-foreground">Warnings</p>
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-red-600">
                {report.findings.filter(f => f.severity === "critical").length}
              </p>
              <p className="text-xs text-muted-foreground">Critical Issues</p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <ActionRefusal
          label="Coherence report"
          error={data.report.success ? "" : data.report.error}
        />
      )}

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

        {/* ── Tab 1: Routes Audit (actionEnumerateDomainRoutes +
                     actionClassifyRouteOwnership) ─────────────────────────── */}
        <TabsContent value="routes" className="mt-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>
                Route Registry{data.routes.success ? ` — ${data.routes.data.total} total` : ""}
              </CardTitle>
              <CardDescription>
                Every known route classified by domain, kernel owner, and access level.
                Persona-specific legacy routes are included for visibility.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 overflow-x-auto">
              {!data.routes.success ? (
                <ActionRefusal label="Route enumeration" error={data.routes.error} />
              ) : (
                <>
                  {data.ownership.success ? (
                    <div className="flex flex-wrap gap-4 text-sm">
                      <span>{data.ownership.data.canonical.length} canonical</span>
                      <span>{data.ownership.data.redirects.length} redirecting</span>
                      <span>{data.ownership.data.toRemove.length} to remove</span>
                      <span>{data.ownership.data.children.length} supporting children</span>
                      <span className={data.ownership.data.unclassified.length > 0 ? "text-red-600 font-medium" : ""}>
                        {data.ownership.data.unclassified.length} unclassified
                      </span>
                    </div>
                  ) : (
                    <ActionRefusal label="Ownership classification" error={data.ownership.error} />
                  )}

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
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Manager Ownership (actionValidateCanonicalManagerUsage) ── */}
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
              {!data.managers.success ? (
                <ActionRefusal label="Manager ownership validation" error={data.managers.error} />
              ) : (
                <>
                  <div className="flex gap-4 mb-4">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span>{data.managers.data.verified} verified</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <span>{data.managers.data.unverified} unverified</span>
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
                      {data.managers.data.modules.map(mod => (
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
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Duplicate Detection (actionDetectDuplicateManagerSurfaces) */}
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
              {!data.duplicates.success ? (
                <ActionRefusal label="Duplicate detection" error={data.duplicates.error} />
              ) : data.duplicates.data.duplicateSets.length === 0 ? (
                <div className="flex items-center gap-2 p-4 bg-green-50 rounded-lg border border-green-200">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <p className="text-sm text-green-800">
                    No duplicate manager surfaces detected across{" "}
                    {data.duplicates.data.cleanDomains.length} domain(s) checked.
                  </p>
                </div>
              ) : (
                data.duplicates.data.duplicateSets.map(set => (
                  <Card key={set.domain} className="border-amber-200 bg-amber-50/40">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">
                          Domain: <span className="text-amber-700">{set.domain}</span>
                        </p>
                        <Badge className="bg-amber-100 text-amber-800 text-xs">
                          {set.duplicates.length + 1} surfaces
                        </Badge>
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

        {/* ── Tab 4: Provider Validation (actionValidateProviderBackedFeatures) */}
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
              {!data.providers.success ? (
                <ActionRefusal label="Provider validation" error={data.providers.error} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>Kernel Owner</TableHead>
                      <TableHead>Canonical Route</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.providers.data.results.map(r => (
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
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 5: Contract Integrity (actionValidateContractIntegrity) ───── */}
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
              {!data.contracts.success ? (
                <ActionRefusal label="Contract integrity validation" error={data.contracts.error} />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {data.contracts.data.valid} route(s) pass · {data.contracts.data.invalid} fail
                  </p>
                  {data.contracts.data.findings.length === 0 ? (
                    <div className="flex items-center gap-2 p-4 bg-green-50 rounded-lg border border-green-200">
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                      <p className="text-sm text-green-800">All contracts pass validation. No issues found.</p>
                    </div>
                  ) : (
                    data.contracts.data.findings.map((f, i) => (
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
                          {f.recommendation && (
                            <p className="text-xs text-muted-foreground">
                              Fix: {f.recommendation}
                            </p>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 6: Navigation Preview (actionNormalizeNavigationVisibility) ─ */}
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
                    disabled={isPending || routes.length === 0}
                  >
                    {type}
                  </Button>
                ))}
              </div>

              {navState === "refused" && (
                <ActionRefusal label="Navigation preview" error={navError} />
              )}

              {navState === "loaded" && (
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

              {navState === "idle" && (
                <p className="text-sm text-muted-foreground">
                  {routes.length === 0
                    ? "Route enumeration was refused, so there is nothing to preview."
                    : "Select a user type above to preview navigation visibility."}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
