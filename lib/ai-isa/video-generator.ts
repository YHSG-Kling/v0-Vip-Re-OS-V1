'use server'

// AI-ISA personalized intro video generator.
// Routes through dispatchVideo, which uses D-ID + ElevenLabs by default
// (per kernel-OS plan FIX 0C.6) and falls back to HeyGen only when the
// platform-level video provider is set to "heygen".

import { createServiceClient } from '@/lib/supabase/service'
import { dispatchVideo } from '@/lib/providers/dispatch'

export interface VideoGenerationContext {
  leadId: string
  firstName: string
  brokerageId: string
  agentUserId?: string
  recipientEmail: string
  templateId?: string
  motivation_type?: string
  property_interest?: string
  timeline?: string
}

export async function generateAvatarVideo(context: VideoGenerationContext) {
  return generateHeyGenVideo(context)
}

export async function generateHeyGenVideo(context: VideoGenerationContext) {
  try {
    // Step 1: Dispatch through provider resolution layer
    const result = await dispatchVideo({
      brokerageId:    context.brokerageId,
      userId:         context.agentUserId,
      templateId:     context.templateId ?? process.env.HEYGEN_DEFAULT_TEMPLATE_ID ?? '',
      recipientEmail: context.recipientEmail,
      recipientName:  context.firstName,
      scriptVars: {
        first_name:        context.firstName,
        motivation_type:   context.motivation_type ?? '',
        property_interest: context.property_interest ?? '',
        timeline:          context.timeline ?? '',
      },
      systemSource: 'ai_isa',
      leadId:       context.leadId,
    })

    // Step 2: Fire-and-forget provider log
    const supabase = createServiceClient()
    supabase.from('message_provider_logs').insert({
      brokerage_id:        context.brokerageId,
      provider_key:        'heygen',
      channel:             'video',
      direction:           'outbound',
      provider_message_id: result.messageId ?? null,
      provider_status:     result.success ? 'sent' : 'failed',
      error_message:       result.error ?? null,
    })

    return {
      success:  result.success,
      videoId:  result.messageId,
      error:    result.error,
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)

    // Log error but don't block email send
    const supabase = createServiceClient()
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_video_generation',
      error_message: msg,
      context_json:  JSON.stringify({ leadId: context.leadId }),
      severity:      'low',
      status:        'open',
      created_at:    new Date().toISOString(),
    })

    return { success: false, videoId: undefined, error: msg }
  }
}

export async function embedVideoInEmail(emailBody: string, videoUrl: string | null) {
  if (!videoUrl) {
    // Remove video placeholder if generation failed
    return emailBody.replace('[Video will be embedded here]', 
      '[Note: Personalized video intro is being prepared and will be sent shortly]')
  }
  
  // Embed video with proper HTML
  const videoEmbed = `
    <div style="margin: 20px 0; text-align: center;">
      <video controls style="max-width: 100%; border-radius: 8px;">
        <source src="${videoUrl}" type="video/mp4">
        Your email client doesn't support video playback. 
        <a href="${videoUrl}">Click here to watch</a>
      </video>
    </div>
  `
  
  return emailBody.replace('[Video will be embedded here]', videoEmbed)
}
