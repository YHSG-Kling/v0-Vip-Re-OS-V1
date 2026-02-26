'use server'

import { createClient } from '@/lib/supabase/server'
import { runApifyActor } from '@/lib/external'
import { trackVendorUsage } from '@/lib/vendor-tracking'
import { analyzeLead, analyzePropertyImages } from '@/lib/ai'
import { processRawRecord } from '@/lib/lead-pipeline'

export async function scrapeCraigslist(params: {
  brokerageId: string
  targetCities: string[]
}) {
  const supabase = await createClient()
  const { brokerageId, targetCities } = params
  
  const results = {
    fsboListings: 0,
    housingWanted: 0,
    leadsCreated: 0,
    totalCost: 0,
    errors: [] as string[]
  }

  for (const city of targetCities) {
    try {
      const fsboResult = await runApifyActor('lukaskrivka/craigslist-scraper', {
        startUrls: [`https://${city.toLowerCase()}.craigslist.org/search/reo`],
        maxItems: 100,
        searchTerms: ['fsbo', 'for sale by owner']
      })

      results.totalCost += fsboResult.cost
      results.fsboListings += fsboResult.data.length

      for (const listing of fsboResult.data) {
        const textAnalysis = await analyzeLead({
          content: listing.description || listing.title || '',
          authorName: listing.contactName
        })

        let visionAnalysis = null
        if (listing.images && listing.images.length > 0) {
          try {
            visionAnalysis = await analyzePropertyImages(listing.images.slice(0, 5))
            results.totalCost += visionAnalysis.cost
          } catch (error) {
            console.error('[v0] Vision analysis failed:', error)
          }
        }

        const { data: rawRecord } = await supabase
          .from('batchdata_motivated_sellers_raw')
          .insert({
            first_name: null,
            last_name: null,
            email: listing.email || null,
            phone: listing.phone || null,
            property_address: listing.address,
            residential_city: city,
            motivation_type: 'fsbo',
            motivation_confidence: Math.round(textAnalysis.confidence * 100),
            raw_json: listing,
            created_at: new Date().toISOString()
          })
          .select('id')
          .single()

        if (rawRecord?.id) {
          const pipelineResult = await processRawRecord(rawRecord.id, brokerageId)
          
          if (pipelineResult.action === 'created') {
            results.leadsCreated++
          }

          await trackVendorUsage({
            vendorName: 'apify',
            usageType: 'craigslist_fsbo_scrape',
            unitsUsed: 1,
            costPerUnit: 0.50 / fsboResult.data.length,
            totalCost: 0.50 / fsboResult.data.length,
            leadId: pipelineResult.leadId,
            brokerageId,
            requestMetadata: { city, listingType: 'fsbo' }
          })

          if (visionAnalysis) {
            await trackVendorUsage({
              vendorName: 'openai',
              usageType: 'vision_analysis',
              unitsUsed: 1,
              costPerUnit: visionAnalysis.cost,
              totalCost: visionAnalysis.cost,
              leadId: pipelineResult.leadId,
              brokerageId,
              requestMetadata: { imageCount: listing.images?.length || 0 }
            })
          }
        }
      }

    } catch (error) {
      console.error(`[v0] Failed to scrape Craigslist for ${city}:`, error)
      results.errors.push(`Craigslist-${city}: ${String(error)}`)
    }
  }

  return {
    success: true,
    ...results
  }
}
