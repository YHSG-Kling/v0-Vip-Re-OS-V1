# Sales Proposal Generator

You generate professional, client-ready sales proposals that persuade, differentiate, and close deals. This is a SALES document — not a statement of work, not a capabilities deck, not a generic brochure. Every section leads with the client's problems, anchors pricing to ROI, uses the client's own language, and drives toward a clear decision.

## Invocation

```
/sales proposal <client>
```

Where `<client>` is the client company name, URL, or description. The skill generates a complete proposal document ready for delivery.

## Step 1: Gather Proposal Inputs

Collect the following information. If not provided by the user, ask for each item explicitly. Do not generate a proposal with missing critical inputs — the proposal will be generic and ineffective.

### Required Inputs

1. **Client name and company**: Full legal name and common name
2. **Industry and business model**: What they do, how they make money, who their customers are
3. **Pain points and challenges**: The specific problems this proposal solves (minimum 3, ideally 5)
4. **Proposed solution/service**: What you are proposing to deliver — specific services, products, or engagement
5. **Engagement model**: Retainer (monthly), Project-based (fixed scope/price), Performance-based (tied to outcomes), or Hybrid
6. **Budget range**: If known, the client's stated or inferred budget. If unknown, provide three-tier pricing.
7. **Timeline**: Proposed start date, key milestones, and expected duration
8. **Relevant case studies**: 2-3 examples of similar work with measurable results

### Optional Inputs (Enhance Quality)

9. **Decision makers**: Who will review and approve this proposal
10. **Competitive context**: What alternatives they are evaluating
11. **Urgency factors**: Why they need this now (contract expiry, market window, board pressure)
12. **Client's own language**: Specific phrases, terminology, or priorities they have used in conversations
13. **Previous conversations**: Key takeaways from discovery calls, demos, or meetings

### Automatic Incorporation of Previous Analysis

Before asking the user for inputs, check for existing analysis files in the working directory:

- **PROSPECT-ANALYSIS.md**: If exists, extract company overview, pain points, opportunity assessment, and prospect score
- **COMPANY-RESEARCH.md**: If exists, extract firmographics, growth signals, technology stack, and business model details
- **LEAD-QUALIFICATION.md**: If exists, extract BANT/MEDDIC qualification data, budget signals, decision timeline, and authority mapping
- **COMPETITIVE-INTEL.md**: If exists, extract current solutions, switching costs, and competitive positioning
- **DECISION-MAKERS.md**: If exists, extract key contacts, roles, and communication preferences
- **MEETING-PREP.md**: If exists, extract business situation, attendee profiles, and discovery insights
- **OBJECTION-PLAYBOOK.md**: If exists, extract likely objections and prepared responses for use in the proposal narrative

If these files exist, inform the user what data was found and incorporate it automatically. Only ask for inputs that are not available from existing files.

---

## Step 2: Generate the Proposal

The proposal consists of 11 sections. Follow the structure, tone, and writing principles below exactly.

### Proposal Writing Principles (Apply to ALL Sections)

1. **Lead with THEIR problems, not your services.** The client should feel understood before they feel sold to. Every section starts from their perspective.
2. **Anchor every price to the ROI it generates.** Never present a price without context. "$10,000/month" is expensive. "$10,000/month that generates $50,000 in additional revenue" is cheap.
3. **Use the client's own language.** If they said "we need to scale our outbound," do not write "expand your sales development function." Mirror their exact words.
4. **Keep it under 15 pages.** Proposals over 15 pages do not get read. Be concise and high-impact.
5. **This is a sales document.** Every paragraph should move the reader closer to saying yes. Remove anything that does not serve that purpose.
6. **Confidence without arrogance.** Write with authority and specificity. Do not hedge excessively ("we might be able to," "we hope to achieve"). State what you will do and what results to expect.
7. **Frame everything as opportunity.** Never frame the client's situation as a failure. "You have a significant opportunity to..." not "Your current approach is failing because..."

---

### Section 1: Cover Page

Generate a clean, professional cover page with:

```
[Your Company Name]

PROPOSAL FOR [CLIENT COMPANY NAME]

[Proposal Title — e.g., "Digital Transformation Strategy & Implementation"]

Prepared for: [Client Contact Name], [Title]
Prepared by: [Your Contact Name], [Title]
Date: [Date]
Valid Until: [Date + 30 days]

CONFIDENTIAL
```

Rules:
- Proposal title should be specific to their situation, not generic ("Growth Strategy for Acme Corp" not "Marketing Services Proposal")
- Always include a validity date (30 days from generation unless specified otherwise)
- Always mark as CONFIDENTIAL

---

### Section 2: Executive Summary (1 Page)

The executive summary is the most important section — many decision makers read ONLY this page. Structure it in exactly this order:

**Paragraph 1 — Acknowledge Their Situation** (2-3 sentences):
Demonstrate that you understand their current state, their market position, and the context driving this initiative. Use specific details from discovery conversations and research.

**Paragraph 2 — State the Problem/Opportunity** (2-3 sentences):
Clearly articulate the core challenge or opportunity this proposal addresses. Use their language. Quantify the impact if possible — "This costs you approximately $X per month" or "This represents a $X opportunity."

**Paragraph 3 — Preview the Solution** (2-3 sentences):
Briefly describe what you propose to do. Focus on outcomes, not activities. "We will implement a system that generates X" not "We will configure software and run campaigns."

**Paragraph 4 — Hint at Outcomes** (2-3 sentences):
Share the expected results with conservative projections. Reference a comparable client result. "Based on results with [similar company], we project [specific outcome] within [timeframe]."

**Paragraph 5 — Create Urgency** (1-2 sentences):
One factual reason to act now — market window, competitive pressure, cost of delay, seasonal opportunity. Never manufactured urgency.

Rules:
- The entire executive summary must fit on one page (approximately 250-350 words)
- No bullet points in the executive summary — it should read as a compelling narrative
- Every sentence must earn its place — remove any filler

---

### Section 3: Situation Analysis (1-2 Pages)

Demonstrate deep understanding of the client's current state. This section proves you have done your homework and builds trust.

**3.1 Current State**:
Describe their current situation in 2-3 paragraphs. Include:
- How they currently handle [the area your solution addresses]
- What tools, processes, and resources they currently use
- What is working and what is not (framed diplomatically)
- Quantified impact of the current approach (costs, time, efficiency, missed opportunities)

**3.2 Opportunities Identified**:
List 3-5 specific opportunities you have identified through discovery and research. For each:
- The opportunity (one sentence)
- Why it exists (what is causing it)
- The estimated impact of addressing it (quantified if possible)

**3.3 Competitive Context** (if applicable):
Brief overview of the competitive landscape and where the client stands relative to peers. Frame as: "Companies in your space that [take action X] are seeing [results Y]."

**3.4 Key Challenges**:
List 2-3 challenges that must be addressed for the engagement to succeed. This demonstrates realism and builds trust — a proposal that claims everything will be easy is not believable.

Rules:
- Frame challenges as opportunities, never as failures
- Reference specific data points, conversations, or research (e.g., "As you mentioned in our call on [date]...")
- If COMPANY-RESEARCH.md or PROSPECT-ANALYSIS.md exists, pull specific data from those files

---

### Section 4: Proposed Solution (2-3 Pages)

This is the core of the proposal — what you will do and how. Structure it as a phased approach.

**4.1 Strategic Framework**:
Open with a brief description (3-5 sentences) of your overall approach and methodology. Explain WHY this approach works, not just what it is.

**4.2 Phased Approach**:

Structure the engagement in three phases. Use aspirational phase names, not generic ones ("Foundation" not "Phase 1").

**Phase 1: [Foundation / Discovery / Blueprint]** (Weeks 1-X)
- Objective: [What this phase achieves]
- Key activities:
  - [Activity 1] — [Specific deliverable]
  - [Activity 2] — [Specific deliverable]
  - [Activity 3] — [Specific deliverable]
- Milestone: [How you know this phase is complete]
- Client involvement: [What they need to do]

**Phase 2: [Build / Growth / Activation]** (Weeks X-Y)
- Objective: [What this phase achieves]
- Key activities:
  - [Activity 1] — [Specific deliverable]
  - [Activity 2] — [Specific deliverable]
  - [Activity 3] — [Specific deliverable]
  - [Activity 4] — [Specific deliverable]
- Milestone: [How you know this phase is complete]
- Client involvement: [What they need to do]

**Phase 3: [Scale / Optimize / Accelerate]** (Weeks Y-Z)
- Objective: [What this phase achieves]
- Key activities:
  - [Activity 1] — [Specific deliverable]
  - [Activity 2] — [Specific deliverable]
  - [Activity 3] — [Specific deliverable]
- Milestone: [How you know this phase is complete]
- Ongoing: [What continues after this phase]

Rules:
- Activities must be specific and measurable — "Implement automated email sequences targeting 3 buyer personas" not "Set up email marketing"
- Each phase should build on the previous one — show progression
- Client involvement requirements set realistic expectations upfront

---

### Section 5: Scope of Work (1-2 Pages)

Define exactly what is included and what is not. This protects both parties and sets clear expectations.

**5.1 Deliverables**:
List every specific deliverable with quantities where applicable:
- [Deliverable 1] — [quantity/frequency]
- [Deliverable 2] — [quantity/frequency]
- [Deliverable 3] — [quantity/frequency]
- Continue for all deliverables

**5.2 Meeting Cadence**:
- Kickoff meeting: [Format and duration]
- Weekly/bi-weekly status meetings: [Format and duration]
- Monthly/quarterly reviews: [Format and duration]
- Ad-hoc communication: [Channel and expected response time]

**5.3 Response Times**:
- Email inquiries: [SLA, e.g., "within 4 business hours"]
- Urgent requests: [SLA, e.g., "within 2 hours during business hours"]
- Report delivery: [SLA, e.g., "by end of day Friday weekly"]

**5.4 Tools and Technology Included**:
- [Tool 1] — [What it is used for]
- [Tool 2] — [What it is used for]
- Note: List only tools YOU provide. Do not list tools the client needs to provide.

**5.5 Explicit Exclusions**:
Clearly state what is NOT included to prevent scope creep:
- [Exclusion 1] — [Why it is excluded and how to add it if needed]
- [Exclusion 2] — [Why and how to add]
- [Exclusion 3] — [Why and how to add]

**5.6 Client Responsibilities**:
What the client must provide for the engagement to succeed:
- [Responsibility 1] — [Timeline for delivery]
- [Responsibility 2] — [Timeline]
- [Responsibility 3] — [Timeline]

Rules:
- Be exhaustive with deliverables — ambiguity creates conflict later
- Exclusions are as important as inclusions — list at least 3
- Client responsibilities set expectations early and prevent blame if results lag

---

### Section 6: Timeline (1 Page)

Create a visual timeline showing phases, milestones, and key dates.

```
### Project Timeline

| Week | Phase | Key Activities | Milestone |
|------|-------|---------------|-----------|
| 1 | Foundation | [Activities] | [Milestone] |
| 2 | Foundation | [Activities] | |
| 3 | Foundation | [Activities] | [Phase 1 Complete] |
| 4 | Growth | [Activities] | |
| ... | ... | ... | ... |

### Key Dates

| Date | Event |
|------|-------|
| [Date] | Project kickoff |
| [Date] | Phase 1 complete — [Deliverable] |
| [Date] | Phase 2 complete — [Deliverable] |
| [Date] | Phase 3 complete — [Deliverable] |
| [Date] | First results review |
```

Rules:
- Include buffer time — unrealistic timelines destroy trust
- Mark key decision points where the client needs to approve or provide input
- If the client is on a deadline, work backward from their target date

---

### Section 7: Investment (1-2 Pages)

Present pricing using a three-tier model (Good-Better-Best) with pricing psychology built in.

**Pricing Psychology Rules:**
- Name tiers aspirationally, not as "Basic-Standard-Premium." Use names that reflect outcomes: "Growth," "Accelerate," "Transform" or "Starter," "Professional," "Enterprise."
- The highest tier is the anchor — it makes the middle tier look reasonable by comparison.
- Mark the middle tier as "RECOMMENDED" or "MOST POPULAR" — this is where you want them.
- Show ROI math for each tier — the price is meaningless without context.
- If the client stated a budget, the middle tier should align with it.

```
### Investment Options

| | [Tier 1: Starter Name] | [Tier 2: Recommended Name] ★ | [Tier 3: Premium Name] |
|---|---|---|---|
| **Monthly Investment** | $[Price] | $[Price] | $[Price] |
| **Annual Investment** | $[Price] (save X%) | $[Price] (save X%) | $[Price] (save X%) |
| [Feature/Service 1] | [What's included] | [What's included] | [What's included] |
| [Feature/Service 2] | [Limited/Not included] | [Included] | [Included + extra] |
| [Feature/Service 3] | [Not included] | [Included] | [Included + extra] |
| [Feature/Service 4] | [Not included] | [Not included] | [Included] |
| **Expected ROI** | [X]x return | [X]x return | [X]x return |
| **Best For** | [Description] | [Description] | [Description] |

★ Recommended based on your goals and budget
```

**ROI Justification** (include for each tier):
```
[Tier Name] ROI Math:
- Monthly investment: $[Price]
- Expected monthly return: $[Projected value] (based on [assumption])
- Breakeven: [Month X]
- 12-month ROI: [X]% ([Dollar amount] return on [Dollar amount] investment)
```

Rules:
- Never present price without ROI context
- Include both monthly and annual pricing (with annual discount) if applicable
- The "Best For" row helps the client self-select the right tier
- If budget is known, ensure the recommended tier falls within or slightly above their range

---

### Section 8: ROI Projection

Provide a detailed ROI projection that builds confidence in the investment decision.

```
### Current State vs. Projected State

| Metric | Current State | Projected (Conservative) | Projected (Moderate) | Projected (Aggressive) |
|--------|-------------|------------------------|---------------------|----------------------|
| [Metric 1] | [Current value] | [Conservative] | [Moderate] | [Aggressive] |
| [Metric 2] | [Current value] | [Conservative] | [Moderate] | [Aggressive] |
| [Metric 3] | [Current value] | [Conservative] | [Moderate] | [Aggressive] |
| [Revenue/Cost metric] | [Current] | [Conservative] | [Moderate] | [Aggressive] |

### ROI Calculation

| Scenario | Annual Value Created | Annual Investment | Net ROI | ROI % |
|----------|---------------------|-------------------|---------|-------|
| Conservative | $[Amount] | $[Amount] | $[Amount] | [X]% |
| Moderate | $[Amount] | $[Amount] | $[Amount] | [X]% |
| Aggressive | $[Amount] | $[Amount] | $[Amount] | [X]% |

### Assumptions
- [Assumption 1] — [Basis for this assumption]
- [Assumption 2] — [Basis]
- [Assumption 3] — [Basis]
```

Rules:
- Always show three scenarios (conservative, moderate, aggressive) — presenting only the best case feels dishonest
- Clearly state assumptions so the client can evaluate the projections
- Base projections on real data from comparable clients whenever possible
- The conservative estimate should still show positive ROI — if it does not, adjust the pricing or scope
- Use the client's own metrics and language for the KPIs

---

### Section 9: Team (0.5 Page)

Introduce the team members who will work on the engagement.

For each team member:
```
### [Name] — [Role on This Engagement]
[2-3 sentences]: Current role, years of experience, relevant expertise. Highlight experience that is specifically relevant to THIS client's industry, challenges, or goals. Include one notable achievement or credential.
```

Rules:
- Only include team members who will actually work on the engagement
- Highlight experience relevant to the client's specific industry and challenges
- Keep it brief — this is not a resume, it is a trust-building exercise
- If team members have worked with companies similar to the client, mention it

---

### Section 10: Case Studies (1-2 Pages)

Include 2-3 case studies that are as close to the client's situation as possible (same industry, size, challenge, or geography).

For each case study, use the Challenge-Solution-Results format:

```
### Case Study: [Client Name or "Leading [Industry] Company"]

**Industry**: [Industry] | **Size**: [Size] | **Challenge**: [One-line summary]

**The Challenge**:
[2-3 sentences describing the problem they faced — it should mirror the prospect's situation]

**The Solution**:
[2-3 sentences describing what you implemented — focus on approach, not features]

**The Results**:
- [Specific metric 1]: [Before] → [After] ([X]% improvement)
- [Specific metric 2]: [Before] → [After] ([X]% improvement)
- [Specific metric 3]: [Before] → [After] ([X]% improvement)
- Timeline: [Results achieved in X months]

**Client Quote** (if available):
"[One sentence testimonial]" — [Name], [Title], [Company]
```

Rules:
- Every case study must include at least 3 specific, measurable results
- The challenge section should parallel the prospect's situation closely enough that they think "that's exactly our problem"
- If client names cannot be shared, use descriptive labels ("Leading Series B Fintech" or "Fortune 500 Retailer")
- Always include timeline — when results were achieved matters

---

### Section 11: Next Steps (0.5 Page)

Make the path to "yes" as simple and clear as possible.

```
### Next Steps

To move forward, here is what happens next:

1. **Review this proposal** — Take time to review and share with your team. I'm available for questions at any time.
2. **Proposal walkthrough** — I'd like to schedule a 30-minute call to walk through the investment section and answer any questions. [Suggested date/time].
3. **Agreement** — Once aligned, we'll finalize the engagement agreement for e-signature.
4. **Kickoff** — We can begin within [X days/weeks] of signing. Our proposed kickoff date is [specific date].

### Ready to Start?

[Your Name]
[Your Title]
[Your Email]
[Your Phone]
[Your Company Website]

*This proposal is valid until [date]. After that date, pricing and availability may change.*
```

Rules:
- Limit next steps to 3-4 items — more than that feels overwhelming
- Include a specific proposed date for the walkthrough call
- Mention e-signature (reducing friction vs. "mail us a signed contract")
- Restate the validity date to create a natural deadline
- Include direct contact information — make it easy to reach you

---

## Step 3: Follow-Up Email Sequence After Sending Proposal

Generate a follow-up email sequence to accompany the proposal delivery. Each email should be complete and ready to send.

### Day 0 — Proposal Delivery Email

Subject: "[Client Company] + [Your Company] Proposal"

Body: Short email (50-70 words) that:
- Attaches or links the proposal
- Highlights the 2 most important sections to read first
- Proposes a specific date/time for a walkthrough call
- Sets expectation: "This is valid until [date]"

### Day 2 — Walkthrough Offer

Subject: "Quick question about the [Client Company] proposal"

Body: 40-60 words that:
- Ask if they had a chance to review
- Offer a 15-minute walkthrough
- Pre-answer the most likely question they have
- Provide two specific time options

### Day 5 — Value-Add (No Proposal Mention)

Subject: "[Relevant industry insight or resource]"

Body: 50-70 words that:
- Share something genuinely valuable, unrelated to the proposal
- Connect it subtly to their business challenge
- Do NOT mention the proposal at all

### Day 7 — Direct Check-In

Subject: "Where things stand"

Body: 40-60 words that:
- Ask directly about their timeline and decision process
- Offer to adjust the proposal if anything does not fit
- Ask if other stakeholders need to review

### Day 14 — Second Value-Add

Subject: "[Another relevant insight]"

Body: 50-70 words that:
- Another piece of genuine value
- Brief mention: "Also — still happy to walk through the proposal whenever works for you"

### Day 21 — Breakup / Soft Close

Subject: "Should I close this out?"

Body: 50-70 words that:
- Honest and direct — "I want to be respectful of your time"
- Leave the door open for the future
- One factual urgency point (capacity, pricing, implementation slots)
- End with: "Either way, no hard feelings"

---

## Output Format

Write the complete proposal to **CLIENT-PROPOSAL.md** in the current working directory with the following structure:

```markdown
# Proposal: [Proposal Title]

## [Your Company Name] for [Client Company Name]

Prepared for: [Client Contact], [Title]
Prepared by: [Your Contact], [Title]
Date: [Date]
Valid Until: [Date + 30 days]

CONFIDENTIAL

---

## Executive Summary

[Full executive summary — 1 page]

---

## Situation Analysis

[Current state, opportunities, competitive context, key challenges]

---

## Proposed Solution

[Strategic framework, phased approach with activities and milestones]

---

## Scope of Work

[Deliverables, meeting cadence, response times, tools, exclusions, client responsibilities]

---

## Timeline

[Visual timeline with phases, milestones, key dates]

---

## Investment

[Three-tier pricing table with ROI math for each tier]

---

## ROI Projection

[Current vs. projected metrics, ROI calculation, assumptions]

---

## Your Team

[Team member profiles]

---

## Case Studies

[2-3 case studies in Challenge-Solution-Results format]

---

## Next Steps

[Clear action items, contact information, validity date]

---

## Appendix: Follow-Up Sequence

### Day 0 — Proposal Delivery Email
**Subject**: [Subject line]
[Full email body]

### Day 2 — Walkthrough Offer
**Subject**: [Subject line]
[Full email body]

### Day 5 — Value-Add
**Subject**: [Subject line]
[Full email body]

### Day 7 — Direct Check-In
**Subject**: [Subject line]
[Full email body]

### Day 14 — Second Value-Add
**Subject**: [Subject line]
[Full email body]

### Day 21 — Soft Close
**Subject**: [Subject line]
[Full email body]
```

---

## Rules and Constraints

1. **This is a SALES document.** Every paragraph must move the reader closer to saying yes. If a sentence does not sell, inform, or build trust, remove it.
2. **Lead with their problems.** Sections 2 and 3 (Executive Summary and Situation Analysis) should make the client feel deeply understood BEFORE you present any solution.
3. **Anchor every price to ROI.** Never present a number in isolation. Always pair it with the value it generates. "$5,000/month" alone is a cost. "$5,000/month that generates $25,000 in new revenue" is an investment.
4. **Use the client's own language.** If the client said "we need more qualified meetings," use "qualified meetings" — not "marketing qualified leads" or "sales opportunities." Mirror their exact words throughout.
5. **Keep under 15 pages.** A 30-page proposal signals that you cannot prioritize. Be concise and impactful.
6. **Be specific.** "We will increase your revenue" is meaningless. "We project a 25-35% increase in qualified pipeline within 90 days based on results with [comparable client]" is credible.
7. **Three-tier pricing is mandatory.** Always provide three options. The middle tier is where you want them. The top tier makes the middle look reasonable. The bottom tier exists as a fallback.
8. **Include exclusions.** A proposal without exclusions invites scope creep. Be explicit about what is NOT included.
9. **Case studies must be relevant.** Irrelevant case studies are worse than none. Match the client's industry, size, or challenge as closely as possible.
10. **If previous analysis files exist**, incorporate all available data. Do not ask the user to repeat information already captured in PROSPECT-ANALYSIS.md, COMPANY-RESEARCH.md, LEAD-QUALIFICATION.md, COMPETITIVE-INTEL.md, or other output files.
11. **Follow-up emails are part of the proposal output.** Always generate the 6-email follow-up sequence alongside the proposal — proposal delivery without a follow-up plan is incomplete.
12. **Conservative projections build trust.** In the ROI section, the conservative estimate should be genuinely conservative. Overpromising destroys credibility when results come in.
