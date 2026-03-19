"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Palette,
  Image,
  Mail,
  FileText,
  ExternalLink 
} from "lucide-react"

interface BrandingSettings {
  logoUrl?: string | null
  primaryColor?: string | null
  accentColor?: string | null
  tagline?: string | null
  emailSignatureHtml?: string | null
  letterheadHtml?: string | null
  wizardCompleted: boolean
}

interface BrandingOutputPanelProps {
  branding: BrandingSettings
}

export function BrandingOutputPanel({ branding }: BrandingOutputPanelProps) {
  const hasLogo = !!branding.logoUrl
  const hasColors = !!branding.primaryColor
  const hasEmailSignature = !!branding.emailSignatureHtml
  const hasLetterhead = !!branding.letterheadHtml
  
  const completedItems = [hasLogo, hasColors, hasEmailSignature, hasLetterhead].filter(Boolean).length
  const totalItems = 4
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Branding Assets
          </CardTitle>
          <Link href="/settings/branding">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              Edit <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Brand Preview */}
        {branding.primaryColor && (
          <div className="flex items-center gap-3">
            <div 
              className="w-8 h-8 rounded-md border"
              style={{ backgroundColor: branding.primaryColor }}
            />
            {branding.accentColor && (
              <div 
                className="w-8 h-8 rounded-md border"
                style={{ backgroundColor: branding.accentColor }}
              />
            )}
            <span className="text-sm text-muted-foreground">Brand Colors</span>
          </div>
        )}

        {/* Asset Checklist */}
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Image className={`h-4 w-4 ${hasLogo ? "text-green-500" : "text-muted-foreground"}`} />
              <span className="text-sm">Logo</span>
            </div>
            <Badge variant={hasLogo ? "default" : "secondary"} className="text-xs">
              {hasLogo ? "Set" : "Missing"}
            </Badge>
          </div>
          
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Mail className={`h-4 w-4 ${hasEmailSignature ? "text-green-500" : "text-muted-foreground"}`} />
              <span className="text-sm">Email Signature</span>
            </div>
            <Badge variant={hasEmailSignature ? "default" : "secondary"} className="text-xs">
              {hasEmailSignature ? "Set" : "Missing"}
            </Badge>
          </div>
          
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <FileText className={`h-4 w-4 ${hasLetterhead ? "text-green-500" : "text-muted-foreground"}`} />
              <span className="text-sm">Letterhead</span>
            </div>
            <Badge variant={hasLetterhead ? "default" : "secondary"} className="text-xs">
              {hasLetterhead ? "Set" : "Missing"}
            </Badge>
          </div>
        </div>

        {/* Status */}
        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            {completedItems} of {totalItems} branding assets configured
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
