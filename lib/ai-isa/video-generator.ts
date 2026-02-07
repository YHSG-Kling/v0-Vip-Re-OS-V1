'use server'

import { createServiceClient } from '@/lib/supabase/service'

export interface VideoGenerationContext {
  leadId: string
  firstName: string
  motivation_type?: string
  property_interest?: string
  timeline?: string
}

export async function generateHeyGenVideo(context: VideoGenerationContext) {
  console.log('[v0] Generating HeyGen video for lead:', context.leadId)
  
  // Create video script focused on the lead
  const script = `Hi ${context.firstName},

I'm reaching out because I saw you're interested in ${context.property_interest || 'real estate'} ${context.timeline ? `and looking to ${context.timeline}` : 'in the area'}.

${context.motivation_type ? `I understand you're ${context.motivation_type}, and I want you to know that our platform is designed specifically to help people in your situation.` : 'Our platform is here to help you navigate your real estate journey with confidence.'}

We don't push or pressure—we simply provide you with the tools, information, and support you need to make the best decision for yourself.

When you're ready to take the next step, we'll be here. Until then, feel free to explore our resources at your own pace.

Looking forward to helping you!`

  try {
    // Call HeyGen API (stub for now - implement actual API call)
    // const response = await fetch('https://api.heygen.com/v1/video.generate', {
    //   method: 'POST',
    //   headers: {
    //     'X-Api-Key': process.env.HEYGEN_API_KEY || '',
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     script,
    //     avatar_id: 'default_avatar',
    //     voice_id: 'default_voice'
    //   })
    // })
    
    // For now, return a placeholder
    console.log('[v0] HeyGen API would be called here with script:', script)
    
    return {
      success: false,
      videoUrl: null,
      error: 'HeyGen integration pending - API key required'
    }
  } catch (error: any) {
    console.error('[v0] HeyGen video generation error:', error)
    
    // Log error but don't block email send
    const supabase = createServiceClient()
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_video_generation',
      error_message: error.message,
      context_json: JSON.stringify({ leadId: context.leadId, script }),
      severity: 'low',
      status: 'new',
      created_at: new Date().toISOString()
    })
    
    return {
      success: false,
      videoUrl: null,
      error: error.message
    }
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
