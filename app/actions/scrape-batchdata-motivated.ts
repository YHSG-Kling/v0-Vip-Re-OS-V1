'use server'

import { createClient } from '@/lib/supabase/server'
import { fetchMotivatedSellers } from '@/lib/external'
import { trackVendorUsage } from '@/lib/vendor-tracking'
import { processRawRecord } from '@/lib/lead-pipeline'

const MOTIVATION_TYPES = [
  'probate',
  'divorce',
  'foreclosure',
  'tax_lien',
  'pre_foreclosure',
  'distressed',
]

export async function scrapeBatchDataMotivated(params: {
  brokerageId: string
  states: string[]
  limitPerType?: number
}) {
  const supabase = await createClient()
  const { brokerageId, states, limitPerType = 100 } = params
  
  const results = {
    totalRecords: 0,
    leadsCreated: 0,
    leadsMerged: 0,
    leadsSkipped: 0,
    totalCost: 0,
    errors: [] as string[]
  }

  for (const state of states) {
    for (const motivationType of MOTIVATION_TYPES) {
      try {
        const batchDataResult = await fetchMotivatedSellers({
          state,
          motivationTypes: [motivationType],
          limit: limitPerType
        })

        results.totalCost += batchDataResult.cost
        results.totalRecords += batchDataResult.records.length

        for (const record of batchDataResult.records) {
          const { data: rawRecord } = await supabase
            .from('batchdata_motivated_sellers_raw')
            .insert({
              first_name: record.firstName,
              last_name: record.lastName,
              email: record.email,
              phone: record.phone,
              residential_address: record.address,
              residential_city: record.city,
              residential_state: record.state,
              residential_zip: record.zip,
              property_address: record.propertyAddress || record.address,
              property_city: record.propertyCity || record.city,
              property_state: record.propertyState || record.state,
              property_zip: record.propertyZip || record.zip,
              property_beds: record.beds,
              property_baths: record.baths,
              property_sqft: record.sqft,
              property_estimated_value: record.estimatedValue,
              motivation_type: motivationType,
              motivation_confidence: record.motivationConfidence,
              raw_json: record as any,
              created_at: new Date().toISOString()
            })
            .select('id')
            .single()

          if (!rawRecord?.id) {
            results.errors.push(`Failed to insert raw record for ${record.firstName} ${record.lastName}`)
            continue
          }

          const pipelineResult = await processRawRecord(rawRecord.id, brokerageId)

          if (pipelineResult.action === 'created') {
            results.leadsCreated++
          } else if (pipelineResult.action === 'merged') {
            results.leadsMerged++
          } else if (pipelineResult.action === 'skipped') {
            results.leadsSkipped++
          }

          await trackVendorUsage({
            vendorName: 'batchdata',
            usageType: 'motivated_seller_list',
            unitsUsed: 1,
            costPerUnit: 0.05,
            totalCost: 0.05,
            leadId: pipelineResult.leadId,
            brokerageId,
            requestMetadata: { state, motivationType }
          })
        }

      } catch (error) {
        console.error(`[v0] Failed to fetch BatchData ${motivationType} for ${state}:`, error)
        results.errors.push(`${state}-${motivationType}: ${String(error)}`)
      }
    }
  }

  return {
    success: true,
    ...results
  }
}
