import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: Request) {
  // Auth guard — agentId always from session, never from body
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { brokerageId, agentId } = { brokerageId: auth.brokerageId, agentId: auth.agentId }

  try {
    // contactId / leadId identify which entity to generate suggestions for;
    // they do NOT override the caller's identity.
    const { contactId, leadId } = await request.json()

    let contact = null
    if (contactId) {
      const { data } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", contactId)
        .eq("brokerage_id", brokerageId)  // brokerage isolation
        .maybeSingle()
      contact = data
    } else if (leadId) {
      const { data } = await supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .eq("brokerage_id", brokerageId)  // brokerage isolation
        .maybeSingle()
      contact = data
    }

    if (!contact) {
      return Response.json({ success: false, error: "Contact not found" }, { status: 404 })
    }

    const suggestions = generateContentSuggestions(contact)
    return Response.json({ success: true, suggestions })
  } catch (error: any) {
    console.error("Content suggestions error:", error)
    return Response.json({ success: false, error: error.message }, { status: 500 })
  }
}

function generateContentSuggestions(contact: any) {
  const suggestions: any[] = []
  const stage = contact.lifecycle_stage || contact.stage || "awareness"
  const buyerType = contact.buyer_type || "general"
  const priceRange = contact.price_range || ""

  if (stage === "awareness" || stage === "new") {
    suggestions.push({
      type: "email",
      title: "Welcome & Introduction Email",
      description: "Introduce yourself and your services to the new contact",
      priority: "high",
      estimatedTime: "2-3 min",
      template: "welcome_email",
    })
    suggestions.push({
      type: "social_post",
      platform: "instagram",
      title: "Market Update Post",
      description: `Share recent market trends in ${contact.preferred_locations?.[0] || "their area"}`,
      priority: "medium",
      estimatedTime: "5 min",
    })
  }

  if (stage === "consideration" || stage === "engaged") {
    suggestions.push({
      type: "email",
      title: "Personalized Property Recommendations",
      description: `Send curated listings matching their criteria (${buyerType}, ${priceRange})`,
      priority: "high",
      estimatedTime: "10 min",
      template: "property_recommendations",
    })
    suggestions.push({
      type: "video",
      title: "Neighborhood Tour Video",
      description: `Create a video tour of ${contact.preferred_locations?.[0] || "popular neighborhoods"}`,
      priority: "medium",
      estimatedTime: "15 min",
    })
    suggestions.push({
      type: "blog_post",
      title: "Buyer's Guide Blog Post",
      description: `Write a guide specifically for ${buyerType} buyers`,
      priority: "medium",
      estimatedTime: "20 min",
    })
  }

  if (stage === "decision" || stage === "hot") {
    suggestions.push({
      type: "email",
      title: "Urgency Email - New Listing Alert",
      description: "Alert them about a new listing that matches their criteria",
      priority: "urgent",
      estimatedTime: "5 min",
      template: "new_listing_alert",
    })
    suggestions.push({
      type: "social_post",
      platform: "instagram",
      title: "Just Listed Post",
      description: "Showcase the property with professional photos",
      priority: "high",
      estimatedTime: "5 min",
    })
    suggestions.push({
      type: "video",
      title: "Property Walkthrough Video",
      description: "Create a detailed video tour of the property",
      priority: "high",
      estimatedTime: "15 min",
    })
  }

  if (stage === "under_contract" || stage === "transaction") {
    suggestions.push({
      type: "email",
      title: "Transaction Milestone Update",
      description: "Keep them informed about the transaction progress",
      priority: "high",
      estimatedTime: "5 min",
      template: "transaction_update",
    })
    suggestions.push({
      type: "email",
      title: "Inspection Preparation Guide",
      description: "Send tips for the upcoming inspection",
      priority: "medium",
      estimatedTime: "3 min",
    })
  }

  if (stage === "closed" || stage === "past_client") {
    suggestions.push({
      type: "email",
      title: "Congratulations & Follow-up",
      description: "Celebrate their closing and request a review",
      priority: "high",
      estimatedTime: "5 min",
      template: "closing_congratulations",
    })
    suggestions.push({
      type: "social_post",
      platform: "facebook",
      title: "Success Story Post",
      description: "Share their success story (with permission)",
      priority: "medium",
      estimatedTime: "5 min",
    })
    suggestions.push({
      type: "email",
      title: "Home Anniversary Check-in",
      description: "Check in on their one-year home anniversary",
      priority: "low",
      estimatedTime: "3 min",
      template: "anniversary_checkin",
    })
  }

  if (buyerType === "military" || buyerType === "veteran") {
    suggestions.push({
      type: "blog_post",
      title: "VA Loan Benefits Guide",
      description: "Write about VA loan benefits and the home buying process for military",
      priority: "medium",
      estimatedTime: "25 min",
    })
  }

  if (buyerType === "first_time_buyer") {
    suggestions.push({
      type: "email",
      title: "First-Time Buyer Checklist",
      description: "Send a comprehensive checklist for first-time homebuyers",
      priority: "medium",
      estimatedTime: "5 min",
      template: "first_time_buyer_checklist",
    })
    suggestions.push({
      type: "video",
      title: "Home Buying Process Explained",
      description: "Create an educational video explaining the buying process step-by-step",
      priority: "medium",
      estimatedTime: "10 min",
    })
  }

  if (buyerType === "luxury" || (priceRange && priceRange.includes("$1M+"))) {
    suggestions.push({
      type: "email",
      title: "Luxury Market Report",
      description: "Share insights on the luxury real estate market",
      priority: "medium",
      estimatedTime: "10 min",
    })
  }

  if (buyerType === "investor") {
    suggestions.push({
      type: "blog_post",
      title: "Investment Property ROI Analysis",
      description: "Write about ROI considerations for investment properties",
      priority: "medium",
      estimatedTime: "25 min",
    })
    suggestions.push({
      type: "email",
      title: "Investment Opportunity Alert",
      description: "Share a property with strong investment potential",
      priority: "high",
      estimatedTime: "5 min",
    })
  }

  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
  return suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
}
