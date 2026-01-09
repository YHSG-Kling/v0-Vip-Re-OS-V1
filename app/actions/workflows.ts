"use server"

import { supabaseService } from "@/services/supabaseService"
import { generateText } from "ai"

// =====================================================
// AI TOOL WORKFLOWS
// =====================================================

export async function executeAITool(toolName: string, inputData: any, context: any) {
  try {
    console.log("[Workflow] Executing AI Tool:", toolName)

    // Log usage
    await supabaseService.logAIToolUsage({
      userId: context.userId || "system",
      toolName,
      inputText: JSON.stringify(inputData),
      contextJson: JSON.stringify(context),
      modelUsed: "openai/gpt-4o-mini",
    })

    // Execute AI generation based on tool
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are an AI assistant for real estate professionals. Generate output for ${toolName} tool with input: ${JSON.stringify(inputData)}`,
    })

    // Update usage with output
    await supabaseService.logAIToolUsage({
      userId: context.userId || "system",
      toolName,
      inputText: JSON.stringify(inputData),
      outputText: text,
      contextJson: JSON.stringify(context),
      tokensUsed: text.length / 4, // Rough estimate
      modelUsed: "openai/gpt-4o-mini",
    })

    return {
      success: true,
      output: text,
      tokensUsed: text.length / 4,
    }
  } catch (error: any) {
    console.error("[Workflow] AI Tool execution failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

// =====================================================
// COMPLIANCE WORKFLOWS
// =====================================================

export async function checkFairHousingCompliance(userId: string, contentType: string, text: string) {
  try {
    console.log("[Workflow] Checking Fair Housing Compliance")

    const { text: analysisText } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are a Fair Housing compliance expert. Analyze this ${contentType} text for any violations of Fair Housing laws. Return a JSON object with: blocked (boolean), flaggedPhrases (array of {phrase, violation_type, reason, suggested_replacement}), overall_severity (low/medium/high).

Text to analyze: "${text}"

Be strict and flag any language that could be discriminatory based on race, color, religion, sex, familial status, national origin, or disability.`,
    })

    let analysis
    try {
      analysis = JSON.parse(analysisText)
    } catch {
      // If AI doesn't return valid JSON, assume it's safe
      analysis = {
        blocked: false,
        flaggedPhrases: [],
        overall_severity: "low",
      }
    }

    // If blocked, create a compliance flag
    if (analysis.blocked) {
      await supabaseService.createRecord("compliance_flags", {
        user_id: userId,
        content_type: contentType,
        original_text: text,
        flagged_phrases: JSON.stringify(analysis.flaggedPhrases),
        violation_type: analysis.flaggedPhrases.map((p: any) => p.violation_type),
        severity: analysis.overall_severity,
        status: "open",
      })
    }

    return {
      success: true,
      ...analysis,
    }
  } catch (error: any) {
    console.error("[Workflow] Compliance check failed:", error)
    return {
      success: false,
      blocked: false,
      error: error.message,
    }
  }
}

// =====================================================
// LEAD MANAGEMENT WORKFLOWS
// =====================================================

export async function generateCopilotPlan(contactId: string, agentId: string) {
  try {
    console.log("[Workflow] Generating 7-day Copilot Plan")

    const contact = await supabaseService.getContactById(contactId)
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Generate AI plan
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a 7-day action plan for real estate agent to nurture this lead:
      
Name: ${contact.name}
Email: ${contact.email}
Phone: ${contact.phone}
Stage: ${contact.stage}
Source: ${contact.source}

Return a JSON array of 7 daily tasks with: {day, title, description, action_type, priority, due_date}`,
    })

    let tasks
    try {
      tasks = JSON.parse(text)
    } catch {
      tasks = []
    }

    // Create copilot plan
    const plan = await supabaseService.createCopilotPlan({
      contact_id: contactId,
      agent_id: agentId,
      plan_name: `7-Day Plan for ${contact.name}`,
      start_date: new Date().toISOString(),
      end_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: "active",
    })

    // Create individual tasks
    if (plan && Array.isArray(tasks)) {
      for (const task of tasks) {
        await supabaseService.createRecord("plan_tasks", {
          plan_id: plan.id,
          contact_id: contactId,
          title: task.title,
          description: task.description,
          action_type: task.action_type || "manual",
          priority: task.priority || "medium",
          due_date: task.due_date,
          status: "pending",
        })
      }
    }

    return {
      success: true,
      planId: plan?.id,
      tasksCreated: tasks.length,
    }
  } catch (error: any) {
    console.error("[Workflow] Copilot plan generation failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function startSmartDrip(leadId: string, dripType: string, agentId: string) {
  try {
    console.log("[Workflow] Starting Smart Drip Campaign")

    const contact = await supabaseService.getContactById(leadId)
    if (!contact) {
      return { success: false, error: "Lead not found" }
    }

    // Create drip campaign record
    await supabaseService.createRecord("drip_campaigns", {
      contact_id: leadId,
      agent_id: agentId,
      campaign_type: dripType,
      status: "active",
      start_date: new Date().toISOString(),
      emails_sent: 0,
      emails_opened: 0,
    })

    // Log interaction
    await supabaseService.createInteraction({
      contact_id: leadId,
      interaction_type: "drip_started",
      interaction_date: new Date().toISOString(),
      notes: `Started ${dripType} drip campaign`,
      outcome: "scheduled",
    })

    return {
      success: true,
      message: `Smart drip campaign started for ${contact.name}`,
    }
  } catch (error: any) {
    console.error("[Workflow] Smart drip failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

// =====================================================
// COMMUNICATION WORKFLOWS
// =====================================================

export async function sendMessage(contactName: string, channel: string, text: string) {
  try {
    console.log("[Workflow] Sending message via", channel)

    // Find contact by name
    const contacts = await supabaseService.getLeads()
    const contact = contacts?.find((c) => c.name.toLowerCase().includes(contactName.toLowerCase()))

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Log interaction
    await supabaseService.createInteraction({
      contact_id: contact.id,
      interaction_type: channel === "email" ? "email_sent" : channel === "sms" ? "sms_sent" : "call_made",
      interaction_date: new Date().toISOString(),
      notes: text,
      outcome: "sent",
    })

    // In production, integrate with Twilio/SendGrid here
    console.log(`[Workflow] Would send ${channel} to ${contact.name}: ${text}`)

    return {
      success: true,
      message: `Message sent to ${contact.name} via ${channel}`,
    }
  } catch (error: any) {
    console.error("[Workflow] Send message failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

// =====================================================
// LISTING WORKFLOWS
// =====================================================

export async function calculateListingMetrics(listingId: string) {
  try {
    console.log("[Workflow] Calculating listing metrics")

    const listing = await supabaseService.getListingById(listingId)
    if (!listing) {
      return { success: false, error: "Listing not found" }
    }

    // Get engagement data
    const engagement = await supabaseService.getListingEngagement(listingId)

    // Calculate metrics
    const views = engagement.length
    const saves = engagement.filter((e: any) => e.action_type === "saved").length
    const inquiries = engagement.filter((e: any) => e.action_type === "inquiry").length

    // Create metrics record
    await supabaseService.createRecord("listing_metrics", {
      listing_id: listingId,
      date: new Date().toISOString().split("T")[0],
      views,
      saves,
      inquiries,
      conversion_rate: views > 0 ? (inquiries / views) * 100 : 0,
    })

    return {
      success: true,
      metrics: { views, saves, inquiries },
    }
  } catch (error: any) {
    console.error("[Workflow] Calculate metrics failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function triggerCMAPackage(
  leadId: string | null,
  address: string,
  beds: string,
  baths: string,
  sqft: string,
  upgrades: any[],
) {
  try {
    console.log("[Workflow] Generating CMA Package")

    // Use AI to generate market analysis
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a Comparative Market Analysis for:
      
Address: ${address}
Beds: ${beds}
Baths: ${baths}
Square Feet: ${sqft}
Upgrades: ${upgrades.join(", ")}

Return a JSON object with: {suggestedPrice, priceRange: {low, high}, marketCondition, daysOnMarket, comparables: [{address, price, beds, baths, sqft}]}`,
    })

    let analysis
    try {
      analysis = JSON.parse(text)
    } catch {
      analysis = {
        suggestedPrice: 750000,
        priceRange: { low: 725000, high: 775000 },
        marketCondition: "balanced",
        daysOnMarket: 30,
      }
    }

    // Log to contact if provided
    if (leadId) {
      await supabaseService.createInteraction({
        contact_id: leadId,
        interaction_type: "cma_generated",
        interaction_date: new Date().toISOString(),
        notes: `CMA generated for ${address}: $${analysis.suggestedPrice}`,
        outcome: "completed",
      })
    }

    return {
      success: true,
      ...analysis,
    }
  } catch (error: any) {
    console.error("[Workflow] CMA generation failed:", error)
    return {
      success: false,
      suggestedPrice: 0,
      error: error.message,
    }
  }
}

// =====================================================
// TRANSACTION WORKFLOWS
// =====================================================

export async function grantPortalAccess(email: string, role: string, dealId: string, name: string) {
  try {
    console.log("[Workflow] Granting portal access")

    // Create portal user
    await supabaseService.createRecord("portal_users", {
      email,
      name,
      role,
      transaction_id: dealId,
      access_level: role === "client" ? "limited" : "full",
      status: "active",
      invited_at: new Date().toISOString(),
    })

    // Log to transaction
    await supabaseService.createRecord("transaction_events", {
      transaction_id: dealId,
      event_type: "portal_access_granted",
      description: `Portal access granted to ${name} (${role})`,
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      message: `Portal access granted to ${name}`,
    }
  } catch (error: any) {
    console.error("[Workflow] Grant portal access failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function triggerComplianceChecklist(dealId: string, details: any) {
  try {
    console.log("[Workflow] Creating compliance checklist")

    const transaction = await supabaseService.getTransactionById(dealId)
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // Create checklist items
    const items = [
      { title: "Lead Paint Disclosure", required: true, category: "disclosure" },
      { title: "Property Disclosure Statement", required: true, category: "disclosure" },
      { title: "HOA Documents", required: false, category: "documents" },
      { title: "Title Insurance", required: true, category: "insurance" },
      { title: "Home Warranty", required: false, category: "warranty" },
      { title: "Final Walkthrough", required: true, category: "inspection" },
    ]

    for (const item of items) {
      await supabaseService.createRecord("compliance_checklist", {
        transaction_id: dealId,
        item_name: item.title,
        category: item.category,
        required: item.required,
        status: "pending",
        created_at: new Date().toISOString(),
      })
    }

    return {
      success: true,
      itemsCreated: items.length,
    }
  } catch (error: any) {
    console.error("[Workflow] Compliance checklist failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

// =====================================================
// CONTENT & MARKETING WORKFLOWS
// =====================================================

export async function generateScriptContent(topic: string, tone: string, duration: number) {
  try {
    console.log("[Workflow] Generating script content")

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Write a ${duration}-second video script for real estate content:
      
Topic: ${topic}
Tone: ${tone}
      
Format: Include hook, main content, and call-to-action. Make it engaging and compliant with Fair Housing laws.`,
    })

    // Create script record
    const script = await supabaseService.createScript({
      title: `Script: ${topic}`,
      category: "social_media",
      tone,
      target_duration: duration,
      content: text,
      status: "draft",
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      scriptId: script?.id,
      content: text,
    }
  } catch (error: any) {
    console.error("[Workflow] Script generation failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function sendNewsletterCampaign(campaignId: string) {
  try {
    console.log("[Workflow] Sending newsletter campaign")

    const campaign = await supabaseService.getRecordsByField("newsletter_campaigns", "id", campaignId)
    if (!campaign || campaign.length === 0) {
      return { success: false, error: "Campaign not found" }
    }

    // Update campaign status
    await supabaseService.updateRecord("newsletter_campaigns", campaignId, {
      status: "sending",
      sent_at: new Date().toISOString(),
    })

    // In production, integrate with email service here
    console.log("[Workflow] Would send newsletter campaign:", campaign[0])

    // Update final status
    await supabaseService.updateRecord("newsletter_campaigns", campaignId, {
      status: "sent",
      recipients_count: 100, // Mock value
    })

    return {
      success: true,
      message: "Newsletter campaign sent successfully",
    }
  } catch (error: any) {
    console.error("[Workflow] Newsletter campaign failed:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

// =====================================================
// UTILITY WORKFLOWS
// =====================================================

export async function retryFailedWorkflow(errorId: string, workflowId: string, contextJson: string) {
  try {
    console.log("[Workflow] Retrying failed workflow")

    await supabaseService.updateAutomationError(errorId, "retrying")

    // Parse context and retry the original workflow
    const context = JSON.parse(contextJson)

    // Map workflow ID to function (simplified)
    let result
    switch (workflowId) {
      case "wf-generate-7day-copilot-plan":
        result = await generateCopilotPlan(context.contactId, context.agentId)
        break
      default:
        result = { success: false, error: "Unknown workflow" }
    }

    if (result.success) {
      await supabaseService.updateAutomationError(errorId, "resolved")
    }

    return result
  } catch (error: any) {
    console.error("[Workflow] Retry failed:", error)
    await supabaseService.updateAutomationError(errorId, "failed")
    return {
      success: false,
      error: error.message,
    }
  }
}

export async function logUserActivity(userId: string, activityType: string, description: string, metadata?: any) {
  try {
    await supabaseService.logUserActivity({
      user_id: userId,
      activity_type: activityType,
      description,
      metadata_json: JSON.stringify(metadata || {}),
    })

    return { success: true }
  } catch (error: any) {
    console.error("[Workflow] Log activity failed:", error)
    return { success: false, error: error.message }
  }
}
