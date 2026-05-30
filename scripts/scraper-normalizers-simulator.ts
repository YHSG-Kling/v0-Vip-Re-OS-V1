/**
 * scripts/scraper-normalizers-simulator.ts
 *
 * Runnable unit tests for the three pure normalizers wired this turn:
 *   - lib/external/zenrows-normalizer          (HTML → structured)
 *   - lib/external/exa-intent-normalizer       (search result → intent + persona)
 *   - lib/external/batchdata-client (normalizeBatchDataProperty) — rich seller profile
 *
 * No I/O, no stubs of the units under test — exercises the real exported functions on synthetic
 * inputs and asserts the structural guarantees the downstream code relies on.
 */
import { normalizeZenRowsHtml } from "../lib/external/zenrows-normalizer"
import { normalizeExaIntentRow } from "../lib/external/exa-intent-normalizer"
import { normalizeBatchDataProperty } from "../lib/external/batchdata-client"

let pass = 0, fail = 0
const fails: string[] = []
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; fails.push(msg) } }

// ── ZenRows normalizer ─────────────────────────────────────────────────────
{
  const html = `
    <html><head>
      <title>Smith Family Home – 123 Main St Austin TX</title>
      <meta name="description" content="For Sale By Owner: 4 bed 2 bath colonial">
      <meta property="og:image" content="https://example.com/photo.jpg">
    </head><body>
      <p>Contact: <a rel="author">Jane Smith</a></p>
      <p>Email me at jane.smith@example.com or (512) 555-0188</p>
      <p>Asking $499,000 — also priced as $499K elsewhere</p>
      <p>Property: 123 Main St, Austin, TX 78701</p>
    </body></html>`
  const n = normalizeZenRowsHtml(html)
  ok(n.emails.includes("jane.smith@example.com"),                       "ZenRows: email extracted")
  ok(n.phones.includes("+15125550188"),                                 "ZenRows: phone normalized to +1XXXXXXXXXX")
  ok(n.addresses.some(a => a.includes("123 Main St")),                  "ZenRows: street address extracted")
  ok(n.prices.includes(499000),                                         "ZenRows: $499,000 + $499K dedup to one")
  ok(n.names.some(n => n === "Jane Smith"),                             "ZenRows: rel=author name extracted")
  ok(n.fsboMarker === true,                                             "ZenRows: FSBO marker detected")
  ok((n.pageTitle ?? "").includes("Smith Family Home"),                 "ZenRows: <title> extracted")
  ok((n.metaDescription ?? "").includes("For Sale By Owner"),           "ZenRows: meta description extracted")
  ok((n.ogImage ?? "").startsWith("https://"),                          "ZenRows: og:image extracted")
}

// ── Exa intent normalizer ──────────────────────────────────────────────────
{
  const buyer = normalizeExaIntentRow({
    id: "1", url: "https://example.com/a", title: "First-time buyer pre-approval in Austin",
    text: "I just got pre-approved and I'm searching for a home in 78701.",
    author: null, publishedDate: null, highlights: ["got pre-approved", "first-time home buyer"], summary: null,
  } as any)
  ok(buyer.intent === "buyer",                       "Exa: buyer intent wins")
  ok(buyer.persona === "first_time_buyer",           "Exa: first_time_buyer persona attached")
  ok(buyer.scores.buyer > buyer.scores.seller,       "Exa: buyer score > seller score")

  const seller = normalizeExaIntentRow({
    id: "2", url: "https://example.com/b", title: "Must sell my house in Phoenix",
    text: "FSBO — for sale by owner. Asking $325,000. 456 Oak Ave, Phoenix, AZ 85001",
    author: null, publishedDate: null,
  } as any)
  ok(seller.intent === "seller",                                    "Exa: seller intent wins")
  ok(seller.persona === "fsbo_seller" || seller.persona === "motivated_seller", "Exa: FSBO/motivated persona attached")
  ok(seller.propertyAddresses.some(a => a.includes("Oak Ave")),     "Exa: property address extracted")
  ok(seller.prices.includes(325000),                                "Exa: $325,000 price extracted")

  const investor = normalizeExaIntentRow({
    id: "3", url: "https://example.com/c", title: "1031 exchange options in Phoenix",
    text: "Looking for like-kind exchange replacement property — investor focus on cap rate and buy and hold.",
    author: null, publishedDate: null,
  } as any)
  ok(investor.intent === "investor",                                "Exa: investor intent wins")
  ok(investor.persona === "investor_1031" || investor.persona === "investor_buy_hold", "Exa: investor persona attached")

  const generic = normalizeExaIntentRow({
    id: "4", url: "https://example.com/d", title: "Local bakery opens downtown",
    text: "Nothing real-estate-related here.", author: null, publishedDate: null,
  } as any)
  ok(generic.intent === "generic",                                  "Exa: no real-estate signal → generic")
  ok(generic.persona === null,                                      "Exa: no persona on generic")
}

// ── BatchData rich profile ─────────────────────────────────────────────────
{
  const row = normalizeBatchDataProperty({
    address:   { street: "789 Pine Rd", city: "Dallas", state: "TX", zip: "75201" },
    owner:     { firstName: "Bob",    lastName: "Owner", phone: "+19725550199",
                 mailingAddress: { street: "PO Box 1", city: "Frisco", state: "TX", zip: "75033" } },
    building:  { bedroomCount: 4, bathroomCount: 3, livingAreaSquareFeet: 2400 },
    valuation: { estimatedValue: 625000, estimatedEquity: 420000, equityPercent: 67, lowValue: 600000, highValue: 650000 },
    mortgage:  { openLoanBalance: 205000, lenderName: "Wells Fargo", foreclosureStatus: "preforeclosure" },
    lastSale:  { date: "2017-04-12", price: 410000, type: "WARRANTY_DEED" },
    quickLists: ["preforeclosure", "high-equity", "absentee-owner"],
    ownershipLengthYears: 8,
    mailingAddressVacant: false,
    vacancy:   { isVacant: false },
  }, "pre_foreclosure")

  ok(row.firstName === "Bob",                                       "BD: owner first name")
  ok(row.address.includes("PO Box 1"),                              "BD: owner mailing > property when present")
  ok(row.propertyAddress === "789 Pine Rd",                         "BD: property address kept separately")
  ok(row.quickLists?.length === 3 && row.quickLists.includes("high-equity"), "BD: quickLists preserved")
  ok((row.valuation?.estimatedEquity ?? 0) === 420000,              "BD: equity dollars captured")
  ok((row.valuation?.equityPercent ?? 0) === 67,                    "BD: equity % captured")
  ok(row.mortgage?.lenderName === "Wells Fargo",                    "BD: lender name captured")
  ok(row.mortgage?.foreclosureStatus === "preforeclosure",          "BD: foreclosure status captured")
  ok(row.lastSale?.date === "2017-04-12",                           "BD: last sale date captured")
  ok(row.lastSale?.price === 410000,                                "BD: last sale price captured")
  ok(row.ownershipLengthYears === 8,                                "BD: ownership length captured")
  ok(row.motivationType === "pre_foreclosure",                      "BD: motivation type echoed")
}

console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log("  - " + f)) }
process.exit(fail === 0 ? 0 : 1)
