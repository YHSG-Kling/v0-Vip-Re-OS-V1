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

import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { resolveActingContext, READ_ONLY_ACTING_ERROR } from "@/lib/platform/acting-context"

// TRUE ADMIN GATE (operational: branding/onboarding) — repointed to the ONE
// tenant roster (isAdminOrBroker below). 'superadmin'/'super_admin' were dead:
// 0 live rows store either users.user_type spelling.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { checkUpload } from "@/lib/storage/file-limits"

/**
 * Brand config is brokerage-wide + admin-gated. Now IMPERSONATION-AWARE: when a platform
 * staff member is acting-as a tenant, resolveActingContext yields the TARGET brokerage +
 * a service client (so the write isn't blocked by the target's RLS) + a read-only flag.
 * A normal tenant admin keeps their own RLS-scoped client — nothing about that path changes.
 * Writers must call assertWritable() and write THROUGH the returned `db`, keyed to `brokerageId`.
 */
async function requireBrandAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; db: any; readOnly: boolean; isImpersonating: boolean }
  | { ok: false; error: string }
> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not found" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Forbidden: brokerage admin only" }
  }
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId, db: ctx.db, readOnly: ctx.readOnly, isImpersonating: ctx.isImpersonating }
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
    // Acting-aware: a normal user reads their OWN brokerage; a platform-staff member
    // acting-as reads the TARGET brokerage (resolveActingContext yields it + a service
    // client that isn't blocked by the target's RLS).
    const ctx = await resolveActingContext()
    if (!ctx.ok || !ctx.userId) return { data: null, error: "Unauthorized" }
    if (ctx.brokerageId !== brokerageId) return { data: null, error: "Unauthorized: Brokerage mismatch" }
    const supabase = ctx.db

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
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const brokerageId = auth.brokerageId

    const supabase = auth.db

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
    if (adminAuth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const supabase = adminAuth.db
    const brokerageId = adminAuth.brokerageId

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
    if (adminAuth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const supabase = adminAuth.db
    const brokerageId = adminAuth.brokerageId

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
    if (adminAuth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const supabase = adminAuth.db
    const brokerageId = adminAuth.brokerageId

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
    if (adminAuth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const brokerageId = adminAuth.brokerageId
    const supabase = adminAuth.db

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
    const agentId = await resolveAgentId(supabase, adminAuth.userId)
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
        actorUserId: adminAuth.userId,
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
    if (adminAuth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const supabase = adminAuth.db
    const brokerageId = adminAuth.brokerageId

    const file = formData.get("file") as File
    if (!file) {
      return { success: false, error: "No file provided" }
    }

    // TYPE AND SIZE, from the bucket's own live configuration rather than from
    // two literals kept here. `brokerage-assets` declares
    // allowed_mime_types = [image/png, image/svg+xml, image/jpeg] and
    // file_size_limit = 5,242,880 — the hand-kept pair below happened to agree
    // with it today, which is precisely why they were worth removing: nothing
    // would have said so if the bucket changed. The transport ceiling is folded
    // in too (this is a Server Action, so 4.5 MB is the real cap and 5 MB was
    // already unreachable).
    const gate = checkUpload({
      bucket: "brokerage-assets",
      transport: "server_action",
      bytes: file.size,
      contentType: file.type,
    })
    if (!gate.ok) {
      return { success: false, error: gate.reason }
    }

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
