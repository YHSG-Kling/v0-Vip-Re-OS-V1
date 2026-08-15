"use server"

// ============================================================
// SYSTEM: L11-S02 — Brand Setup Wizard Server Actions
// VIP Real Estate AI OS — Layer 11
// ============================================================
//
// Brand setup is brokerage-wide config. Previously any signed-in agent
// in a brokerage could mutate colors, voice profile, templates, and
// publish brand changes for the entire brokerage. All save* + publish
// + uploadLogo paths now require admin / broker / broker_owner role.

import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

const BROKERAGE_ADMIN_ROLES = ["admin", "broker", "broker_owner", "superadmin", "super_admin"]

async function requireBrandAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Brokerage not found" }
  if (!BROKERAGE_ADMIN_ROLES.includes(profile.user_type ?? "")) {
    return { ok: false, error: "Forbidden: brokerage admin only" }
  }
  return { ok: true, userId: user.id, brokerageId: profile.brokerage_id }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface BrandSetupStatus {
  globalSettings: {
    id: string
    primary_color: string | null
    secondary_color: string | null
    font_family: string | null
    app_logo_url: string | null
  } | null
  brandVoice: {
    id: string
    tone: string | null
    formality_level: string | null
    prohibited_words: string[] | null
    preferred_words: string[] | null
    tagline: string | null
  } | null
  brandSettings: {
    id: string
    tagline: string | null
    website_url: string | null
    facebook_url: string | null
    instagram_url: string | null
    linkedin_url: string | null
    email_signature_html: string | null
    letterhead_html: string | null
    accent_color: string | null
    heading_size: string | null
    body_text_size: string | null
    wizard_step_reached: number
    wizard_completed_at: string | null
  } | null
  templates: Array<{
    id: string
    template_name: string
    template_type: string
    content_html: string | null
    is_active: boolean
  }>
  completedSteps: string[]
}

export interface SaveColorsData {
  primaryColor: string
  secondaryColor: string
  accentColor?: string
  tagline?: string
  logoUrl?: string
}

export interface SaveTypographyData {
  fontFamily: string
  headingSize: "small" | "medium" | "large"
  bodyTextSize: "small" | "medium"
}

export interface SaveVoiceData {
  voiceName?: string
  tone: string
  formalityLevel: string
  prohibitedWords: string[]
  signaturePhrases: string[]
}

export interface SaveTemplateData {
  templateName: string
  templateType: "email_signature" | "letterhead" | "business_card" | "custom"
  contentHtml: string
}

// ─── GET BRAND SETUP STATUS ───────────────────────────────────────────────────

export async function getBrandSetupStatus(
  brokerageId: string
): Promise<{ data: BrandSetupStatus | null; error: string | null }> {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { data: null, error: "Unauthorized" }
    }

    // Verify user belongs to brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData || userData.brokerage_id !== brokerageId) {
      return { data: null, error: "Unauthorized: Brokerage mismatch" }
    }

    // Get global settings
    const { data: globalSettings } = await supabase
      .from("global_settings")
      .select("id, primary_color, secondary_color, font_family, app_logo_url")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // Get brand voice profile (brokerage level, not agent)
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("id, tone, formality_level, prohibited_words, preferred_words, tagline")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .maybeSingle()

    // Get brand settings
    const { data: brandSettings } = await supabase
      .from("brokerage_brand_settings")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // Get templates
    const { data: templates } = await supabase
      .from("brand_templates")
      .select("id, template_name, template_type, content_html, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)

    // Determine completed steps
    const completedSteps: string[] = []
    
    if (globalSettings?.primary_color) {
      completedSteps.push("colors")
    }
    if (globalSettings?.font_family) {
      completedSteps.push("typography")
    }
    if (brandVoice?.tone) {
      completedSteps.push("voice")
    }
    if (templates && templates.length > 0) {
      completedSteps.push("templates")
    }
    if (brandSettings?.wizard_completed_at) {
      completedSteps.push("published")
    }

    return {
      data: {
        globalSettings,
        brandVoice,
        brandSettings,
        templates: templates || [],
        completedSteps,
      },
      error: null,
    }
  } catch (error) {
    console.error("[L11-Brand] getBrandSetupStatus error:", error)
    return { data: null, error: "Failed to fetch brand setup status" }
  }
}

// ─── SAVE BRAND COLORS ────────────────────────────────────────────────────────

export async function saveBrandColors(
  data: SaveColorsData
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth = await requireBrandAdmin()
    if (!auth.ok) return { success: false, error: auth.error }
    const brokerageId = auth.brokerageId

    const supabase = await createClient()

    // Upsert global_settings
    const { error: settingsError } = await supabase
      .from("global_settings")
      .upsert({
        brokerage_id: brokerageId,
        primary_color: data.primaryColor,
        secondary_color: data.secondaryColor,
        app_logo_url: data.logoUrl || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    if (settingsError) {
      console.error("[L11-Brand] Failed to save global settings:", settingsError)
      return { success: false, error: "Failed to save colors" }
    }

    // Upsert brokerage_brand_settings
    const { error: brandError } = await supabase
      .from("brokerage_brand_settings")
      .upsert({
        brokerage_id: brokerageId,
        tagline: data.tagline || null,
        accent_color: data.accentColor || null,
        wizard_step_reached: 1,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    if (brandError) {
      console.error("[L11-Brand] Failed to save brand settings:", brandError)
      return { success: false, error: "Failed to save brand settings" }
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-Brand] saveBrandColors error:", error)
    return { success: false, error: "Failed to save brand colors" }
  }
}

// ─── SAVE TYPOGRAPHY ─────────────────────��────────────────────────────────────

export async function saveBrandTypography(
  data: SaveTypographyData
): Promise<{ success: boolean; error?: string }> {
  try {
    const adminAuth = await requireBrandAdmin()
    if (!adminAuth.ok) return { success: false, error: adminAuth.error }
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return { success: false, error: "Brokerage not found" }
    }

    const brokerageId = userData.brokerage_id

    // Update global_settings font
    const { error: settingsError } = await supabase
      .from("global_settings")
      .upsert({
        brokerage_id: brokerageId,
        font_family: data.fontFamily,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    if (settingsError) {
      console.error("[L11-Brand] Failed to save font settings:", settingsError)
      return { success: false, error: "Failed to save typography" }
    }

    // Update brand settings
    const { error: brandError } = await supabase
      .from("brokerage_brand_settings")
      .upsert({
        brokerage_id: brokerageId,
        heading_size: data.headingSize,
        body_text_size: data.bodyTextSize,
        wizard_step_reached: 2,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    if (brandError) {
      console.error("[L11-Brand] Failed to save brand typography:", brandError)
      return { success: false, error: "Failed to save typography settings" }
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-Brand] saveBrandTypography error:", error)
    return { success: false, error: "Failed to save typography" }
  }
}

// ─── SAVE BRAND VOICE ─────────────────────────────────────────────────────────

export async function saveBrandVoice(
  data: SaveVoiceData
): Promise<{ success: boolean; error?: string }> {
  try {
    const adminAuth = await requireBrandAdmin()
    if (!adminAuth.ok) return { success: false, error: adminAuth.error }
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return { success: false, error: "Brokerage not found" }
    }

    const brokerageId = userData.brokerage_id

    // Check for existing brand voice profile
    const { data: existing } = await supabase
      .from("brand_voice_profile")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .maybeSingle()

    if (existing) {
      // Update existing
      const { error: updateError } = await supabase
        .from("brand_voice_profile")
        .update({
          tone: data.tone,
          formality_level: data.formalityLevel,
          prohibited_words: data.prohibitedWords,
          preferred_words: data.signaturePhrases,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)

      if (updateError) {
        console.error("[L11-Brand] Failed to update brand voice:", updateError)
        return { success: false, error: "Failed to save voice settings" }
      }
    } else {
      // Insert new
      const { error: insertError } = await supabase
        .from("brand_voice_profile")
        .insert({
          brokerage_id: brokerageId,
          tone: data.tone,
          formality_level: data.formalityLevel,
          prohibited_words: data.prohibitedWords,
          preferred_words: data.signaturePhrases,
          is_active: true,
        })

      if (insertError) {
        console.error("[L11-Brand] Failed to insert brand voice:", insertError)
        return { success: false, error: "Failed to save voice settings" }
      }
    }

    // Update wizard step
    await supabase
      .from("brokerage_brand_settings")
      .upsert({
        brokerage_id: brokerageId,
        wizard_step_reached: 3,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    return { success: true }
  } catch (error) {
    console.error("[L11-Brand] saveBrandVoice error:", error)
    return { success: false, error: "Failed to save brand voice" }
  }
}

// ─── SAVE TEMPLATE ────────────────────────────────────────────────────────────

export async function saveTemplate(
  data: SaveTemplateData
): Promise<{ success: boolean; templateId?: string; error?: string }> {
  try {
    const adminAuth = await requireBrandAdmin()
    if (!adminAuth.ok) return { success: false, error: adminAuth.error }
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return { success: false, error: "Brokerage not found" }
    }

    const brokerageId = userData.brokerage_id

    // Deactivate existing templates of the same type
    await supabase
      .from("brand_templates")
      .update({ is_active: false })
      .eq("brokerage_id", brokerageId)
      .eq("template_type", data.templateType)

    // Insert new template
    const { data: template, error: templateError } = await supabase
      .from("brand_templates")
      .insert({
        brokerage_id: brokerageId,
        template_name: data.templateName,
        template_type: data.templateType,
        content_html: data.contentHtml,
        is_active: true,
      })
      .select("id")
      .single()

    if (templateError) {
      console.error("[L11-Brand] Failed to save template:", templateError)
      return { success: false, error: "Failed to save template" }
    }

    // Update brand settings with signature/letterhead
    if (data.templateType === "email_signature") {
      await supabase
        .from("brokerage_brand_settings")
        .upsert({
          brokerage_id: brokerageId,
          email_signature_html: data.contentHtml,
          wizard_step_reached: 4,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "brokerage_id",
        })
    } else if (data.templateType === "letterhead") {
      await supabase
        .from("brokerage_brand_settings")
        .upsert({
          brokerage_id: brokerageId,
          letterhead_html: data.contentHtml,
          wizard_step_reached: 4,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "brokerage_id",
        })
    }

    return { success: true, templateId: template.id }
  } catch (error) {
    console.error("[L11-Brand] saveTemplate error:", error)
    return { success: false, error: "Failed to save template" }
  }
}

// ─── PUBLISH BRAND ────────────────────────────────────────────────────────────

export async function publishBrand(
  _brokerageId?: string  // ignored — derived from session admin
): Promise<{ success: boolean; error?: string }> {
  try {
    const adminAuth = await requireBrandAdmin()
    if (!adminAuth.ok) return { success: false, error: adminAuth.error }
    const brokerageId = adminAuth.brokerageId
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Verify requirements are met
    const { data: globalSettings } = await supabase
      .from("global_settings")
      .select("primary_color, app_logo_url")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .maybeSingle()

    if (!globalSettings?.primary_color) {
      return { success: false, error: "Primary color is required" }
    }

    if (!globalSettings?.app_logo_url) {
      return { success: false, error: "Logo is required" }
    }

    if (!brandVoice) {
      return { success: false, error: "Brand voice is required" }
    }

    // Update brand settings
    const { error: updateError } = await supabase
      .from("brokerage_brand_settings")
      .upsert({
        brokerage_id: brokerageId,
        wizard_step_reached: 6,
        wizard_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    if (updateError) {
      console.error("[L11-Brand] Failed to update brand settings:", updateError)
      return { success: false, error: "Failed to publish brand" }
    }

    // Get agent's onboarding record
    const agentId = await resolveAgentId(supabase, user.id)
    const { data: onboarding } = await supabase
      .from("agent_onboarding")
      .select("id, status")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    // Fire kernel event
    await processKernelEvent({
      event: KernelEvent.BRAND_SETUP_COMPLETED,
      brokerageId,
      entityType: "brokerage_brand_settings",
      entityId: brokerageId,
    })

    // Transition lifecycle if onboarding exists
    if (onboarding) {
      await transitionLifecycle({
        brokerageId,
        entityType: "agent_onboarding_machine",
        entityId: onboarding.id,
        fromState: onboarding.status || "contract_signed",
        toState: "brand_configured",
        actorUserId: user.id,
        eventType: "brand_configured",
        metadata: {},
      })
    }

    return { success: true }
  } catch (error) {
    console.error("[L11-Brand] publishBrand error:", error)
    return { success: false, error: "Failed to publish brand" }
  }
}

// ─── UPLOAD LOGO ──────────────────────────────────────────────────────────────

export async function uploadLogo(
  formData: FormData
): Promise<{ success: boolean; logoUrl?: string; error?: string }> {
  try {
    const adminAuth = await requireBrandAdmin()
    if (!adminAuth.ok) return { success: false, error: adminAuth.error }
    const supabase = await createClient()

    // Verify session (legacy — already verified by requireBrandAdmin)
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return { success: false, error: "Brokerage not found" }
    }

    const file = formData.get("file") as File
    if (!file) {
      return { success: false, error: "No file provided" }
    }

    // Validate file type
    const allowedTypes = ["image/png", "image/svg+xml", "image/jpeg"]
    if (!allowedTypes.includes(file.type)) {
      return { success: false, error: "File must be PNG, SVG, or JPEG" }
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      return { success: false, error: "File size must be less than 5MB" }
    }

    const brokerageId = userData.brokerage_id
    const fileExt = file.name.split(".").pop()
    const fileName = `${brokerageId}/logo.${fileExt}`

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("brokerage-assets")
      .upload(fileName, file, {
        cacheControl: "3600",
        upsert: true,
      })

    if (uploadError) {
      console.error("[L11-Brand] Failed to upload logo:", uploadError)
      return { success: false, error: "Failed to upload logo" }
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from("brokerage-assets")
      .getPublicUrl(fileName)

    // Update global_settings with logo URL
    await supabase
      .from("global_settings")
      .upsert({
        brokerage_id: brokerageId,
        app_logo_url: urlData.publicUrl,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "brokerage_id",
      })

    return { success: true, logoUrl: urlData.publicUrl }
  } catch (error) {
    console.error("[L11-Brand] uploadLogo error:", error)
    return { success: false, error: "Failed to upload logo" }
  }
}
