"use client"

import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Phone, Mail, Calendar, Users } from "lucide-react"
import { cn } from "@/lib/utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface DealTeamMember {
  id: string
  member_type: string
  agent_id?: string | null
  external_name?: string | null
  external_company?: string | null
  external_phone?: string | null
  external_email?: string | null
  scheduled_date?: string | null
  // Joined from agents table when agent_id is present
  agent?: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    email: string | null
    profile_photo_url: string | null
  } | null
}

export interface PrimaryAgent {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  profile_photo_url: string | null
}

export interface DealTeamCardProps {
  primaryAgent: PrimaryAgent | null
  teamMembers: DealTeamMember[]
  variant?: "compact" | "full"
  className?: string
}

// ─── ROLE CONFIG ──────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<string, { label: string; color: string }> = {
  primary_agent: { label: "Your Agent", color: "bg-blue-100 text-blue-800" },
  transaction_coordinator: { label: "TC", color: "bg-purple-100 text-purple-800" },
  lender: { label: "Lender", color: "bg-green-100 text-green-800" },
  title: { label: "Title", color: "bg-amber-100 text-amber-800" },
  escrow: { label: "Escrow", color: "bg-amber-100 text-amber-800" },
  inspector: { label: "Inspector", color: "bg-rose-100 text-rose-800" },
  appraiser: { label: "Appraiser", color: "bg-indigo-100 text-indigo-800" },
  attorney: { label: "Attorney", color: "bg-slate-100 text-slate-800" },
}

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function getInitials(firstName?: string | null, lastName?: string | null, fullName?: string | null): string {
  if (firstName && lastName) {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
  }
  if (fullName) {
    const parts = fullName.trim().split(" ")
    if (parts.length >= 2) {
      return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase()
    }
    return fullName.charAt(0).toUpperCase()
  }
  return "?"
}

function formatPhone(phone: string | null | undefined): string {
  if (!phone) return ""
  const digits = phone.replace(/\D/g, "")
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return phone
}

// ─── TEAM MEMBER CARD ─────────────────────────────────────────────────────────

interface TeamMemberItemProps {
  name: string
  role: string
  company?: string | null
  phone?: string | null
  email?: string | null
  photoUrl?: string | null
  scheduledDate?: string | null
  variant: "compact" | "full"
}

function TeamMemberItem({
  name,
  role,
  company,
  phone,
  email,
  photoUrl,
  scheduledDate,
  variant,
}: TeamMemberItemProps) {
  const roleConfig = ROLE_CONFIG[role] || { label: role, color: "bg-gray-100 text-gray-800" }
  const initials = getInitials(null, null, name)

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 rounded-lg border bg-card",
        variant === "compact" ? "min-w-[200px]" : "w-full"
      )}
    >
      <Avatar className="h-10 w-10 shrink-0">
        {photoUrl && <AvatarImage src={photoUrl} alt={name} />}
        <AvatarFallback className="text-sm font-medium">{initials}</AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{name}</span>
          <Badge variant="secondary" className={cn("text-xs shrink-0", roleConfig.color)}>
            {roleConfig.label}
          </Badge>
        </div>

        {company && (
          <p className="text-xs text-muted-foreground truncate">{company}</p>
        )}

        {scheduledDate && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>
              {new Date(scheduledDate).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
        )}

        {variant === "full" && (phone || email) && (
          <div className="flex items-center gap-2 pt-1">
            {phone && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                asChild
              >
                <a href={`tel:${phone}`}>
                  <Phone className="h-3 w-3 mr-1" />
                  {formatPhone(phone)}
                </a>
              </Button>
            )}
            {email && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                asChild
              >
                <a href={`mailto:${email}`}>
                  <Mail className="h-3 w-3 mr-1" />
                  Email
                </a>
              </Button>
            )}
          </div>
        )}

        {variant === "compact" && (phone || email) && (
          <div className="flex items-center gap-1 pt-1">
            {phone && (
              <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                <a href={`tel:${phone}`} aria-label={`Call ${name}`}>
                  <Phone className="h-3.5 w-3.5" />
                </a>
              </Button>
            )}
            {email && (
              <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                <a href={`mailto:${email}`} aria-label={`Email ${name}`}>
                  <Mail className="h-3.5 w-3.5" />
                </a>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function DealTeamCard({
  primaryAgent,
  teamMembers,
  variant = "compact",
  className,
}: DealTeamCardProps) {
  // Build display list
  const displayMembers: TeamMemberItemProps[] = []

  // Add primary agent first
  if (primaryAgent) {
    const agentName = [primaryAgent.first_name, primaryAgent.last_name]
      .filter(Boolean)
      .join(" ") || "Your Agent"

    displayMembers.push({
      name: agentName,
      role: "primary_agent",
      phone: primaryAgent.phone,
      email: primaryAgent.email,
      photoUrl: primaryAgent.profile_photo_url,
      variant,
    })
  }

  // Add other team members
  for (const member of teamMembers) {
    // Skip if this is the primary agent (already added)
    if (member.agent_id && member.agent_id === primaryAgent?.id) continue

    let name: string
    let phone: string | null = null
    let email: string | null = null
    let photoUrl: string | null = null

    if (member.agent) {
      // Internal agent
      name = [member.agent.first_name, member.agent.last_name]
        .filter(Boolean)
        .join(" ") || "Team Member"
      phone = member.agent.phone
      email = member.agent.email
      photoUrl = member.agent.profile_photo_url
    } else {
      // External contact
      name = member.external_name || "Team Member"
      phone = member.external_phone ?? null
      email = member.external_email ?? null
    }

    displayMembers.push({
      name,
      role: member.member_type,
      company: member.external_company,
      phone,
      email,
      photoUrl,
      scheduledDate: member.scheduled_date,
      variant,
    })
  }

  // Empty state
  if (displayMembers.length === 0) {
    return (
      <Card className={className}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            Your Deal Team
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            Your deal team will be assigned soon
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4" />
          Your Deal Team
        </CardTitle>
      </CardHeader>
      <CardContent>
        {variant === "compact" ? (
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
            {displayMembers.map((member, i) => (
              <TeamMemberItem key={i} {...member} />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {displayMembers.map((member, i) => (
              <TeamMemberItem key={i} {...member} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default DealTeamCard
