"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChevronRight, Star } from "lucide-react"
import Link from "next/link"
import { getPersonaConfig } from "@/lib/portal"
import { cn } from "@/lib/utils"

interface PersonaFeatureCardsProps {
  contactId: string
  persona: string
}

// Feature to route mapping
const featureRoutes: Record<string, string> = {
  "Journey Guide": "journey",
  "Mortgage Calculator": "properties",
  "Homebuying Checklist": "journey",
  "Down Payment Tracker": "journey",
  "VA Loan Calculator": "properties",
  "BAH Comparison": "properties",
  "Base Proximity Search": "properties",
  "PCS Timeline": "journey",
  "Private Listings": "properties",
  "Concierge Services": "journey",
  "Investment Analysis": "insights",
  "Privacy Protection": "settings",
  "ROI Calculator": "insights",
  "Deal Analysis": "properties",
  "Portfolio Tracker": "properties",
  "Market Intelligence": "insights",
  "Selling Timeline": "journey",
  "Home Prep Guide": "journey",
  "Pricing Strategy": "listing",
  "Offer Comparison": "offers",
  "Quick Sale Options": "listing",
  "Daily Updates": "documents",
  "Instant Offers": "offers",
  "Expedited Timeline": "journey",
  "Neutral Communication": "documents",
  "Equity Calculator": "listing",
  "Confidential Process": "documents",
  "Mediator Network": "journey",
  "Probate Timeline": "journey",
  "Estate Resources": "documents",
  "Court Requirements": "journey",
  "Compassionate Support": "journey",
  "Memory Video": "journey",
  "Senior Move Managers": "journey",
  "Downsizing Support": "journey",
  "Estate Coordination": "documents",
  "Area Comparison": "properties",
  "Moving Checklist": "journey",
  "School Districts": "properties",
  "Cost of Living": "properties",
  "Global Marketing": "listing",
  "Private Showings": "showings",
  "Luxury Network": "listing",
  "Net Proceeds Comparison": "listing",
  "MLS Exposure": "listing",
  "Professional Marketing": "listing",
  "Contract Support": "documents",
  "Market Analysis": "listing",
  "New Strategy": "listing",
  "Enhanced Marketing": "listing",
  "Pricing Optimization": "listing",
  "Coordinated Buy/Sell": "journey",
  "Space Comparison": "properties",
  "Family Amenities": "properties",
  "Right-Sized Homes": "properties",
  "Storage Solutions": "journey",
  "Lifestyle Options": "properties",
  "Virtual Updates": "documents",
  "Digital Signing": "documents",
  "Property Monitoring": "listing",
  "Video Tours": "listing",
}

export default function PersonaFeatureCards({ contactId, persona }: PersonaFeatureCardsProps) {
  const config = getPersonaConfig(persona)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Star className={cn("w-5 h-5", config.color)} />
          Your Personalized Tools
        </CardTitle>
        <p className="text-sm text-muted-foreground">Features tailored for your {config.label} journey</p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
          {config.features.map((feature, idx) => {
            const route = featureRoutes[feature] || "journey"
            return (
              <Button
                key={idx}
                variant="outline"
                className={cn("h-auto py-3 px-4 justify-start gap-2", config.borderColor, "hover:bg-accent")}
                asChild
              >
                <Link href={`/portal/${contactId}/${route}`}>
                  <Badge variant="secondary" className={cn("w-2 h-2 p-0 rounded-full", config.bgColor)} />
                  <span className="text-sm">{feature}</span>
                  <ChevronRight className="w-4 h-4 ml-auto text-muted-foreground" />
                </Link>
              </Button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
