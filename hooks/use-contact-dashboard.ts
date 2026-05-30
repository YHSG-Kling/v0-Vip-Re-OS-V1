"use client"

import useSWR from "swr"
import { useAuth } from "@/lib/auth/client"
import { getContactDetails } from "@/app/actions/contact-details"
import { getTransactions } from "@/app/actions/transactions"
import { getShowings } from "@/app/actions/showings"
import { getEducationResources, getRecommendedProperties, getJourneyMilestones, getContactAgent } from "@/app/actions/ai-client-portal"

export interface AgentInfo {
  id: string
  name: string
  phone: string
  email: string
  photo?: string
  specializations?: string[]
  yearsExperience?: number
  avgDaysToSell?: number
  transactionsClosed?: number
}

export interface PropertyInfo {
  id: string
  address: string
  estimatedValue: number
  suggestedPrice: number
  condition?: string
  photos?: string[]
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
}

export interface Milestone {
  id: string
  title: string
  status: "complete" | "in-progress" | "upcoming"
  date: string
  description?: string
}

export interface Showing {
  id: string
  property: string
  date: string
  time: string
  status: string
}

export interface EducationResource {
  id: string
  title: string
  type: string
  duration: string
  completed: boolean
  url?: string
}

export function useContactDashboard(personaType?: string) {
  const { user } = useAuth()
  const contactId = user?.id

  // Fetch contact data
  const { data: contactData, isLoading: contactLoading, error: contactError } = useSWR(
    contactId ? `contact-${contactId}` : null,
    async () => {
      if (!contactId) return null
      const result = await getContactDetails(contactId)
      return (result as any).success ? (result as any).contact : null
    }
  )

  // Fetch agent info
  const { data: agentData, isLoading: agentLoading } = useSWR(
    contactId ? `contact-agent-${contactId}` : null,
    async () => {
      if (!contactId) return null
      const result = await getContactAgent({ contactId })
      return result.success ? result.agent : null
    }
  )

  // Fetch transactions for this contact
  const { data: transactionsData, isLoading: txLoading } = useSWR(
    contactId ? `contact-transactions-${contactId}` : null,
    async () => {
      if (!contactId) return []
      const result = await getTransactions({ contactId } as any)
      return (result as any).success ? (result as any).transactions : []
    }
  )

  // Fetch showings for this contact
  const { data: showingsData, isLoading: showingsLoading } = useSWR(
    contactId ? `contact-showings-${contactId}` : null,
    async () => {
      if (!contactId) return []
      const result = await getShowings(contactId)
      return Array.isArray(result) ? result : ((result as any).success ? (result as any).showings : [])
    }
  )

  // Fetch education resources
  const { data: resourcesData } = useSWR(
    contactId && personaType ? `education-${contactId}-${personaType}` : null,
    async () => {
      if (!contactId) return []
      const result = await getEducationResources({ contactId, personaType })
      return result.success ? result.resources : []
    }
  )

  // Fetch recommended properties
  const { data: propertiesData } = useSWR(
    contactId ? `recommended-properties-${contactId}` : null,
    async () => {
      if (!contactId) return []
      const result = await getRecommendedProperties({ contactId })
      return result.success ? result.properties : []
    }
  )

  // Fetch journey milestones
  const activeTransaction = transactionsData?.[0]
  const { data: milestonesData } = useSWR(
    contactId && activeTransaction?.id ? `milestones-${activeTransaction.id}` : null,
    async () => {
      if (!contactId || !activeTransaction?.id) return []
      const result = await getJourneyMilestones({ contactId, transactionId: activeTransaction.id })
      return result.success ? result.milestones : []
    }
  )

  // Map agent info
  const agentRecord = Array.isArray(agentData) ? agentData[0] : agentData
  const agentInfo: AgentInfo | null = agentRecord ? {
    id: (agentRecord as any).id,
    name: (agentRecord as any).full_name || "Your Agent",
    phone: (agentRecord as any).phone || "",
    email: (agentRecord as any).email || "",
    photo: (agentRecord as any).photo_url || "/placeholder.svg",
    specializations: (agentRecord as any).specializations || [],
    yearsExperience: (agentRecord as any).years_experience || 0,
    avgDaysToSell: (agentRecord as any).avg_days_to_sell || 0,
    transactionsClosed: (agentRecord as any).transactions_closed || 0,
  } : null

  // Map property info from active transaction/listing
  const propertyInfo: PropertyInfo | null = activeTransaction ? {
    id: activeTransaction.id,
    address: activeTransaction.listings?.address || activeTransaction.property_address || "Your Property",
    estimatedValue: activeTransaction.listings?.list_price || 0,
    suggestedPrice: activeTransaction.sale_price || activeTransaction.listings?.list_price || 0,
    condition: activeTransaction.listings?.condition || "Good",
    photos: activeTransaction.listings?.photos || [],
    bedrooms: activeTransaction.listings?.bedrooms,
    bathrooms: activeTransaction.listings?.bathrooms,
    squareFeet: activeTransaction.listings?.square_feet,
  } : null

  // Map milestones
  const milestones: Milestone[] = (milestonesData || []).map((m: any) => ({
    id: m.id,
    title: m.title || m.milestone_name || "Milestone",
    status: m.completed_at ? "complete" : m.started_at ? "in-progress" : "upcoming",
    date: m.due_date ? new Date(m.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "TBD",
    description: m.description,
  }))

  // Map showings
  const upcomingShowings: Showing[] = (showingsData || []).map((s: any) => ({
    id: s.id,
    property: s.listings?.address || propertyInfo?.address || "Property",
    date: s.showing_date ? new Date(s.showing_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "TBD",
    time: s.showing_time || "TBD",
    status: s.status || "pending",
  }))

  // Map education resources
  const educationResources: EducationResource[] = (resourcesData || []).map((r: any) => ({
    id: r.id,
    title: r.title,
    type: r.resource_type || "guide",
    duration: r.duration || "5 min",
    completed: r.completed || false,
    url: r.url,
  }))

  // Map recommended properties
  const recommendedProperties = (propertiesData || []).map((p: any) => ({
    id: p.id,
    address: p.address || "Unknown Address",
    price: p.list_price || 0,
    beds: p.bedrooms || 0,
    baths: p.bathrooms || 0,
    sqft: p.square_feet || 0,
    photo: p.photos?.[0] || p.primary_photo || "/placeholder.svg",
    status: p.status || "active",
    daysOnMarket: p.days_on_market || 0,
  }))

  // Calculate days remaining to closing
  const daysRemaining = activeTransaction?.closing_date 
    ? Math.max(0, Math.floor((new Date(activeTransaction.closing_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null

  const isLoading = contactLoading || agentLoading || txLoading || showingsLoading

  return {
    // Core data
    contactId,
    contact: contactData,
    agentInfo,
    propertyInfo,
    activeTransaction,
    
    // Journey data
    milestones,
    daysRemaining,
    timeline: contactData?.timeline || "3-6 months",
    
    // Activity data
    upcomingShowings,
    educationResources,
    recommendedProperties,
    
    // Status
    isLoading,
    error: contactError,
  }
}
