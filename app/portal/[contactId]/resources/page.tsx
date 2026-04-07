import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView } from "@/lib/kernel/portal"
import { getVendorResources } from "@/app/actions/portal-lifetime"
import { getCalculatorHistory } from "@/app/actions/calculators"
import { PortalFinancialTools } from "./portal-financial-tools"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  ArrowLeft,
  Star,
  Phone,
  Globe,
  Mail,
  Search,
  Wrench,
  Zap,
  Droplets,
  Leaf,
  Paintbrush,
  HardHat,
  CheckCircle2,
  ExternalLink,
} from "lucide-react"

const CATEGORY_ICONS: Record<string, any> = {
  plumber: Droplets,
  electrician: Zap,
  hvac: Wrench,
  landscaping: Leaf,
  painter: Paintbrush,
  contractor: HardHat,
  default: Wrench,
}

const MAINTENANCE_CHECKLIST = [
  {
    season: "Spring",
    tasks: [
      "Check and clean gutters",
      "Inspect roof for winter damage",
      "Service HVAC system",
      "Test smoke and CO detectors",
      "Check exterior paint and caulking",
    ],
  },
  {
    season: "Summer",
    tasks: [
      "Clean and inspect deck/patio",
      "Check sprinkler system",
      "Trim trees and shrubs",
      "Clean dryer vents",
      "Inspect window screens",
    ],
  },
  {
    season: "Fall",
    tasks: [
      "Clean gutters before winter",
      "Service furnace and heating system",
      "Seal gaps around windows and doors",
      "Drain outdoor faucets",
      "Check weather stripping",
    ],
  },
  {
    season: "Winter",
    tasks: [
      "Check insulation in attic",
      "Test sump pump",
      "Inspect pipes for freezing risk",
      "Clean range hood filters",
      "Check fire extinguisher",
    ],
  },
]

const USEFUL_LINKS = [
  { label: "USPS Change of Address", url: "https://moversguide.usps.com" },
  { label: "Utility Setup Guide", url: "#" },
  { label: "Homeowner Insurance Tips", url: "#" },
  { label: "Property Tax Information", url: "#" },
]

export default async function ResourcesPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify lifetime portal access
  const portalView = await determinePortalView(supabase, contactId)
  if (portalView !== "lifetime") {
    redirect(`/portal/${contactId}`)
  }

  // contactId is the authoritative identity — getCalculatorHistory takes it as leadId
  // because the action parameter predates the portal contact model
  const [vendors, calcHistory] = await Promise.all([
    getVendorResources(contactId),
    getCalculatorHistory(contactId),
  ])

  // Group vendors by category
  const vendorsByCategory = vendors.reduce((acc: Record<string, any[]>, v: any) => {
    const category = v.category?.toLowerCase() || "other"
    if (!acc[category]) acc[category] = []
    acc[category].push(v)
    return acc
  }, {})

  const categories = Object.keys(vendorsByCategory).sort()

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Portal
          </Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">Homeowner Resources</h1>
        <p className="text-muted-foreground">
          Trusted vendors and maintenance guides for your home
        </p>
      </div>

      {/* Vendor Directory */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-orange-600" />
            <CardTitle>Preferred Vendors</CardTitle>
          </div>
          <CardDescription>
            Trusted service providers recommended by your agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {categories.length > 0 ? (
            <div className="space-y-6">
              {categories.map((category) => {
                const CategoryIcon = CATEGORY_ICONS[category] || CATEGORY_ICONS.default
                return (
                  <div key={category}>
                    <div className="flex items-center gap-2 mb-3">
                      <CategoryIcon className="h-5 w-5 text-muted-foreground" />
                      <h3 className="font-semibold capitalize">{category}</h3>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {vendorsByCategory[category].map((v: any) => (
                        <div
                          key={v.id}
                          className="p-4 rounded-lg border hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <p className="font-medium">{v.vendors?.business_name}</p>
                                {v.is_featured && (
                                  <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                                )}
                                {v.vendors?.is_verified && (
                                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {v.vendors?.vendor_type}
                              </p>
                            </div>
                            {v.vendors?.rating_avg && (
                              <Badge variant="secondary" className="text-xs">
                                <Star className="h-3 w-3 mr-1 text-yellow-500 fill-yellow-500" />
                                {v.vendors.rating_avg.toFixed(1)}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {v.vendors?.phone && (
                              <Button variant="outline" size="sm" asChild>
                                <a href={`tel:${v.vendors.phone}`}>
                                  <Phone className="h-3 w-3 mr-1" />
                                  {v.vendors.phone}
                                </a>
                              </Button>
                            )}
                            {v.vendors?.email && (
                              <Button variant="outline" size="sm" asChild>
                                <a href={`mailto:${v.vendors.email}`}>
                                  <Mail className="h-3 w-3 mr-1" />
                                  Email
                                </a>
                              </Button>
                            )}
                            {v.vendors?.website_url && (
                              <Button variant="outline" size="sm" asChild>
                                <a
                                  href={v.vendors.website_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Globe className="h-3 w-3 mr-1" />
                                  Website
                                </a>
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-8">
              <Wrench className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">
                No vendor recommendations available yet.
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Ask your agent for trusted service provider recommendations.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Maintenance Checklist */}
      <Card>
        <CardHeader>
          <CardTitle>Seasonal Maintenance Checklist</CardTitle>
          <CardDescription>
            Keep your home in top shape year-round
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {MAINTENANCE_CHECKLIST.map((season) => (
              <div key={season.season} className="p-4 rounded-lg bg-muted/50">
                <h4 className="font-semibold mb-3">{season.season}</h4>
                <ul className="space-y-2">
                  {season.tasks.map((task, index) => (
                    <li key={index} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                      <span>{task}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Financial Tools — Moving Cost Estimator + Calculator History */}
      <PortalFinancialTools contactId={contactId} calcHistory={calcHistory} />

      {/* Useful Links */}
      <Card>
        <CardHeader>
          <CardTitle>Useful Links</CardTitle>
          <CardDescription>
            Helpful resources for homeowners
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {USEFUL_LINKS.map((link, index) => (
              <a
                key={index}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <span className="font-medium">{link.label}</span>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
