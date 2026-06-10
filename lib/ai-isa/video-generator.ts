'use server'

// AI-ISA personalized intro video generator.
//
// Routes through `dispatchVideo`, which is platform-locked to D-ID + ElevenLabs
// (the agent's own avatar/voice cloned in Settings → Voice & Avatar). HeyGen is
// NOT a reachable path. Provider key returned from dispatch is the source of
// truth for the log row.

import { createServiceClient } from '@/lib/supabase/service'
import { dispatchVideo } from '@/lib/providers/dispatch'

export interface VideoGenerationContext {
  leadId: string
  firstName: string
  brokerageId: string
  agentUserId?: string
  recipientEmail: string
  /** Rendered script template (variables filled by dispatch). */
  templateId?: string
  motivation_type?: string
  property_interest?: string
  timeline?: string
}

export async function generateAvatarVideo(context: VideoGenerationContext) {
  try {
    const result = await dispatchVideo({
      brokerageId:    context.brokerageId,
      userId:         context.agentUserId,
      templateId:     context.templateId ?? '',
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

    // The actual provider that rendered the video comes back from dispatch.
    const supabase = createServiceClient()
    supabase.from('message_provider_logs').insert({
      brokerage_id:        context.brokerageId,
      provider_key:        result.providerKey,
      channel:             'video',
      direction:           'outbound',
      provider_message_id: result.messageId ?? null,
      provider_status:     result.success ? 'sent' : 'failed',
      error_message:       result.error ?? null,
    })

    return {
      success:     result.success,
      videoId:     result.messageId,
      providerKey: result.providerKey,
      error:       result.error,
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    const supabase = createServiceClient()
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_video_generation',
      error_message: msg,
      context_json:  JSON.stringify({ leadId: context.leadId }),
      severity:      'low',
      status:        'open',
      created_at:    new Date().toISOString(),
    })
    return { success: false, videoId: undefined, providerKey: undefined, error: msg }
  }
}

export async function embedVideoInEmail(emailBody: string, videoUrl: string | null) {
  if (!videoUrl) {
    return emailBody.replace('[Video will be embedded here]',
      '[Note: Personalized video intro is being prepared and will be sent shortly]')
  }
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
