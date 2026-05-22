'use server'

import { createClient } from '@/lib/supabase/server'
import { generateTextRouted as generateText } from '@/lib/ai/models'
import { revalidatePath } from 'next/cache'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'

// ============================================
// MAIN: GENERATE LISTING VIDEO
// ============================================

export async function generateListingVideo(params: {
  transactionId?: string
  propertyId?: string
  agentId: string
  videoType?: 'full_tour' | 'social_snippet' | 'instagram_story' | 'reel' | 'drone_highlight'
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: 'Invalid agent ID' }
  }

  const supabase = await createClient()

  try {
    // 1. Get property and photos
    let property: any = null
    let photos: any[] = []

    if (params.transactionId && isValidUUID(params.transactionId)) {
      const { data: transaction } = await supabase
        .from('transactions')
        .select('*, listings(*)')
        .eq('id', params.transactionId)
        .single()

      property = transaction?.listings
    } else if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data } = await supabase.from('listings').select('*').eq('id', params.propertyId).single()
      property = data
    }

    if (!property) {
      return { success: false, error: 'Property not found' }
    }

    // Get listing photos
    const { data: listingPhotos } = await supabase
      .from('listing_photos')
      .select('*')
      .eq('listing_id', property.id)
      .order('display_order')

    photos = listingPhotos || []

    const videoType = params.videoType || 'full_tour'
    const minPhotos: Record<string, number> = {
      full_tour: 8,
      social_snippet: 5,
      instagram_story: 3,
      reel: 5,
      drone_highlight: 3,
    }

    if (photos.length < minPhotos[videoType]) {
      return { success: false, error: `Need at least ${minPhotos[videoType]} photos for ${videoType}` }
    }

    // 2. Create video project
    const { data: project } = await supabase
      .from('ai_video_projects')
      .insert({
        agent_id: params.agentId,
        contact_id: params.propertyId,
        video_type: videoType,
        heygen_status: 'pending',
        script_generated_by: 'ai',
        duration_seconds: getDurationForType(videoType),
      })
      .select()
      .single()

    if (!project) {
      return { success: false, error: 'Failed to create video project' }
    }

    // 3. AI selects best photos
    const selectedPhotos = await selectPhotosForVideo(photos, videoType, property)

    // 4. Save selected assets
    for (let i = 0; i < selectedPhotos.photos.length; i++) {
      await supabase.from('video_assets').insert({
        video_project_id: project.id,
        asset_type: 'photo',
        asset_url: selectedPhotos.photos[i].file_url,
        duration_seconds: selectedPhotos.durations[i] || 3.0,
        sort_order: i + 1,
        transition_effect: selectedPhotos.transitions[i] || 'fade',
        ai_selected: true,
        selection_reasoning: selectedPhotos.reasoning,
      })
    }

    // 5. Generate narration script
    const script = await generateVideoNarration(property, videoType, selectedPhotos.photos)

    // 6. Validate "Them First"
    const validation = await validateThemFirstContent(script, 'video_script')

    // 7. Update project with script
    await supabase
      .from('ai_video_projects')
      .update({
        script_content: script,
        them_first_score: Math.round(validation.overall_score * 100),
        heygen_status: validation.passed ? 'pending' : 'pending',
        compliance_approved: validation.passed,
      })
      .eq('id', project.id)

    // 8. Queue video generation
    await supabase.from('video_generation_queue').insert({
      video_project_id: project.id,
      priority: 5,
      status: 'queued',
      estimated_completion_minutes: 15,
    })

    revalidatePath('/dashboard/marketing/videos')
    return {
      success: true,
      projectId: project.id,
      autoApproved: validation.passed,
      validation,
    }
  } catch (error) {
    console.error('Generate listing video error:', error)
    return { success: false, error: 'Failed to generate video' }
  }
}

// ============================================
// AI PHOTO SELECTION
// ============================================

async function selectPhotosForVideo(allPhotos: any[], videoType: string, property: any) {
  const videoSpecs: Record<string, any> = {
    full_tour: {
      count: 12,
      duration: 120,
      sequence: 'complete_walkthrough',
      emphasis: 'comprehensive',
    },
    social_snippet: {
      count: 5,
      duration: 30,
      sequence: 'highlights_only',
      emphasis: 'best_features',
    },
    instagram_story: {
      count: 5,
      duration: 15,
      sequence: 'quick_tour',
      emphasis: 'eye_catching',
    },
    reel: {
      count: 8,
      duration: 45,
      sequence: 'dynamic_flow',
      emphasis: 'energetic',
    },
    drone_highlight: {
      count: 6,
      duration: 30,
      sequence: 'aerial_only',
      emphasis: 'location_property',
    },
  }

  const spec = videoSpecs[videoType]

  const prompt = `Select the best ${spec.count} photos for a ${videoType} video (${spec.duration}s total).

Property: ${property.address} - ${property.property_type}
Available Photos: ${allPhotos.length}

${allPhotos
  .map(
    (p, i) => `
${i + 1}. ${p.photo_type} - ${p.room_name || 'N/A'}
   Quality: ${p.ai_quality_score || 'N/A'}/100
   Order: ${p.display_order}
`,
  )
  .join('\n')}

Video Requirements:
- Type: ${videoType}
- Duration: ${spec.duration} seconds
- Sequence Style: ${spec.sequence}
- Emphasis: ${spec.emphasis}

Selection Rules:
${
  spec.sequence === 'complete_walkthrough'
    ? `
1. Start with best exterior (hero shot)
2. Entry/foyer
3. Living spaces
4. Kitchen (key selling point)
5. Bedrooms (master first)
6. Bathrooms
7. Special features (pool, view, etc.)
8. Backyard/outdoor
9. Final exterior shot
`
    : ''
}

${
  spec.sequence === 'highlights_only'
    ? `
1. Best exterior
2. Most impressive interior feature
3. Master bedroom
4. Best outdoor feature
5. Closing exterior angle
`
    : ''
}

For each photo, assign:
- Duration (2-5 seconds based on visual interest)
- Transition effect (fade, slide, zoom)

Return JSON:
{
  "photos": [array of selected photo indices],
  "durations": [seconds per photo],
  "transitions": [transition effects],
  "reasoning": "why this selection and order"
}`

  const { text } = await generateText({
    model: 'openai/gpt-4o',
    prompt,
  })

  const selection = JSON.parse(text)

  return {
    photos: selection.photos.map((i: number) => allPhotos[i]),
    durations: selection.durations,
    transitions: selection.transitions,
    reasoning: selection.reasoning,
  }
}

// ============================================
// GENERATE VIDEO NARRATION SCRIPT
// ============================================

async function generateVideoNarration(property: any, videoType: string, selectedPhotos: any[]) {
  const scriptLengths: Record<string, string> = {
    full_tour: '150-180 words (2 min narration)',
    social_snippet: '40-60 words (30 sec)',
    instagram_story: '20-30 words (15 sec)',
    reel: '50-70 words (45 sec)',
    drone_highlight: '30-50 words (30 sec)',
  }

  const prompt = `Generate narration script for ${videoType} property video:

**Property:**
- Address: ${property.address}, ${property.city}
- Price: $${property.price?.toLocaleString() || property.listing_price?.toLocaleString()}
- Type: ${property.bedrooms}BR/${property.bathrooms}BA
- Sqft: ${property.square_feet || property.square_footage}
- Features: ${property.features?.join(', ') || property.property_features?.join(', ')}

**Video Sequence (${selectedPhotos.length} scenes):**
${selectedPhotos.map((p, i) => `${i + 1}. ${p.photo_type} - ${p.room_name || 'exterior'}`).join('\n')}

**Script Requirements:**
- Length: ${scriptLengths[videoType]}
- Match visual flow (reference what viewer sees)
- "Them First" approach:
  - Start with emotional appeal (how it FEELS to live here)
  - Paint lifestyle picture, not just features
  - Benefits over features ("wake up to..." not "has 4 bedrooms")
  - Create desire and imagination
- Pacing: Matches ${selectedPhotos.length} photo changes
- Tone: Warm, inviting, conversational
- Avoid: "This home has", "You will love", generic phrases
- Use: "Imagine", "Picture", "Welcome to", sensory details

**Style Examples:**
Scene 1 (Exterior): "Welcome to your dream home in the heart of [neighborhood]..."
Scene 2 (Living): "Picture lazy Sunday mornings here, natural light streaming through..."
Scene 3 (Kitchen): "The heart of the home - where family dinners and celebrations come to life..."

Generate narration script that flows naturally with the visual sequence:`

  const { text } = await generateText({
    model: 'openai/gpt-4o',
    prompt,
    temperature: 0.8,
  })

  return text
}

// ============================================
// "THEM FIRST" VALIDATION
// ============================================

async function validateThemFirstContent(content: string, contentType: string) {
  const agentCentricPhrases = [
    /\b(i|me|my|our team|we offer|my expertise|i specialize|i can help)\b/gi,
    /\b(contact me|call me|reach out|my services)\b/gi,
  ]

  const buyerCentricPhrases = [
    /\b(you|your|imagine|picture yourself|envision|experience)\b/gi,
    /\b(perfect for|ideal for|great for families|enjoy)\b/gi,
  ]

  let agentCentricCount = 0
  let buyerCentricCount = 0

  for (const pattern of agentCentricPhrases) {
    const matches = content.match(pattern)
    agentCentricCount += matches?.length || 0
  }

  for (const pattern of buyerCentricPhrases) {
    const matches = content.match(pattern)
    buyerCentricCount += matches?.length || 0
  }

  const totalReferences = agentCentricCount + buyerCentricCount
  const buyerFocusRatio = totalReferences > 0 ? buyerCentricCount / totalReferences : 0.5

  const passed = buyerFocusRatio >= 0.7

  return {
    passed,
    overall_score: buyerFocusRatio,
    agent_centric_count: agentCentricCount,
    buyer_centric_count: buyerCentricCount,
    recommendations: passed
      ? ['Great job keeping the focus on the buyer!']
      : [
          'Reduce agent-centric language (I, me, my)',
          'Increase buyer-focused language (you, your, imagine)',
          'Focus on buyer benefits rather than agent credentials',
        ],
  }
}

// ============================================
// PUBLISH VIDEO TO PLATFORMS
// ============================================

export async function publishVideoToPlatforms(params: {
  projectId: string
  platforms: ('youtube' | 'facebook' | 'instagram')[]
}) {
  if (!isValidUUID(params.projectId)) {
    return { success: false, error: 'Invalid project ID' }
  }

  const supabase = await createClient()

  try {
    const { data: project } = await supabase.from('ai_video_projects').select('*').eq('id', params.projectId).single()

    if (!project || project.heygen_status !== 'completed') {
      return { success: false, error: 'Video not ready for publishing' }
    }

    const results = []

    for (const platform of params.platforms) {
      // In production, integrate with platform APIs
      // For demo, mark as published
      results.push({
        platform,
        url: `https://${platform}.com/video/${project.id}`,
        success: true,
      })
    }

    await supabase
      .from('ai_video_projects')
      .update({
        distributed_via: params.platforms,
      })
      .eq('id', params.projectId)

    revalidatePath('/dashboard/marketing/videos')
    return { success: true, published: results }
  } catch (error) {
    console.error('Publish video error:', error)
    return { success: false, error: 'Failed to publish video' }
  }
}

// ============================================
// TRACK VIDEO VIEW
// ============================================

export async function trackVideoView(projectId: string) {
  if (!isValidUUID(projectId)) {
    return
  }

  const supabase = await createClient()

  await supabase.rpc('increment', {
    table_name: 'ai_video_projects',
    row_id: projectId,
    column_name: 'view_count',
  })
}

// ============================================
// GET VIDEO PROJECTS
// ============================================

export async function getVideoProjects(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('ai_video_projects')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Get video projects error:', error)
    return []
  }

  return data || []
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getDurationForType(videoType: string): number {
  const durations: Record<string, number> = {
    full_tour: 120,
    social_snippet: 30,
    instagram_story: 15,
    reel: 45,
    drone_highlight: 30,
  }
  return durations[videoType] || 60
}

function getAspectRatio(videoType: string): string {
  const ratios: Record<string, string> = {
    full_tour: '16:9',
    social_snippet: '1:1',
    instagram_story: '9:16',
    reel: '9:16',
    drone_highlight: '16:9',
  }
  return ratios[videoType] || '16:9'
}
