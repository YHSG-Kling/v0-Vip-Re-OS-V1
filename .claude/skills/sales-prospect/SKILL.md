# Full Prospect Analysis Orchestrator

You are the full prospect audit engine for `/sales prospect <url>`. You launch 5 parallel subagents, aggregate their results, and produce a unified PROSPECT-ANALYSIS.md report that is ready-to-use and deal-focused.

## When This Skill Is Invoked

The user runs `/sales prospect <url>`. This is the flagship command of the entire suite. It produces the most comprehensive deliverable: a scored, prioritized, actionable prospect analysis with a ready-to-send outreach email.

---

## Phase 1: Discovery (Sequential — Pre-Analysis)

Before launching subagents, perform these discovery steps sequentially. Every subsequent phase depends on this data.

### 1.1 Fetch the Target URL

Use `WebFetch` to retrieve the company homepage. Store the full content for subagent consumption.

If the homepage loads successfully, also fetch up to 5 key interior pages:
- About / Company page
- Team / Leadership page
- Pricing page
- Blog / Resources page
- Careers / Jobs page
- Contact page

For each page, store:
- Page URL
- Page title
- Raw content (text)
- Key data points extracted (names, numbers, product details)

**If the URL is unreachable:**
1. Report the error to the user: "Could not reach [url] — HTTP [status code]"
2. Attempt alternate URLs: try with/without www, try https vs http
3. If still unreachable, suggest the user verify the URL and try again
4. Do NOT proceed to Phase 2 if zero pages are accessible

### 1.2 Detect Company Type

Classify the prospect into one of these categories. This classification shapes every subagent's analysis focus and scoring calibration:

| Company Type | Detection Signals | Analysis Focus |
|--------------|-------------------|----------------|
| **SaaS/Software** | Free trial CTA, pricing tiers, feature pages, "login" link, API docs, developer documentation, integration marketplace | Tech stack, ARR signals, product-led growth, integration ecosystem, developer team size, churn indicators |
| **Agency/Services** | Case studies, portfolio, "work with us", client logos, testimonials, service packages, hourly/retainer pricing | Client roster quality, team size, service positioning, retainer vs project pricing, industry specialization |
| **E-commerce** | Product listings, cart/checkout, product categories, SKU counts, reviews, shipping info, return policy | Product catalog size, traffic signals, tech platform (Shopify, WooCommerce), revenue estimates, fulfillment model |
| **Enterprise** | Large employee count (500+), multiple office locations, compliance pages, procurement portal, partner ecosystem | Org structure, procurement process, budget cycles, compliance needs, vendor requirements, multi-stakeholder buying |
| **SMB** | Small team (1-50), owner-operator signals, local focus, simple pricing, limited product line | Budget constraints, quick ROI needs, ease of implementation, owner as decision maker, price sensitivity |
| **Startup** | "Backed by" investor logos, founding year recent, small team growing fast, beta/early access language, Y Combinator/accelerator badges | Funding stage, burn rate signals, growth trajectory, founding team background, product-market fit signals |

**Detection procedure:**
1. Scan homepage for signals from each category
2. Check careers page for employee count and hiring velocity
3. Check pricing page for pricing model complexity
4. Look for investor/funding mentions
5. Assign the best-fit category (if ambiguous, note the two most likely categories)

### 1.3 Extract Key Pages and Site Architecture

Map the site architecture to identify all pages relevant to sales intelligence:

| Page Type | Common URLs | Data to Extract |
|-----------|-------------|-----------------|
| **Homepage** | / | Headline, value prop, CTAs, social proof, product positioning |
| **About** | /about, /company, /about-us | Founding story, mission, team size, locations, history |
| **Team** | /team, /leadership, /about/team, /people | Names, titles, photos, bios, LinkedIn links |
| **Pricing** | /pricing, /plans, /packages | Tiers, prices, features per tier, enterprise CTA |
| **Blog** | /blog, /resources, /insights, /news | Recent topics, posting frequency, content depth |
| **Careers** | /careers, /jobs, /join-us, /hiring | Open roles, team sizes by department, growth signals |
| **Contact** | /contact, /get-in-touch, /demo | Contact forms, phone numbers, office addresses |
| **Products** | /products, /features, /solutions, /platform | Product lines, features, use cases, integrations |
| **Customers** | /customers, /case-studies, /testimonials | Customer logos, case study details, industry verticals served |
| **Partners** | /partners, /integrations, /ecosystem | Technology partners, integration depth, ecosystem maturity |

### 1.4 Identify Industry Vertical

Determine the prospect's primary industry vertical from these categories:

- Technology / Software
- Financial Services / Fintech
- Healthcare / Healthtech
- Education / Edtech
- E-commerce / Retail
- Manufacturing / Industrial
- Media / Entertainment
- Real Estate / Proptech
- Professional Services / Consulting
- Marketing / Advertising
- Logistics / Supply Chain
- Energy / Cleantech
- Food / Hospitality
- Non-profit / Government
- Other (specify)

**Detection signals:** Industry-specific terminology, customer logos, case study industries, job posting requirements, compliance mentions, regulatory references.

### 1.5 Run Structured Data Extraction

Execute the Python analysis script for machine-readable data extraction:

```bash
python3 scripts/analyze_prospect.py --url <url> --output json
```

This script extracts:
- Structured company metadata
- Technology stack detection
- Social media profile links
- Contact information patterns
- SEO and traffic signals

**If the script is not available or fails:**
1. Log the error but continue the analysis
2. Perform manual extraction using WebFetch data
3. Note in the report that automated extraction was unavailable

### 1.6 Compile Discovery Briefing

Before launching subagents, compile a discovery briefing object containing:

```
DISCOVERY BRIEFING
==================
URL: [target url]
Company Name: [detected name]
Company Type: [SaaS/Agency/E-commerce/Enterprise/SMB/Startup]
Industry Vertical: [detected vertical]
Key Pages Found: [list of accessible pages with URLs]
Homepage Content: [stored content]
Team Page Content: [stored content or "not found"]
Pricing Page Content: [stored content or "not found"]
Blog Content: [stored content or "not found"]
Careers Content: [stored content or "not found"]
Script Output: [JSON data or "unavailable"]
Initial Signals: [key observations from discovery]
```

This briefing is passed to every subagent as context.

---

## Phase 2: Parallel Analysis (5 Subagents Simultaneously)

Launch all 5 subagents simultaneously using Claude Code's Task tool. Each subagent receives the full discovery briefing. All subagents run with `subagent_type: "general-purpose"`.

**CRITICAL:** Launch all 5 in parallel. Do NOT run them sequentially. Each subagent is independent and does not depend on the others.

### Subagent 1: sales-company (Company Research & Firmographics)

**Skill file:** `skills/sales-research/SKILL.md`
**Weight:** 25% of Prospect Score
**Focus:** Company research, firmographics, financial signals, growth trajectory

**Task prompt must include:**
- The full discovery briefing
- Instruction to produce a Company Fit Score (0-100)
- Instruction to return structured data: company name, founding date, employee count, funding total, revenue estimate, growth rate, tech stack, key strengths, key risks

**Expected output:** Company Fit Score (0-100) with breakdown across:
- Size fit (0-20): Is the company the right size for your solution?
- Industry fit (0-20): Is the industry a match for your ideal customer profile?
- Growth trajectory (0-20): Is the company growing, stable, or declining?
- Tech sophistication (0-20): Does their tech stack suggest readiness for your solution?
- Budget signals (0-20): Are there signals of adequate budget?

### Subagent 2: sales-contacts (Decision Maker Intelligence)

**Skill file:** `skills/sales-contacts/SKILL.md`
**Weight:** 20% of Prospect Score
**Focus:** Decision maker identification, org chart mapping, personalization anchors

**Task prompt must include:**
- The full discovery briefing
- Instruction to produce a Contact Access Score (0-100)
- Instruction to return structured data: buying committee map (name, title, role, personalization anchor), org chart, top 3 priority contacts, multi-threading strategy

**Expected output:** Contact Access Score (0-100) with breakdown across:
- Decision makers identified (0-25): How many key decision makers were found?
- Contact info accessibility (0-25): Can you reach them (email patterns, LinkedIn, etc.)?
- Personalization anchors (0-25): Quality of personalization hooks found per contact
- Warm paths available (0-25): Shared connections, communities, mutual contacts

### Subagent 3: sales-opportunity (Opportunity & Budget Assessment)

**Skill file:** `skills/sales-qualify/SKILL.md`
**Weight:** 20% of Prospect Score
**Focus:** Lead qualification (BANT + MEDDIC), pain point detection, budget signals, buying timeline

**Task prompt must include:**
- The full discovery briefing
- Instruction to produce an Opportunity Quality Score (0-100)
- Instruction to return structured data: BANT scorecard, MEDDIC assessment, buying signals, red flags, recommended approach

**Expected output:** Opportunity Quality Score (0-100) with breakdown across:
- Budget signals (0-25): Evidence of budget availability
- Authority mapped (0-25): Clarity on who decides and how
- Need confirmed (0-25): Strength of pain point evidence
- Timeline urgency (0-25): Signals of near-term buying intent

### Subagent 4: sales-competitive (Competitive Positioning)

**Skill file:** `skills/sales-competitors/SKILL.md` (if available) or general-purpose competitive analysis
**Weight:** 15% of Prospect Score
**Focus:** Current solutions the prospect uses, switching costs, competitive gaps, positioning strategy

**Task prompt must include:**
- The full discovery briefing
- Instruction to produce a Competitive Position Score (0-100)
- Instruction to analyze: current vendor signals, technology stack, switching costs, competitive vulnerabilities, positioning angles

**Expected output:** Competitive Position Score (0-100) with breakdown across:
- Current vendor identified (0-25): Do we know what they use today?
- Switching cost assessment (0-25): How hard would it be to switch? (Low cost = high score)
- Competitive gaps (0-25): Are there gaps in their current solution we can exploit?
- Win probability (0-25): Based on competitive dynamics, how likely are we to win?

**Research methodology for the competitive subagent:**
1. Scan the prospect's website for technology signals (built-with indicators, integration mentions, vendor logos)
2. Check job postings for tool/platform requirements (e.g., "Salesforce experience required")
3. Search for the prospect company name alongside competitor product names
4. Look for review or case study mentions that reveal their current stack
5. Analyze their tech requirements from careers page
6. Search web for "[prospect name] uses [competitor]" or "[prospect name] partnered with [vendor]"

### Subagent 5: sales-strategy (Outreach Strategy & Messaging)

**Skill file:** `skills/sales-outreach/SKILL.md`
**Weight:** 20% of Prospect Score
**Focus:** Outreach strategy, messaging, channel selection, first email draft

**Task prompt must include:**
- The full discovery briefing
- Instruction to produce an Outreach Readiness Score (0-100)
- Instruction to return: recommended outreach framework, personalization research, channel strategy, first email draft, objection preparation

**Expected output:** Outreach Readiness Score (0-100) with breakdown across:
- Personalization depth (0-25): Quality and quantity of personalization anchors
- Trigger events found (0-25): Recent events that create natural outreach timing
- Channel strategy clarity (0-25): Clear path to reach decision makers
- Message-market fit (0-25): Strength of the value proposition match

---

## Phase 3: Synthesis (Sequential — Aggregation and Scoring)

After all 5 subagents complete, aggregate their results into the final analysis.

### 3.1 Handle Subagent Failures

If any subagent fails or times out:
1. Note the failure in the report: "[Agent name] analysis unavailable — [reason]"
2. Assign a neutral score of 50 for that category
3. Reduce confidence level of the overall Prospect Score
4. Continue with all available data
5. Recommend manual follow-up for the failed analysis area

### 3.2 Calculate Prospect Score (0-100)

Compute the composite Prospect Score using the weighted formula:

```
Prospect Score = (
    Company_Fit      * 0.25 +
    Contact_Access   * 0.20 +
    Opportunity_Quality * 0.20 +
    Competitive_Position * 0.15 +
    Outreach_Readiness  * 0.20
)
```

**Score interpretation:**

| Score Range | Grade | Label | Meaning | Recommended Action |
|-------------|-------|-------|---------|-------------------|
| 90-100 | A+ | Hot Lead | Exceptional fit across all dimensions. High close probability. | Prioritize immediately. Assign senior rep. Multi-thread outreach within 24 hours. |
| 75-89 | A | Strong Prospect | Strong fit with minor gaps. Worth significant sales investment. | Begin personalized outreach within 48 hours. Invest in deep research. |
| 60-74 | B | Qualified Lead | Good fit but notable gaps. Standard sales approach warranted. | Add to active pipeline. Begin standard outreach sequence. Monitor for trigger events. |
| 40-59 | C | Lukewarm | Mixed signals. Some fit indicators but significant concerns. | Nurture with value-add content. Do not hard sell. Re-evaluate in 30-60 days. |
| 0-39 | D | Poor Fit | Fundamental misalignment on multiple dimensions. | Deprioritize. Add to long-term nurture only if one dimension scores above 70. |

### 3.3 Generate Prioritized Action Plan

Based on the Prospect Score and subagent findings, create a three-tier action plan:

**Immediate Actions (Next 24-48 Hours):**
- Specific outreach actions to take right now
- Decision makers to connect with on LinkedIn
- Content to share or engage with
- Internal preparation (CRM notes, team briefing)
- List 3-5 specific actions with assigned priority

**Short-Term Actions (Next 1-2 Weeks):**
- Follow-up sequence to execute
- Additional research to conduct
- Stakeholders to engage (multi-threading)
- Competitive positioning to prepare
- List 3-5 specific actions with timeline

**Long-Term Actions (Next 1-3 Months):**
- Relationship-building activities
- Content nurture strategy
- Event or conference opportunities
- Partnership or referral approaches
- List 2-3 specific actions with milestones

### 3.4 Create Ready-to-Use First Email

Using the outreach strategy subagent's findings, craft the actual first outreach email. This must be:
- Copy-paste ready (not a template with placeholders)
- Personalized to the specific prospect (reference real data found during research)
- Under 100 words in the body
- Using one of the four outreach frameworks from the sales-outreach skill
- With a clear, low-friction CTA
- With 2 subject line options for A/B testing
- With the specific send target (name, title, company)

### 3.5 Confidence Assessment

Rate the overall confidence of the analysis:

| Confidence Level | Criteria |
|-----------------|---------|
| **High** | All 5 subagents completed successfully. Rich public data available. Multiple data sources confirmed findings. |
| **Medium** | 4 of 5 subagents completed. Moderate public data. Some findings based on inference. |
| **Low** | 3 or fewer subagents completed. Limited public data. Significant reliance on inference. |
| **Very Low** | Major data gaps. Most findings are speculative. Recommend manual research before outreach. |

---

## Output Format: PROSPECT-ANALYSIS.md

Write the final report to `PROSPECT-ANALYSIS.md` in the current directory with this exact structure:

```markdown
# Prospect Analysis: [Company Name]
**URL:** [url]
**Date:** [current date]
**Company Type:** [detected type]
**Industry:** [detected vertical]
**Prospect Score: [X]/100 (Grade: [letter grade] — [label])**
**Confidence:** [High/Medium/Low/Very Low]

---

## Executive Summary

[3-5 paragraph summary for a sales leader. Lead with the Prospect Score and grade.
Highlight the single biggest opportunity, the single biggest risk, and the
recommended approach. Include the top decision maker to target and the
recommended outreach timing. End with a clear go/no-go recommendation
and expected deal timeline.]

---

## Prospect Snapshot

| Dimension | Value |
|-----------|-------|
| **Company** | [name] |
| **Website** | [url] |
| **Industry** | [vertical] |
| **Company Type** | [SaaS/Agency/E-commerce/Enterprise/SMB/Startup] |
| **Founded** | [year] |
| **Employees** | [count or estimate] |
| **Funding** | [total or "Bootstrapped" or "Public"] |
| **Revenue Est.** | [estimate range] |
| **HQ Location** | [city, state/country] |
| **Key Decision Maker** | [name, title] |
| **Prospect Score** | [X]/100 ([grade]) |
| **Recommended Action** | [one-line action] |

---

## Score Breakdown

| Category | Score | Weight | Weighted | Key Finding |
|----------|-------|--------|----------|-------------|
| Company Fit | [X]/100 | 25% | [X] | [one-line finding] |
| Contact Access | [X]/100 | 20% | [X] | [one-line finding] |
| Opportunity Quality | [X]/100 | 20% | [X] | [one-line finding] |
| Competitive Position | [X]/100 | 15% | [X] | [one-line finding] |
| Outreach Readiness | [X]/100 | 20% | [X] | [one-line finding] |
| **TOTAL** | | **100%** | **[X]/100** | |

---

## Company Profile

[Full company research findings from the sales-company subagent.
Include: overview, business model, product/technology, funding history,
market position, recent developments. Cite specific sources.]

---

## Decision Maker Map

### Buying Committee

| Name | Title | Buying Role | Personalization Anchor | Approach Strategy |
|------|-------|-------------|----------------------|-------------------|
| [name] | [title] | [Economic Buyer/Champion/Technical Evaluator/End User/Blocker] | [specific anchor] | [1-line strategy] |

### Org Chart (Text-Based)

```
[CEO Name] — CEO
├── [CTO Name] — CTO (Technical Evaluator)
│   ├── [VP Eng] — VP Engineering
│   └── [Dir Product] — Director of Product
├── [CRO Name] — CRO (Economic Buyer)
│   └── [VP Sales] — VP Sales (Champion)
└── [CMO Name] — CMO
    └── [Dir Marketing] — Director of Marketing
```

### Top 3 Priority Contacts

[Detailed profile for each: name, title, role in buying process,
LinkedIn summary, recent activity, personalization anchors,
recommended approach, suggested first message]

---

## Opportunity Assessment

### BANT Scorecard

| Dimension | Score | Evidence | Confidence |
|-----------|-------|----------|------------|
| Budget | [X]/25 | [specific evidence] | [High/Medium/Low] |
| Authority | [X]/25 | [specific evidence] | [High/Medium/Low] |
| Need | [X]/25 | [specific evidence] | [High/Medium/Low] |
| Timeline | [X]/25 | [specific evidence] | [High/Medium/Low] |
| **Total** | **[X]/100** | | |

### MEDDIC Assessment

| Element | Finding | Evidence | Confidence |
|---------|---------|----------|------------|
| Metrics | [what metrics matter to them] | [source] | [level] |
| Economic Buyer | [who] | [source] | [level] |
| Decision Criteria | [what factors] | [source] | [level] |
| Decision Process | [how they buy] | [source] | [level] |
| Identify Pain | [specific pain points] | [source] | [level] |
| Champion | [potential champion] | [source] | [level] |

### Buying Signals Detected
[Bulleted list of positive buying signals with evidence]

### Red Flags
[Bulleted list of concerns or risks with evidence]

---

## Competitive Landscape

### Current Solutions Detected
[What tools/vendors the prospect currently uses, with evidence]

### Switching Cost Assessment
[Analysis of how difficult it would be for them to switch]

### Competitive Positioning Angles
[How to position against their current solution. Key differentiators to emphasize.
Weaknesses of their current solution to highlight.]

---

## Recommended Outreach Strategy

### Selected Framework
[Which of the 4 outreach frameworks was selected and why]

### Channel Strategy
[Primary and secondary channels. LinkedIn + email timing.]

### Personalization Research
[All personalization anchors found: trigger events, personal interests,
shared connections, recent content, career milestones]

### Objection Preparation
[Top 3 likely objections and prepared responses]

---

## Prioritized Action Plan

### Immediate (Next 24-48 Hours)
1. [Specific action with details]
2. [Specific action with details]
3. [Specific action with details]

### Short-Term (Next 1-2 Weeks)
1. [Specific action with details]
2. [Specific action with details]
3. [Specific action with details]

### Long-Term (Next 1-3 Months)
1. [Specific action with details]
2. [Specific action with details]

---

## Ready-to-Send First Email

**To:** [Name], [Title] at [Company]
**Subject Line A:** [subject]
**Subject Line B:** [subject]

---

[Full email body — copy-paste ready, under 100 words,
personalized with real data from the research]

---

**CTA:** [specific ask]
**Send Timing:** [recommended day/time]
**Follow-Up:** [when and how to follow up if no response]

---

*Generated by AI Sales Team — `/sales prospect`*
```

---

## Terminal Output

In addition to the file, display a condensed scorecard in the terminal:

```
============================================
  PROSPECT ANALYSIS COMPLETE
============================================

Company:  [name] ([type])
Industry: [vertical]
URL:      [url]

Prospect Score: [X]/100 (Grade: [letter] — [label])
Confidence:     [High/Medium/Low]

Score Breakdown:
  Company Fit:         [XX]/100 ████████░░
  Contact Access:      [XX]/100 ██████░░░░
  Opportunity Quality: [XX]/100 ███████░░░
  Competitive Position:[XX]/100 █████░░░░░
  Outreach Readiness:  [XX]/100 ████████░░

Key Decision Maker: [Name], [Title]

Top 3 Opportunities:
  1. [opportunity]
  2. [opportunity]
  3. [opportunity]

Top 3 Risks:
  1. [risk]
  2. [risk]
  3. [risk]

Next Step: [single most important action]

Full report saved to: PROSPECT-ANALYSIS.md
============================================
```

**Bar chart rendering rules:**
- Each bar is 10 characters wide
- Score 0-10 = 1 filled block, 11-20 = 2 filled blocks, etc.
- Use Unicode block characters: filled = `\u2588`, empty = `\u2591`
- Align all bars and labels for clean terminal display

---

## Error Handling

### URL Unreachable
1. Try alternate URL formats (www/non-www, http/https)
2. If all fail, report error and stop: "Could not reach [url]. Please verify the URL and try again."
3. Do NOT generate a report based on zero data

### Subagent Failure
1. Log which subagent failed and why
2. Assign neutral score (50) for that category
3. Add a note in the report: "[Category] analysis unavailable — neutral score assigned"
4. Reduce overall confidence by one level
5. Continue with remaining subagent data

### Site Behind Authentication
1. Note what was publicly accessible
2. Analyze only the public pages
3. Add a note: "Site requires authentication. Analysis limited to publicly accessible pages."
4. Recommend manual review of gated content
5. Reduce confidence level accordingly

### Minimal Content Site
1. If fewer than 3 pages are accessible, note "Limited site content"
2. Supplement with WebSearch for external data (Crunchbase, LinkedIn, news)
3. Adjust confidence to Low or Very Low
4. Recommend additional manual research

---

## Cross-Skill Integration

- If `COMPANY-RESEARCH.md` exists in the current directory, incorporate its findings instead of running the sales-company subagent from scratch
- If `DECISION-MAKERS.md` exists, incorporate its findings into the contact analysis
- If `LEAD-QUALIFICATION.md` exists, incorporate its findings into the opportunity assessment
- If `COMPETITIVE-INTEL.md` exists, incorporate its findings into the competitive landscape
- If `OUTREACH-SEQUENCE.md` exists, reference it in the outreach strategy section
- Suggest follow-up commands: `/sales outreach` for full email sequence, `/sales prep` for meeting preparation, `/sales proposal` for deal-specific proposal
