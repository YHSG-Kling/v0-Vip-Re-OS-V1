// OSINT (Open Source Intelligence) Client
// Searches public records, court records, social profiles, property records

import { ZenrowsClient } from "./zenrows-client"
import * as cheerio from "cheerio"

/** A single distressed-seller court/public-records filing discovered by territory. */
export interface CourtFiling {
  firstName: string | null
  lastName: string | null
  recordType: string
  county: string | null
  caseNumber: string | null
  date: string | null
}

/** Court/public-record filing types that signal a motivated SELLER. */
export const DISTRESS_RECORD_TYPES = [
  "divorce",
  "probate",
  "estate",
  "foreclosure",
  "pre_foreclosure",
  "tax_lien",
  "eviction",
  "bankruptcy",
  "building_permit", // major remodel/addition → equity built, often pre-sale
  "code_violation",  // distressed owner, deferred maintenance
  "obituary",        // probate-adjacent estate sale (decedent's property)
] as const

/**
 * Public-record filing types that signal a BUYER. Marriage licenses → new
 * household formation (first-home buyers); new-mover / relocation records →
 * inbound buyers. OSINT captures both sides of online + public-records behavior.
 */
export const BUYER_RECORD_TYPES = [
  "marriage",
  "new_mover",
  "relocation",
] as const

/** Buyer vs seller classification for a record type. */
export function recordTypeIntent(recordType: string): "buyer" | "seller" {
  return (BUYER_RECORD_TYPES as readonly string[]).includes(recordType) ? "buyer" : "seller"
}

export const ALL_RECORD_TYPES = [...DISTRESS_RECORD_TYPES, ...BUYER_RECORD_TYPES] as const

/**
 * Pure parser: extract individual filing rows (party name + type + county/date)
 * from a court-records search results page. Defensive across common result-row
 * structures; returns only rows with at least a party name. No network.
 */
export function parseTerritoryCourtRecords(html: string, recordType: string): CourtFiling[] {
  const $ = cheerio.load(html)
  const filings: CourtFiling[] = []

  $('.result, .case-result, [class*="case-row"], [class*="record-row"], li.result-row, tr.case').each((_, el) => {
    const block = $(el)
    const name = block
      .find('.case-name, .party-name, [class*="name"], h3, h4, a')
      .first()
      .text()
      .trim()
    if (!name || name.length < 3) return

    const county = block.find('.county, [class*="county"], .court').first().text().trim() || null
    const caseNumber = block.find('.case-number, [class*="case-no"], [class*="docket"]').first().text().trim() || null
    const date = block.find('.date, [class*="filed"], time').first().text().trim() || null

    // "Last, First" or "First Last"
    let firstName: string | null = null
    let lastName: string | null = null
    if (name.includes(",")) {
      const [ln, fn] = name.split(",").map((s) => s.trim())
      lastName = ln || null
      firstName = (fn ?? "").split(/\s+/)[0] || null
    } else {
      const parts = name.split(/\s+/).filter(Boolean)
      firstName = parts[0] ?? null
      lastName = parts.length > 1 ? parts[parts.length - 1] : null
    }

    filings.push({ firstName, lastName, recordType, county, caseNumber, date })
  })

  return filings
}

export class OSINTClient {
  private zenrows: ZenrowsClient

  constructor() {
    this.zenrows = new ZenrowsClient()
  }

  async searchPerson(data: {
    firstName: string
    lastName: string
    city?: string
    state?: string
    email?: string
    phone?: string
  }): Promise<{
    social_profiles: Array<{ platform: string; url: string; username?: string }>
    public_records: Array<{ type: string; source: string; data: any }>
    court_records: Array<{ type: string; date?: string; county?: string; case_number?: string }>
    property_records: Array<{ address: string; ownership_type: string; acquired_date?: string }>
    life_events: Array<{ event: string; date?: string; source: string }>
    confidence_score: number
  }> {
    const results = {
      social_profiles: [] as Array<{ platform: string; url: string; username?: string }>,
      public_records: [] as Array<{ type: string; source: string; data: any }>,
      court_records: [] as Array<{ type: string; date?: string; county?: string; case_number?: string }>,
      property_records: [] as Array<{ address: string; ownership_type: string; acquired_date?: string }>,
      life_events: [] as Array<{ event: string; date?: string; source: string }>,
      confidence_score: 0,
    }

    const searchName = `${data.firstName} ${data.lastName}`
    const searchLocation = data.city && data.state ? `${data.city}, ${data.state}` : ""

    // Run all OSINT searches in parallel
    const [socialResults, publicRecordsResults, courtResults, propertyResults] = await Promise.all([
      this.searchSocialProfiles(searchName, data.email),
      this.searchPublicRecords(searchName, searchLocation),
      this.searchCourtRecords(searchName, data.state),
      this.searchPropertyRecords(searchName, searchLocation),
    ])

    results.social_profiles = socialResults
    results.public_records = publicRecordsResults.records
    results.court_records = courtResults
    results.property_records = propertyResults.properties
    results.life_events = [...publicRecordsResults.life_events, ...propertyResults.life_events]

    // Calculate confidence score based on data found
    let score = 0
    if (results.social_profiles.length > 0) score += 20
    if (results.public_records.length > 0) score += 25
    if (results.property_records.length > 0) score += 30
    if (results.court_records.length > 0) score += 15
    if (data.email) score += 5
    if (data.phone) score += 5
    results.confidence_score = Math.min(score, 100)

    return results
  }

  private async searchSocialProfiles(
    name: string,
    email?: string,
  ): Promise<Array<{ platform: string; url: string; username?: string }>> {
    const profiles: Array<{ platform: string; url: string; username?: string }> = []

    // Search common social platforms using ZenRows
    const platforms = [
      { name: "linkedin", url: `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(name)}` },
      { name: "facebook", url: `https://www.facebook.com/search/people/?q=${encodeURIComponent(name)}` },
      { name: "twitter", url: `https://twitter.com/search?q=${encodeURIComponent(name)}&f=user` },
    ]

    for (const platform of platforms) {
      try {
        const result = await this.zenrows.scrape(platform.url, { js_render: true })
        if (result.success && result.html) {
          // Parse HTML to find profile links
          const profileMatch = this.extractProfileFromHtml(result.html, platform.name)
          if (profileMatch) {
            profiles.push({
              platform: platform.name,
              url: profileMatch.url,
              username: profileMatch.username,
            })
          }
        }
      } catch (error) {
        console.error(`[OSINT] Error searching ${platform.name}:`, error)
      }
    }

    return profiles
  }

  private async searchPublicRecords(
    name: string,
    location: string,
  ): Promise<{
    records: Array<{ type: string; source: string; data: any }>
    life_events: Array<{ event: string; date?: string; source: string }>
  }> {
    const records: Array<{ type: string; source: string; data: any }> = []
    const life_events: Array<{ event: string; date?: string; source: string }> = []

    // Search public records aggregators
    const searchUrls = [
      `https://www.whitepages.com/name/${encodeURIComponent(name.replace(/ /g, "-"))}/${encodeURIComponent(location.replace(/, /g, "-").replace(/ /g, "-"))}`,
      `https://www.truepeoplesearch.com/results?name=${encodeURIComponent(name)}&citystatezip=${encodeURIComponent(location)}`,
    ]

    for (const url of searchUrls) {
      try {
        const result = await this.zenrows.scrape(url, { js_render: true, premium_proxy: true })
        if (result.success && result.html) {
          const parsed = this.parsePublicRecordsHtml(result.html)
          records.push(...parsed.records)
          life_events.push(...parsed.life_events)
        }
      } catch (error) {
        console.error(`[OSINT] Error searching public records:`, error)
      }
    }

    return { records, life_events }
  }

  private async searchCourtRecords(
    name: string,
    state?: string,
  ): Promise<Array<{ type: string; date?: string; county?: string; case_number?: string }>> {
    const courtRecords: Array<{ type: string; date?: string; county?: string; case_number?: string }> = []

    if (!state) return courtRecords

    // Search state court records (PACER for federal, state-specific for state courts)
    // This is a simplified implementation - real implementation would use state court APIs
    try {
      const searchUrl = `https://www.judyrecords.com/record?ln=${encodeURIComponent(name)}&state=${state}`
      const result = await this.zenrows.scrape(searchUrl, { js_render: true })

      if (result.success && result.html) {
        // Parse court record results
        // Look for: divorce, bankruptcy, foreclosure, liens, judgments
        const records = this.parseCourtRecordsHtml(result.html)
        courtRecords.push(...records)
      }
    } catch (error) {
      console.error(`[OSINT] Error searching court records:`, error)
    }

    return courtRecords
  }

  private async searchPropertyRecords(
    name: string,
    location: string,
  ): Promise<{
    properties: Array<{ address: string; ownership_type: string; acquired_date?: string }>
    life_events: Array<{ event: string; date?: string; source: string }>
  }> {
    const properties: Array<{ address: string; ownership_type: string; acquired_date?: string }> = []
    const life_events: Array<{ event: string; date?: string; source: string }> = []

    // Search county assessor records
    try {
      const searchUrl = `https://www.propertyshark.com/mason/text/Search.html?SearchType=&Source=&Term=${encodeURIComponent(name)}&searchAddress=&city=${encodeURIComponent(location)}`
      const result = await this.zenrows.scrape(searchUrl, { js_render: true, premium_proxy: true })

      if (result.success && result.html) {
        const parsed = this.parsePropertyRecordsHtml(result.html)
        properties.push(...parsed.properties)

        // Detect life events from property records
        for (const prop of parsed.properties) {
          if (prop.ownership_type === "foreclosure") {
            life_events.push({ event: "foreclosure_filing", source: "property_records" })
          }
          if (prop.ownership_type === "probate") {
            life_events.push({ event: "inheritance", source: "property_records" })
          }
        }
      }
    } catch (error) {
      console.error(`[OSINT] Error searching property records:`, error)
    }

    return { properties, life_events }
  }

  private extractProfileFromHtml(html: string, platform: string): { url: string; username?: string } | null {
    // Simplified extraction - real implementation would use cheerio
    const patterns: Record<string, RegExp> = {
      linkedin: /href="(https:\/\/www\.linkedin\.com\/in\/[^"]+)"/,
      facebook: /href="(https:\/\/www\.facebook\.com\/[^"?]+)"/,
      twitter: /href="(https:\/\/twitter\.com\/[^"?]+)"/,
    }

    const pattern = patterns[platform]
    if (!pattern) return null

    const match = html.match(pattern)
    if (match) {
      const url = match[1]
      const username = url.split("/").pop()
      return { url, username }
    }

    return null
  }

  private parsePublicRecordsHtml(html: string): {
    records: Array<{ type: string; source: string; data: any }>
    life_events: Array<{ event: string; date?: string; source: string }>
  } {
    // Simplified parsing - real implementation would use cheerio
    const records: Array<{ type: string; source: string; data: any }> = []
    const life_events: Array<{ event: string; date?: string; source: string }> = []

    // Look for indicators of life events in the HTML
    if (html.toLowerCase().includes("divorce")) {
      life_events.push({ event: "divorce", source: "public_records" })
    }
    if (html.toLowerCase().includes("bankruptcy")) {
      life_events.push({ event: "bankruptcy", source: "public_records" })
    }
    if (html.toLowerCase().includes("deceased") || html.toLowerCase().includes("death")) {
      life_events.push({ event: "death_in_family", source: "public_records" })
    }

    return { records, life_events }
  }

  private parseCourtRecordsHtml(
    html: string,
  ): Array<{ type: string; date?: string; county?: string; case_number?: string }> {
    const records: Array<{ type: string; date?: string; county?: string; case_number?: string }> = []

    // Look for common court record types. We do NOT have a real date extracted
    // from the page, so we leave `date` undefined rather than stamping today's
    // date — a fabricated "today" would make a stale or unknown court event look
    // current and pollute recency-based motivation scoring downstream.
    const courtTypes = ["divorce", "bankruptcy", "foreclosure", "eviction", "lien", "judgment"]
    for (const type of courtTypes) {
      if (html.toLowerCase().includes(type)) {
        records.push({ type })
      }
    }

    return records
  }

  private parsePropertyRecordsHtml(html: string): {
    properties: Array<{ address: string; ownership_type: string; acquired_date?: string }>
  } {
    // Simplified parsing - real implementation would use cheerio
    return { properties: [] }
  }

  /**
   * Territory-based distressed-seller discovery (auto sourcing, not enrichment).
   * Scrapes a public court-records aggregator for RECENT filings of each distress
   * type in a county/state and returns the parties as motivated-seller filings.
   * Used by lib/lead-pipeline/osint-sourcer.ts to feed raw_recruit/lead pipelines.
   */
  async searchCourtRecordsByTerritory(params: {
    county?: string | null
    state: string
    recordTypes?: readonly string[]
    limitPerType?: number
  }): Promise<{ filings: CourtFiling[]; cost: number }> {
    const types = params.recordTypes ?? ALL_RECORD_TYPES
    const filings: CourtFiling[] = []
    let cost = 0

    for (const recordType of types) {
      const q = `${recordType.replace(/_/g, " ")} ${params.county ?? ""}`.trim()
      const searchUrl = `https://www.judyrecords.com/?q=${encodeURIComponent(q)}&state=${encodeURIComponent(params.state)}`
      try {
        const result = await this.zenrows.scrape(searchUrl, { js_render: true })
        cost += result.cost ?? 0
        if (result.success && result.html) {
          const rows = parseTerritoryCourtRecords(result.html, recordType)
          filings.push(...rows.slice(0, params.limitPerType ?? 25))
        }
      } catch (error) {
        console.error(`[OSINT] Territory court search failed for ${recordType}:`, error)
      }
    }

    return { filings, cost }
  }
}
