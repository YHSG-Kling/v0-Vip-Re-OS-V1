'use server'

import { createClient } from '@/lib/supabase/server'
import { generateTextRouted as generateText } from '@/lib/ai/models'
import { revalidatePath } from 'next/cache'
import { isValidUUID } from '@/lib/validations'
import { evaluateThemFirstFocus } from '@/lib/compliance-rules/rule-evaluators'

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
      // supabase-js RESOLVES a refused query, so `const { data }` alone turns
      // "permission denied" into "Property not found" — a message naming the
      // wrong problem, on the read that also carries this video's tenant.
      const { data: transaction, error: transactionError } = await supabase
        .from('transactions')
        .select('*, listings(*)')
        .eq('id', params.transactionId)
        .single()

      if (transactionError) {
        return { success: false, error: `Could not read the transaction — ${transactionError.message}` }
      }
      property = transaction?.listings
    } else if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data, error: listingError } = await supabase
        .from('listings')
        .select('*')
        .eq('id', params.propertyId)
        .single()
      if (listingError) {
        return { success: false, error: `Could not read the listing — ${listingError.message}` }
      }
      property = data
    }

    if (!property) {
      return { success: false, error: 'Property not found' }
    }

    // TENANT ANCHOR — from the LISTING this video is filed against, not from the
    // caller. ai_video_projects.listing_id FKs listings(id) and listings carries
    // brokerage_id, so the parent row IS the answer; nothing here is inferred
    // from an id space that isn't a tenant (params.agentId is an agents.id).
    //
    // This matters because ai_video_projects.brokerage_id was omitted entirely:
    // the table's own policy is permissive (`ai_video_projects_all` USING(true)),
    // but every APP reader narrows — getVideoAnalytics does
    // `.eq("brokerage_id", auth.brokerageId)`, and `NULL = <uuid>` is NULL, never
    // true. So each project this action created was written successfully and then
    // never appeared on any brokerage's video surface again.
    let videoBrokerageId = (property.brokerage_id as string | null) ?? null
    if (!videoBrokerageId) {
      // Legacy listings can carry no tenant. Fall back to the OTHER parent this
      // row already names — agents(id), whose brokerage_id is a real tenant.
      // agents.id and brokerages.id are disjoint; the column is read, never the id.
      const { data: videoAgent, error: videoAgentError } = await supabase
        .from('agents')
        .select('brokerage_id')
        .eq('id', params.agentId)
        .maybeSingle()
      if (videoAgentError) {
        return { success: false, error: `Could not resolve the agent's brokerage — ${videoAgentError.message}` }
      }
      videoBrokerageId = (videoAgent?.brokerage_id as string | null) ?? null
    }
    if (!videoBrokerageId) {
      return {
        success: false,
        error:
          'This listing and this agent both carry no brokerage, so the video project would be invisible to every brokerage video surface. Assign the listing to a brokerage first.',
      }
    }

    // Get listing photos — listing_media rows of media_type='photo'
    // (m368/m369 consolidation). The pin is load-bearing: without it a
    // disclosure PDF or a virtual-tour link would be counted toward the photo
    // minimum below and then handed to the AI as a video frame.
    const { data: listingPhotos, error: photosError } = await supabase
      .from('listing_media')
      .select('id, file_url, sort_order, is_primary, room_type, ai_quality_score')
      .eq('listing_id', property.id)
      .eq('media_type', 'photo')
      .order('sort_order')

    // A refused read resolves empty, which would surface as "Need at least N
    // photos" — a message naming the wrong problem.
    if (photosError) {
      return { success: false, error: `Could not read the listing photos — ${photosError.message}` }
    }
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
    const { data: project, error: projectError } = await supabase
      .from('ai_video_projects')
      .insert({
        brokerage_id: videoBrokerageId, // resolved above from the listing (then the agent)
        agent_id: params.agentId,
        listing_id: property.id, // this is a listing video, not a contact
        video_type: mapVideoType(videoType), // map to the CHECK-valid vocabulary
        provider_status: 'pending',
        is_ai_generated: true,
        duration_seconds: getDurationForType(videoType),
        video_metadata: {
          format: videoType,
          aspect_ratio: getAspectRatio(videoType),
          script_generated_by: 'ai',
        },
      })
      .select()
      .single()

    if (projectError) {
      return { success: false, error: `Failed to create video project — ${projectError.message}` }
    }
    if (!project) {
      return { success: false, error: 'Failed to create video project' }
    }

    // 3. AI selects best photos
    const selectedPhotos = await selectPhotosForVideo(photos, videoType, property)

    // 4. Persist the AI-selected photo manifest on the project row.
    //    video_assets is the brokerage stock-clip library (a different feature),
    //    so per-project scene rows live in ai_video_projects.video_metadata.
    const sceneAssets = selectedPhotos.photos.map((p: any, i: number) => ({
      asset_type: 'photo',
      asset_url: p.file_url,
      duration_seconds: selectedPhotos.durations[i] || 3.0,
      sort_order: i + 1,
      transition_effect: selectedPhotos.transitions[i] || 'fade',
      ai_selected: true,
    }))
    await supabase
      .from('ai_video_projects')
      .update({
        video_metadata: {
          format: videoType,
          aspect_ratio: getAspectRatio(videoType),
          script_generated_by: 'ai',
          scenes: sceneAssets,
          selection_reasoning: selectedPhotos.reasoning,
        },
      })
      .eq('id', project.id)

    // 5. Generate narration script
    const script = await generateVideoNarration(property, videoType, selectedPhotos.photos)

    // 6. Validate "Them First"
    const validation = evaluateThemFirstFocus(script)

    // 7. Update project with script
    await supabase
      .from('ai_video_projects')
      .update({
        script_content: script,
        provider_status: 'pending',
        compliance_status: validation.passed ? 'passed' : 'needs_review',
        provider_metadata: { them_first_score: Math.round(validation.overall_score * 100) },
      })
      .eq('id', project.id)

    // 8. Queue video generation (real column is project_id)
    await supabase.from('video_generation_queue').insert({
      project_id: project.id,
      priority: 5,
      status: 'queued',
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
${i + 1}. photo - ${p.file_url}
   Hero: ${p.is_primary ? 'yes' : 'no'}
   Order: ${p.sort_order}
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
//
// TOMBSTONE — the private `validateThemFirstContent` that stood here is
// DELETED. Survivor: lib/compliance-rules/rule-evaluators.ts:402
// `evaluateThemFirstFocus`, imported at the top of this file and called at the
// narration step below.
//
// It was the third spelling of one idea (§6): the same pronoun ratio the
// compliance REPORT and the kernel GATE already computed, with a third word
// list. `provider_metadata.them_first_score` and `compliance_status` on
// `ai_video_projects` are stamped from it, so the number a reviewer sees on a
// video now matches the number the gate would compute over the same text.
// The `contentType` argument it accepted was never read — the survivor does
// not take one, and the content type is already on the row being written.

// ============================================
// TRACK VIDEO VIEW
// ============================================

/**
 * Bump a listing video's view counter.
 *
 * DELIBERATELY UNAUTHENTICATED — a listing video is watched by prospects on
 * public/portal surfaces who have no agent session, so requiring one would
 * defeat the metric. What is enforced instead:
 *
 *  1. The project must EXIST and be genuinely watchable (`video_url` set).
 *     `public.increment` is SECURITY DEFINER with a hard (table, column)
 *     allow-list (verified live), so it bypasses RLS entirely and would
 *     otherwise happily increment any `ai_video_projects` row id — including
 *     drafts and rows in other brokerages — and its silence/failure would
 *     also confirm or deny that a given uuid exists.
 *  2. The rpc error is destructured. Previously the whole call was
 *     fire-and-forget, so a broken counter looked identical to a working one.
 *
 * KNOWN GAP, deliberately left: there is no per-viewer dedupe, so a caller in
 * a loop can still inflate `view_count` on a real, published video. Closing
 * that needs a `video_views(project_id, viewer_fingerprint, viewed_at)` ledger
 * with a unique index on (project_id, viewer_fingerprint, day) and the counter
 * derived from it — a migration plus a fingerprint source, neither of which
 * exists yet. Recorded rather than half-built.
 */
export async function trackVideoView(
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(projectId)) {
    return { success: false, error: 'Invalid project ID' }
  }

  const supabase = await createClient()

  const { data: project, error: lookupError } = await supabase
    .from('ai_video_projects')
    .select('id, video_url')
    .eq('id', projectId)
    .maybeSingle()

  // Fail closed: a refused read is not "no such video".
  if (lookupError) {
    return { success: false, error: 'Could not verify the video' }
  }
  // Same response for "absent" and "not yet rendered" so the endpoint is not
  // an existence oracle over the uuid space.
  if (!project?.video_url) {
    return { success: false, error: 'Video not available' }
  }

  const { error: incrementError } = await supabase.rpc('increment', {
    table_name: 'ai_video_projects',
    row_id: projectId,
    column_name: 'view_count',
  })

  if (incrementError) {
    console.error('trackVideoView: increment failed', incrementError)
    return { success: false, error: 'Could not record the view' }
  }

  return { success: true }
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

// Map this feature's format vocabulary onto the ai_video_projects.video_type CHECK.
function mapVideoType(videoType: string): string {
  const map: Record<string, string> = {
    full_tour: 'listing_tour',
    social_snippet: 'social_reel',
    instagram_story: 'social_reel',
    reel: 'social_reel',
    drone_highlight: 'listing_tour',
  }
  return map[videoType] || 'listing_tour'
}

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
