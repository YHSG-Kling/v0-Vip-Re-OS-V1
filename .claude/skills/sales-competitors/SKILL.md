# Sales Competitive Intelligence

You analyze what tools, services, and solutions a prospect currently uses and generate actionable battle cards for selling against each detected competitor. This is NOT a general market analysis — it is focused entirely on helping a salesperson WIN a deal against specific competitors that a specific prospect is currently using or evaluating.

## Invocation

```
/sales competitors <url>
```

Where `<url>` is the prospect company's website URL. The skill detects what the prospect currently uses and builds sales-focused battle cards for each detected solution.

## Step 1: Current Solution Detection

Execute all of the following detection methods in parallel using WebFetch and WebSearch. The goal is to identify every tool, service, platform, and vendor the prospect currently relies on that overlaps with or is adjacent to your offering.

### 1.1 Website Technology Analysis

Fetch the prospect's website and analyze:

- **HTML source inspection**: Look for script tags, meta tags, and link tags that reference known tools and platforms (e.g., analytics tools, CRM embeds, chat widgets, marketing automation pixels, tag managers, CDN providers)
- **Integration badges and partner logos**: Check the homepage, footer, integrations page, and partners page for logos of tools they use or integrate with
- **"Powered by" footers**: Many SaaS tools place a small badge or link in the footer of pages they power (e.g., help desks, landing pages, e-commerce platforms)
- **Technology stack signals**: Identify the website platform (WordPress, Webflow, Shopify, custom), hosting provider, CDN, email service provider, and other infrastructure choices
- **Login/portal pages**: Check for links to internal tools (e.g., "Login to Dashboard" that redirects to a known SaaS platform)
- **API documentation**: If they have a developer/API page, check what integrations they document — this reveals their stack

Record each detected technology with:
- Tool/platform name
- Evidence source (URL, page element, or signal that revealed it)
- Confidence level: High (explicit mention or badge), Medium (script tag or indirect reference), Low (inference from job posting or industry norm)

### 1.2 Job Posting Analysis

Search for the prospect's open job postings using WebSearch with queries like:
- "[Company Name] careers"
- "[Company Name] open jobs"
- "[Company Name] hiring"

Analyze job descriptions for:
- **Tool-specific requirements**: "Experience with Salesforce required" or "Proficiency in HubSpot"
- **Technology stack mentions**: Programming languages, frameworks, databases, cloud providers
- **Vendor certifications**: Certifications or training for specific platforms (e.g., "AWS Certified", "Salesforce Admin")
- **Process tool mentions**: Project management (Jira, Asana), communication (Slack, Teams), documentation (Notion, Confluence)

These are HIGH confidence signals — if a company requires experience with a tool in a job posting, they use that tool.

### 1.3 Case Study and Partnership Search

Search for the prospect appearing as a customer of known competitors:
- WebSearch: "[Company Name] case study [Competitor Name]"
- WebSearch: "[Company Name] customer story"
- WebSearch: "[Company Name] testimonial"

Check if the prospect:
- Appears on a competitor's website as a customer
- Has been quoted in a competitor's case study
- Is listed as a partner or integration partner of a competitor
- Has left reviews on competitor products

### 1.4 Review Site Search

Search G2, Capterra, and TrustRadius for reviews authored by employees of the prospect company:
- WebSearch: "site:g2.com [Company Name]"
- WebSearch: "site:capterra.com [Company Name]"
- WebSearch: "[Company Name] review [tool category]"

If reviews are found, note:
- Which products they reviewed (these are products they use)
- Satisfaction level (positive, mixed, negative)
- Specific complaints or praise mentioned in the review
- Review date (recent reviews are more relevant)

### 1.5 Tech Stack Detection Services

If available, check technology detection services:
- WebSearch: "site:builtwith.com [Company Domain]"
- WebSearch: "site:stackshare.io [Company Name]"
- WebSearch: "[Company Domain] technology stack"

These services catalog the technologies used by websites and can reveal tools not visible through direct inspection.

### 1.6 Social Signal Analysis

Search for company or employee posts mentioning specific tools:
- WebSearch: "[Company Name] [tool category] site:linkedin.com"
- WebSearch: "[Company Name] 'we use' OR 'switched to' OR 'implemented' [tool category]"

Look for:
- Blog posts about their technology choices
- LinkedIn posts from employees about tools they use
- Conference talks where they mention their stack
- Community forum posts asking for help with specific tools

---

## Step 2: Categorize Detected Solutions

Organize all detected solutions into categories relevant to the sales conversation:

| Category | Detected Solution | Confidence | Evidence |
|----------|------------------|------------|----------|
| CRM | [Tool name] | High/Med/Low | [Source] |
| Marketing Automation | [Tool name] | High/Med/Low | [Source] |
| Analytics | [Tool name] | High/Med/Low | [Source] |
| Customer Support | [Tool name] | High/Med/Low | [Source] |
| Project Management | [Tool name] | High/Med/Low | [Source] |
| Communication | [Tool name] | High/Med/Low | [Source] |
| [Other relevant categories] | ... | ... | ... |

Highlight the solutions that directly compete with or overlap with your offering — these are the ones that will get full battle cards.

---

## Step 3: Build Battle Cards

For each detected competitor or current solution that overlaps with your offering, build a complete battle card. Each battle card must be detailed enough for a salesperson to use in real-time during a call or meeting.

### Battle Card Format

For EACH detected competitor, generate:

```
## Battle Card: [Competitor Name]

### What the Prospect Uses Them For
[Specific description of how the prospect likely uses this tool, based on detection evidence]

### Competitor Strengths (Be Honest)
List 3-5 genuine strengths of this competitor. Credibility comes from accuracy — if you dismiss a strong competitor as weak, the prospect will not trust anything else you say.

1. [Strength 1] — [Why this matters to the prospect]
2. [Strength 2] — [Why this matters]
3. [Strength 3] — [Why this matters]
4. [Strength 4] — [Why this matters]
5. [Strength 5] — [Why this matters]

### Competitor Weaknesses (Specific, Not Generic)
List 3-5 specific weaknesses. "Bad customer support" is too generic. "Average ticket response time of 48 hours with no dedicated account manager for accounts under $50K ARR" is specific.

1. [Weakness 1] — [Specific evidence or commonly reported]
2. [Weakness 2] — [Specific evidence]
3. [Weakness 3] — [Specific evidence]
4. [Weakness 4] — [Specific evidence]
5. [Weakness 5] — [Specific evidence]

### Your Advantages Over This Competitor
For each advantage, provide a proof point (metric, case study, or testimonial).

1. [Advantage 1] — Proof: [Specific evidence]
2. [Advantage 2] — Proof: [Specific evidence]
3. [Advantage 3] — Proof: [Specific evidence]

### Their Advantages Over You (And How to Neutralize)
Be honest about where the competitor wins, and for each, explain how to neutralize or reframe it.

1. [Their advantage 1] — Neutralization: "[How to address this in conversation]"
2. [Their advantage 2] — Neutralization: "[How to address this]"
3. [Their advantage 3] — Neutralization: "[How to address this]"

### Switching Cost Assessment

| Factor | Assessment | Details |
|--------|-----------|---------|
| Technical migration | Low / Medium / High | [What needs to be migrated — data, integrations, configurations] |
| Financial cost | Low / Medium / High | [Contract obligations, sunk costs, migration services needed] |
| Organizational change | Low / Medium / High | [Retraining, process changes, stakeholder buy-in required] |
| Data portability | Easy / Moderate / Difficult | [Can they export their data? What format? What gets lost?] |
| Timeline estimate | [X weeks/months] | [Realistic migration timeline] |

### Switching Triggers
Events or situations that commonly cause customers to switch FROM this competitor TO your solution:

1. [Trigger 1] — e.g., "Contract renewal with a price increase"
2. [Trigger 2] — e.g., "Outgrowing the competitor's tier structure"
3. [Trigger 3] — e.g., "Key feature gap that blocks a new workflow"
4. [Trigger 4] — e.g., "New leadership wants to consolidate vendors"
5. [Trigger 5] — e.g., "Poor support experience during a critical incident"

### Landmine Questions
Questions to ask the prospect that expose this competitor's weaknesses WITHOUT directly bashing them. These questions let the prospect discover the gaps on their own.

1. "[Question 1]" — Exposes: [Which weakness this reveals]
2. "[Question 2]" — Exposes: [Which weakness this reveals]
3. "[Question 3]" — Exposes: [Which weakness this reveals]
4. "[Question 4]" — Exposes: [Which weakness this reveals]
5. "[Question 5]" — Exposes: [Which weakness this reveals]

### Trap to Avoid
What NOT to say about this competitor and why.

"NEVER say: [Specific statement to avoid]"
"WHY: [Reason — e.g., the prospect has a personal relationship with this vendor, this is a sensitive topic, this claim is easy to disprove]"

### Competitive Positioning Statement
One sentence that positions you against this specific competitor. This is NOT a tagline — it is a talking point for a sales conversation.

"While [Competitor] is [honest acknowledgment of their strength], [Your Company] [your specific differentiator] which means [specific outcome for the prospect]."
```

---

## Step 4: Feature Gap Analysis

Create a side-by-side feature comparison table for each major competitor detected. This should cover the features most relevant to the prospect's use case.

```
### Feature Comparison: [Your Solution] vs [Competitor 1] vs [Competitor 2]

| Feature | [Your Solution] | [Competitor 1] | [Competitor 2] |
|---------|----------------|----------------|----------------|
| [Feature 1] | [Yes/No/Partial — details] | [Yes/No/Partial — details] | [Yes/No/Partial — details] |
| [Feature 2] | [Details] | [Details] | [Details] |
| [Feature 3] | [Details] | [Details] | [Details] |
| [Key differentiator 1] | [Your strength] | [Their gap] | [Their gap] |
| [Key differentiator 2] | [Your strength] | [Their gap] | [Their gap] |
| [Their strength 1] | [Your gap or alternative] | [Their strength] | [Details] |
| Pricing model | [Your model] | [Their model] | [Their model] |
| Implementation time | [Your timeline] | [Their timeline] | [Their timeline] |
| Support model | [Your support] | [Their support] | [Their support] |
```

Rules for the feature comparison:
- Include features where you WIN and features where you LOSE — a one-sided comparison destroys credibility
- Use specific details, not just checkmarks — "Real-time with <100ms latency" is better than a checkmark
- If information about a competitor's feature is not verifiable, mark it as "Reported" or "Unverified"
- Organize features by importance to the prospect, not by what makes you look best

---

## Step 5: Win/Loss Pattern Recognition

Based on research and general market knowledge, identify common patterns in competitive deals:

### Win Patterns (Why You Beat This Competitor)

For each competitor, list the 3-5 most common reasons deals are WON against them:
```
1. [Win reason 1] — "We win when [specific situation or buyer profile]"
2. [Win reason 2] — "We win when [situation]"
3. [Win reason 3] — "We win when [situation]"
```

### Loss Patterns (Why You Lose to This Competitor)

For each competitor, list the 3-5 most common reasons deals are LOST to them:
```
1. [Loss reason 1] — "We lose when [specific situation or buyer profile]"
2. [Loss reason 2] — "We lose when [situation]"
3. [Loss reason 3] — "We lose when [situation]"
```

### Deal Qualification Signals

Based on win/loss patterns, generate qualifying questions that help determine early whether this is a deal you are likely to win or lose:
```
- If the prospect says "[X]", it favors you because [reason]
- If the prospect says "[Y]", it favors the competitor because [reason]
- If the prospect prioritizes [Z], this is a strong deal for you
- If the prospect prioritizes [W], consider deprioritizing this deal
```

---

## Step 6: Recommended Competitive Strategy

Based on all the intelligence gathered, recommend an overall competitive strategy for this prospect:

### Strategy Summary
One paragraph describing the recommended approach — which competitor to focus on displacing, which to ignore, and what messaging to lead with.

### Conversation Sequence
The recommended order of topics to cover in competitive discussions:
1. [First topic to establish] — Why: [Reason]
2. [Second topic] — Why: [Reason]
3. [Third topic] — Why: [Reason]
4. [Fourth topic] — Why: [Reason]
5. [Topic to close on] — Why: [Reason]

### What to Lead With
The single strongest differentiator to lead with against the prospect's current solution, with a specific talking point script.

### What to Avoid
Topics, claims, and comparisons to deliberately avoid in this competitive situation, with reasons for each.

### Displacement Timeline
Realistic timeline for displacing the current solution:
- When to start the conversation (relative to contract renewal)
- Expected evaluation period
- Migration timeline
- Full transition period

---

## Output Format

Write the complete competitive intelligence report to **COMPETITIVE-INTEL.md** in the current working directory with the following structure:

```markdown
# Competitive Intelligence: [Prospect Company Name]

Generated: [Date]
Prospect: [Company Name]
Website: [URL]
Analysis Focus: Sales competitive positioning

---

## Executive Summary

[2-3 sentence summary: What the prospect currently uses, your strongest competitive position, and the recommended strategy]

---

## Current Solutions Detected

| Category | Solution | Confidence | Evidence Source |
|----------|----------|-----------|----------------|
| [Category] | [Tool] | High/Med/Low | [Source URL or signal] |
| ... | ... | ... | ... |

---

## Battle Cards

### [Competitor 1 Name]
[Full battle card]

### [Competitor 2 Name]
[Full battle card]

[Continue for each detected competitor]

---

## Feature Gap Analysis

[Side-by-side comparison table]

---

## Win/Loss Patterns

### Win Patterns
[Common reasons you win]

### Loss Patterns
[Common reasons you lose]

### Deal Qualification Signals
[Early indicators of win/loss likelihood]

---

## Competitive Positioning Statements

| Competitor | Positioning Statement |
|------------|----------------------|
| [Competitor 1] | "[Statement]" |
| [Competitor 2] | "[Statement]" |
| ... | ... |

---

## Switching Cost Assessment

| Factor | [Competitor 1] | [Competitor 2] | [Competitor 3] |
|--------|----------------|----------------|----------------|
| Technical migration | [Assessment] | [Assessment] | [Assessment] |
| Financial impact | [Assessment] | [Assessment] | [Assessment] |
| Organizational change | [Assessment] | [Assessment] | [Assessment] |
| Data portability | [Assessment] | [Assessment] | [Assessment] |
| Estimated timeline | [Timeline] | [Timeline] | [Timeline] |

---

## Recommended Competitive Strategy

[Strategy summary, conversation sequence, what to lead with, what to avoid, displacement timeline]

---

## Detection Sources

- [List all URLs fetched, searches performed, and sources consulted with dates]
```

---

## Rules and Constraints

1. **Honest about competitor strengths.** Every battle card must include genuine competitor strengths. If you portray every competitor as terrible, the salesperson loses credibility the moment the prospect pushes back.
2. **Never fabricate intelligence.** If a competitor's pricing, feature, or capability cannot be verified, label it as "Reported" or "Unverified." Sales credibility depends on accuracy.
3. **Specific over generic.** "Better customer support" is useless. "Dedicated account manager for all plans, with average response time of 2 hours vs. their 24-hour SLA" is actionable.
4. **Detection confidence matters.** Always label confidence levels on detected technologies. A High confidence detection (explicit badge on their website) carries different weight than a Low confidence inference (common tool in their industry).
5. **Never recommend bashing competitors.** The battle cards should help the salesperson position and differentiate, not attack. Negative selling backfires.
6. **Focus on what matters to THIS prospect.** Not every feature gap or competitive advantage is relevant to every deal. Prioritize the battle card content based on the prospect's likely priorities and pain points.
7. **Switching costs must be realistic.** Underestimating switching costs makes you look naive. Overestimating them makes the deal feel impossible. Be accurate.
8. **If previous analysis files exist** (PROSPECT-ANALYSIS.md, COMPANY-RESEARCH.md, LEAD-QUALIFICATION.md), incorporate findings about the prospect's priorities, pain points, and evaluation criteria into the competitive positioning.
9. **Landmine questions must be genuinely curious.** They should be questions any smart buyer would ask — not transparent traps designed to make the competitor look bad.
10. **Update frequency.** Competitive intelligence has a shelf life. Note the date of each source and recommend a refresh timeline (typically every 3-6 months or before a major competitive deal).
