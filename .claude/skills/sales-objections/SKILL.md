# Objection Handling Playbook

You generate comprehensive objection response scripts that salespeople can use in real-time during calls, meetings, and email exchanges. Every objection response is word-for-word ready to use, not a summary or framework description. This playbook covers 15 universal objections, industry-specific objections, competitive objections, and pricing deep-dives.

## Invocation

```
/sales objections <topic/industry>
```

Where `<topic/industry>` is the prospect's industry (e.g., "SaaS", "healthcare", "e-commerce"), a specific topic (e.g., "pricing", "enterprise security"), or a prospect company name/URL for fully customized objection handling.

## Step 1: Gather Context

Before generating the playbook, collect or infer:

1. **Your product/service**: What you sell and the core value proposition
2. **Target industry**: The prospect's industry or vertical
3. **Prospect company size**: SMB, mid-market, or enterprise (affects objection types and responses)
4. **Typical competitors**: The 2-3 competitors you most frequently sell against
5. **Average deal size**: Affects how pricing objections are handled
6. **Your strongest proof points**: Best case studies, metrics, and testimonials available

If previous analysis files exist in the working directory (PROSPECT-ANALYSIS.md, COMPANY-RESEARCH.md, COMPETITIVE-INTEL.md), read them and automatically customize the playbook to the specific prospect.

If the user provides a URL instead of a topic, fetch the website using WebFetch and determine the industry, company size, and likely objections based on the research.

---

## Step 2: Objection Handling Frameworks

Every response in this playbook uses one of two frameworks. Generate both response versions for each objection so the salesperson can choose the one that fits the moment.

### Framework 1: Feel-Felt-Found (FFR)

Structure:
```
"I understand how you feel about [restate their concern in your own words].
[Similar company/role] felt the same way when they were [in the same situation].
What they found was [specific positive outcome with a metric or concrete result]."
```

Rules for FFF responses:
- "Feel" must genuinely acknowledge their concern — never dismiss it
- "Felt" must reference a real or realistic similar company/person — be specific (industry, size, role)
- "Found" must include a specific, measurable outcome — never vague ("they loved it")
- Total response should be 3-5 sentences spoken aloud (approximately 15-25 seconds)

### Framework 2: Acknowledge-Bridge-Close (ABC)

Structure:
```
**Acknowledge**: "[Validate their concern — show you heard them and it's a reasonable concern]"
**Bridge**: "[Transition to your value — reframe the concern as a reason to move forward]"
**Close**: "[Provide evidence and propose a specific next step]"
```

Rules for ABC responses:
- Acknowledge must NOT start with "but" or "however" — genuinely validate first
- Bridge must reframe, not dismiss — turn their concern into an advantage or learning moment
- Close must include a proof point AND a specific next action (question, offer, or proposal)
- Total response should be 3-5 sentences spoken aloud (approximately 15-25 seconds)

---

## Step 3: The 15 Universal Sales Objections

Generate complete handling scripts for each of the following objections. For EACH objection, provide all six components listed below.

---

### Objection 1: "It's too expensive" / "We don't have the budget"

**What it really means**: They either do not see enough value to justify the price, have not secured internal budget approval, or are using price as a polite way to decline. Rarely means they literally cannot afford it.

**FFR Response**:
"I completely understand the budget concern — [price] is a meaningful investment. [Company in their industry] felt the same way when they were evaluating this last [quarter/year]. They were spending roughly [X amount] on [current manual process / existing tool / lost opportunity cost]. What they found after implementing was [specific ROI metric] — they actually [saved/generated] [X] within the first [timeframe], which was [multiplier]x their investment. Would it help if I walked you through the ROI math specific to your situation?"

**ABC Response**:
"That's a fair concern, and I appreciate you being direct about it. (Acknowledge) Here's what I've seen though — the cost of NOT solving [their specific pain point] is usually much higher than the investment. Right now, based on what you shared about [their specific situation], you're likely spending [estimated cost of current approach] on [current process]. (Bridge) Let me put together a quick ROI comparison so you can see the numbers side by side — would 10 minutes on Thursday work to walk through it? (Close)"

**Follow-up question**: "Just so I understand — is it that the price is higher than you expected, or that you haven't been able to secure budget for this category yet? Those are different problems, and I might be able to help with both."

**Proof point to deploy**: [Generate a specific ROI case study — e.g., "Acme Corp reduced their [cost category] by 40% in 90 days, saving $150K annually on a $50K investment."]

**When to walk away**: If they genuinely cannot afford it after exploring all pricing options (tiered pricing, reduced scope, payment terms), and there is no path to budget in the next 1-2 quarters, move them to a nurture sequence.

---

### Objection 2: "We're happy with our current solution"

**What it really means**: Status quo bias. Switching costs feel high and the pain of change feels greater than the pain of staying. They may also not be aware of what they are missing.

**FFR Response**:
"That's great to hear — it means you've already solved the basics, which actually makes this conversation easier. [Similar company] felt the same way about [their current tool]. They were genuinely satisfied — it worked. What they found was that 'working' and 'optimal' are very different things. After switching, they discovered they'd been leaving [specific metric — e.g., 30% more efficiency, $200K in revenue] on the table without realizing it. I'm not suggesting you have a problem — I'm curious if there are opportunities you might not have visibility into yet."

**ABC Response**:
"I'd be worried if you weren't happy with your current setup — it would mean you made a bad decision, and you clearly didn't. (Acknowledge) That said, most of the companies we work with were happy with their previous solution too. The question isn't whether your current tool works — it's whether there's a significant gap between where you are and where you could be. (Bridge) What if we did a quick gap analysis — 15 minutes, no commitment — and if I can't show you at least [specific value metric] in upside, I'll be the first to tell you to stick with what you have? (Close)"

**Follow-up question**: "What's the one thing you wish your current solution did better? Even small frustrations tend to compound over time."

**Proof point to deploy**: [Generate a competitive displacement case study specific to the identified current solution.]

**When to walk away**: If after a gap analysis they genuinely have no unmet needs and their current solution covers everything, they are not a prospect right now. Add to nurture for when their needs evolve or their contract renews.

---

### Objection 3: "We need to think about it"

**What it really means**: Almost never means they will actually think about it. Usually means they have an unspoken concern, they need buy-in from someone else, or they want to avoid saying no directly.

**FFR Response**:
"Absolutely — this is an important decision and you should take the time you need. [Similar role at similar company] said the same thing. What they found helpful was identifying the specific criteria they needed to evaluate so the thinking time was productive rather than open-ended. Can I ask — what are the two or three factors that will drive your decision? I might be able to get you answers today that save you a week of back-and-forth."

**ABC Response**:
"Of course — you should absolutely think it through. (Acknowledge) In my experience, 'thinking about it' goes a lot faster when we can narrow down exactly what needs to be resolved. Most of the time, there are one or two specific questions that, once answered, make the decision clear one way or another. (Bridge) What would you need to see or know to feel confident about moving forward? Let's tackle those right now if we can. (Close)"

**Follow-up question**: "Totally fair. Can I ask — is there a specific concern or question that's giving you pause? I'd rather address it now while we're both here than have it linger."

**Proof point to deploy**: "Most of our customers who did decide to move forward told us their biggest regret was not doing it sooner — [specific customer] estimated they lost [metric] for every month they delayed."

**When to walk away**: If they are genuinely not the decision-maker and need internal alignment, help them sell internally (provide a one-pager, offer to join a call with their stakeholder). If they repeatedly defer without specifics, they are likely a "no" — move to breakup sequence.

---

### Objection 4: "Send me more information"

**What it really means**: This is the polite brush-off. 90% of the time it means "I want to end this conversation." Occasionally it is genuine — they want to review materials before committing time.

**FFR Response**:
"Happy to send something over. [Prospect at similar company] asked for the same thing. What they found was that a generic PDF didn't really answer their specific questions — what actually helped was a 10-minute walkthrough focused on [their specific use case]. I can put together something tailored to [their situation] — would a quick call Thursday be more useful than a brochure?"

**ABC Response**:
"Absolutely — I'll send that over today. (Acknowledge) I want to make sure I send you the RIGHT information though, not a generic overview that doesn't address your situation. (Bridge) What specifically would be most useful for you to see? Is it pricing, implementation, case studies, or something else? That way I can tailor it and save you time digging through a 30-page deck. (Close)"

**Follow-up question**: "Sure thing. So I send the right materials — what are the two or three things that would most influence your decision? I'll make sure those are front and center."

**Proof point to deploy**: Offer to send a case study specifically relevant to their industry/size instead of generic materials.

**When to walk away**: If they insist on email-only communication and refuse any call or meeting after 2-3 attempts, respect it. Send the best materials you have and add to the follow-up sequence.

---

### Objection 5: "We're not ready right now" / "The timing isn't right"

**What it really means**: Could be genuine (other priorities, budget cycles, leadership changes) or a soft decline. Need to determine which.

**FFR Response**:
"I appreciate you being upfront about timing. [Similar company] was in the same position — they had [Q4 planning / a migration / a re-org] happening and couldn't take on anything new. What they found was that starting the evaluation process now, even slowly, meant they were ready to move when the timing was right instead of starting from scratch. They saved about [X weeks/months] by doing the groundwork early. Is there a specific timeline when this would move up in priority?"

**ABC Response**:
"Completely understand — timing matters, and I don't want to push something when you're not ready. (Acknowledge) Here's what I've seen though: the companies that get the best results are usually the ones that start the conversation early, even if implementation is months away. It means when the timing IS right, they're not scrambling. (Bridge) What if we keep this low-touch — I'll check in with something useful once a month, and when the timing works, we can pick right up? What does your timeline look like for revisiting this? (Close)"

**Follow-up question**: "Makes sense. Can you help me understand — is it that you don't have bandwidth to evaluate right now, or that you don't have bandwidth to implement right now? Those have different solutions."

**Proof point to deploy**: "Companies that start their evaluation [X months] before they're ready to implement get [specific benefit — faster time to value, better pricing, smoother onboarding]."

**When to walk away**: If the timing is genuinely tied to a known event (contract renewal in Q3, budget cycle in January, post-merger integration), set a specific follow-up date tied to that event and move to nurture. If "timing" is vague and they cannot give a timeframe, it is likely a soft no.

---

### Objection 6: "I need to talk to my [boss/team/partner]"

**What it really means**: Either they genuinely need buy-in from others (common and legitimate), or they are using "my boss" as a shield to avoid making a decision. Need to determine which and then help them sell internally.

**FFR Response**:
"That makes total sense — a decision like this should involve the right people. [Similar role] said the same thing. What they found most helpful was going into that conversation with a clear summary of the business case. I put together a one-page executive summary for them that covered the problem, the solution, the ROI, and the timeline — their [boss/CFO] approved it in the next meeting. Want me to put something similar together for you?"

**ABC Response**:
"Absolutely — you should get alignment from your team on this. (Acknowledge) I want to make it as easy as possible for you to make the case internally. I know how hard it is to champion a new initiative when you're already busy. (Bridge) Here's what I can do — I'll put together a one-page business case you can share, and if it would help, I'm happy to join a call with your [boss/team] to answer any technical or financial questions directly. Would that make the internal conversation easier? (Close)"

**Follow-up question**: "Great — who else will be involved in the decision? And what do you think their main concerns will be? I can prepare materials that address those specifically."

**Proof point to deploy**: Offer a one-page executive summary, a pre-built ROI calculator, or a competitive comparison they can share internally.

**When to walk away**: If they have been "talking to their boss" for more than 3 weeks with no progress and cannot arrange a meeting that includes the decision-maker, the deal is likely stalled. Offer to engage the decision-maker directly, and if that is declined, move to a gentle breakup.

---

### Objection 7: "We tried something similar before and it didn't work"

**What it really means**: Past trauma. They invested time, money, and reputation in a previous solution and it failed. They are risk-averse now and afraid of repeating the mistake. This is an emotional objection as much as a rational one.

**FFR Response**:
"I appreciate you sharing that — it takes real honesty to say that, and I don't want to waste your time if this would be more of the same. [Company in their space] felt the same way — they had a bad experience with [competitor/previous solution] and were understandably gun-shy. What they found was that most of those failures came down to [specific root cause — implementation support, wrong fit, lack of training, scope creep]. We specifically designed our [approach/onboarding/product] to address that. Would it help if I walked you through exactly what was different in their case and why the outcome changed?"

**ABC Response**:
"That's really important context, and I'm glad you told me. The last thing I want is to put you through another bad experience. (Acknowledge) Can I ask — what specifically went wrong? I want to make sure we're not repeating the same mistake, and honestly, if the issues you experienced are the same ones we'd have, I'd rather tell you that now. (Bridge) Let me map what went wrong before against how we handle it — if I can't clearly show you a different approach, I'll tell you straight up. Fair? (Close)"

**Follow-up question**: "What specifically went wrong? Was it the product itself, the implementation, the support, or something else? Understanding the root cause helps me tell you honestly if we'd be different."

**Proof point to deploy**: A case study from a customer who ALSO had a previous failed implementation and succeeded with your solution — specifically addressing the same failure mode.

**When to walk away**: If the previous failure was traumatic enough that no amount of evidence will overcome it, and the decision-maker is the same person who championed the failed solution, the risk aversion may be too deeply personal. Nurture over time, but do not push.

---

### Objection 8: "Your competitor offers X that you don't"

**What it really means**: They are comparing feature-for-feature and found a gap. May be a genuine dealbreaker or may be a negotiation tactic to get a discount. Need to determine how critical the missing feature actually is.

**FFR Response**:
"You're right — [Competitor] does have [Feature X], and I want to be transparent about that. [Similar company] raised the same point. What they found was that while [Feature X] looked important on a comparison spreadsheet, [your alternative approach / the features you DO have] actually solved the underlying problem more effectively for their workflow. Specifically, [how your approach addresses the same need differently]. They told us after 3 months that [Feature X] was a 'nice to have' but [your differentiator] was the reason they actually saw results."

**ABC Response**:
"You're absolutely right — that's a feature we don't have today, and I'm not going to pretend otherwise. (Acknowledge) The question is whether [Feature X] is a must-have or a nice-to-have for your specific use case. We took a different approach to solving [the underlying problem] — we do [your approach], which actually [specific advantage]. (Bridge) Here's what I'd suggest — let's look at your actual workflow and determine if [Feature X] is critical for YOUR situation, or if [your approach] gets you to the same outcome. Can you walk me through how you'd use [Feature X] specifically? (Close)"

**Follow-up question**: "Help me understand — how often would you actually use [Feature X] in your day-to-day? Is this a daily necessity or something you'd use occasionally?"

**Proof point to deploy**: Customer testimonial from someone who chose you OVER the competitor despite the missing feature, explaining why.

**When to walk away**: If the missing feature is genuinely a hard requirement for their workflow (e.g., a compliance requirement, an integration they cannot work without), be honest. Say "You're right — if [Feature X] is a hard requirement, we're not the right fit today." This builds massive credibility and may bring them back when your roadmap catches up.

---

### Objection 9: "We can build this in-house"

**What it really means**: Their engineering team believes they can create a solution internally. They are underestimating the development time, maintenance burden, and opportunity cost, or they have strong Not-Invented-Here syndrome.

**FFR Response**:
"You definitely could — your team is clearly capable. [Tech company in their space] said the same thing. They had a strong engineering team and figured it would take about [X months] to build internally. What they found was that by the time they accounted for building, testing, maintenance, and iteration, it took [2-3x longer] and pulled their engineers off [core product work]. They calculated the opportunity cost at [dollar amount] — that's what their engineers WOULD have built if they weren't maintaining an internal tool. They ended up switching to us and redeployed those engineers to [revenue-generating work]."

**ABC Response**:
"Your team could absolutely build this — I have no doubt about that. The question isn't whether you CAN build it, it's whether you SHOULD. (Acknowledge) Every week your engineers spend building and maintaining [this tool category] is a week they're not building [their core product / revenue-generating features]. (Bridge) Let me share what [similar company] found when they calculated the true cost of build vs. buy — it's usually 3-5x more expensive to build when you factor in maintenance, iteration, and opportunity cost. Would it help to walk through that math together? (Close)"

**Follow-up question**: "What's your engineering team's current backlog look like? If they built this, what would get deprioritized?"

**Proof point to deploy**: Build-vs-buy cost analysis from a similar customer showing total cost of ownership comparison over 12-24 months.

**When to walk away**: If they have a genuine competitive advantage in building this themselves (e.g., their product IS a platform and this is core IP), building in-house may truly be the right call. Acknowledge it and move on.

---

### Objection 10: "I don't see the ROI"

**What it really means**: You have not connected your solution to their specific business outcomes. They understand what your product does but not why it matters for THEIR bottom line.

**FFR Response**:
"That's a really important question, and honestly, if I can't show you clear ROI, you shouldn't buy this. [Company in their industry] said the exact same thing. They challenged us to prove the ROI before they committed. What they found was [specific ROI metric — e.g., 'a 340% return in year one' or 'payback period of 6 weeks']. Specifically, they [saved/generated] [dollar amount] by [specific outcome]. Let me build that same ROI model for YOUR numbers — do you have 15 minutes this week?"

**ABC Response**:
"If you can't see the ROI, I haven't done my job yet — and you absolutely should not move forward until the numbers make sense. (Acknowledge) Let me ask you this: what does [the problem you solve] cost you right now? Not just in dollars, but in time, team bandwidth, missed opportunities, and risk. (Bridge) I'll put together an ROI projection specific to your business — using YOUR numbers, not hypothetical ones. If the math doesn't work, I'll tell you. Fair? (Close)"

**Follow-up question**: "Let me make sure I understand what ROI means for you specifically. Is it cost savings, revenue growth, time savings, risk reduction, or something else? Different customers measure value differently."

**Proof point to deploy**: A detailed ROI case study with specific before/after metrics from a comparable customer, including methodology so they can verify the math.

**When to walk away**: If after building a custom ROI model the numbers genuinely do not work for their situation (too small, wrong use case, insufficient volume), be honest. Not every prospect will see positive ROI, and saying so builds trust for future opportunities.

---

### Objection 11: "We're locked into a contract"

**What it really means**: They have an existing commitment with a competitor and cannot (or believe they cannot) switch right now. This is often a timing objection more than a rejection.

**FFR Response**:
"That's completely understandable — I wouldn't want you to break a commitment. [Similar company] was in the same situation with [X months] left on their [Competitor] contract. What they found was that by starting the evaluation and onboarding process before their contract ended, they had zero downtime when they switched. Some of our customers even run both solutions in parallel during the transition to ensure a smooth handoff. When does your current contract renew?"

**ABC Response**:
"That makes sense, and I respect that commitment. (Acknowledge) Here's the good news — this doesn't have to be an either-or right now. Many of our customers start the evaluation process 2-3 months before their contract ends so they're ready to switch seamlessly when the time comes. (Bridge) When does your contract renew? Let me set a reminder to reconnect [X weeks] before that date so you have time to evaluate properly without any rush. (Close)"

**Follow-up question**: "When does your current contract come up for renewal? And is there an auto-renewal clause I should know about — sometimes those sneak up on people."

**Proof point to deploy**: Offer a migration timeline showing how much lead time is needed for a smooth switch, working backward from their renewal date.

**When to walk away**: This is a timing issue, not a rejection. Get the contract renewal date, set a firm follow-up date 2-3 months before renewal, and add to the nurture sequence. Do not push for an early break unless they express genuine dissatisfaction with the current vendor.

---

### Objection 12: "This isn't a priority right now"

**What it really means**: They have competing priorities that feel more urgent. Your solution may be important but is not urgent enough to displace what is currently on their plate.

**FFR Response**:
"I get that — you're juggling a lot, and something has to be at the top of the list. [Similar role at similar company] told me the same thing. What they found was that [the problem you solve] was actually making their OTHER priorities harder to execute. Once they addressed [your value area], their [other priority] actually moved faster because [specific connection]. What's at the top of your priority list right now? I'm curious if there's a connection I can help you see."

**ABC Response**:
"That's fair — every team has limited bandwidth, and I'm not going to pretend my thing should automatically be number one. (Acknowledge) Can I ask what IS the top priority right now? Because I've seen situations where solving [your value area] actually accelerates other initiatives. (Bridge) If there's a connection, it might actually make sense to tackle this sooner rather than later. If not, let me find the right time to reconnect. What quarter does this realistically move up? (Close)"

**Follow-up question**: "What IS the top priority right now? I ask because sometimes the challenges we solve are actually blockers for other initiatives — I want to see if there's a connection."

**Proof point to deploy**: Example of a customer who discovered that solving your problem accelerated their other priorities.

**When to walk away**: If their priorities are genuinely misaligned and there is no connection to your value area, respect it. Get a specific quarter for re-engagement and add to nurture.

---

### Objection 13: "We don't have bandwidth to implement"

**What it really means**: They see value but the implementation effort feels overwhelming. Fear of disruption, migration pain, and the learning curve is holding them back.

**FFR Response**:
"Implementation bandwidth is a real concern — nobody wants to add more to their team's plate. [Similar company] had the same worry. Their team was already stretched thin with [X initiative]. What they found was that our implementation process took [specific timeframe — e.g., 'less than 2 hours of their team's time'] because we handle [what you handle]. Their team lead told me the onboarding was easier than setting up a new Slack workspace. Would it help to see a detailed implementation timeline so you know exactly what's required from your team?"

**ABC Response**:
"That's one of the most common concerns I hear, and it's completely valid. (Acknowledge) Here's what I want you to know: we've designed our implementation specifically for teams that are already busy. Your team's time commitment is [X hours total / X hours per week for Y weeks]. We handle [list what you handle]. (Bridge) Let me share the implementation plan from [similar company] — they were in the same boat and were fully live in [timeframe] with minimal disruption. I'll walk you through exactly what your team would need to do. (Close)"

**Follow-up question**: "What's your biggest concern about implementation specifically — is it the time commitment, the technical complexity, the change management, or something else?"

**Proof point to deploy**: Implementation timeline from a comparable customer showing minimal client-side effort required, with specific hours.

**When to walk away**: If they genuinely have zero bandwidth for even minimal implementation effort and there is no upcoming period of lighter workload, revisit in 3-6 months.

---

### Objection 14: "How do I know this will work for us?"

**What it really means**: Risk aversion. They want proof that your solution works for companies like THEIRS, not just in general. This is a trust and credibility gap.

**FFR Response**:
"That's exactly the right question to ask, and I'd be skeptical of anyone who just said 'trust me.' [Company very similar to theirs] had the same concern — they're in [same industry], [similar size], and they were dealing with [same challenge]. What they found was [specific result]. But here's what I'd actually recommend — don't take my word for it. I can connect you directly with [reference customer name] so you can hear it from someone in your shoes. Would that be helpful?"

**ABC Response**:
"That's a smart question — you should absolutely have proof before making this decision. (Acknowledge) Here's what I can offer: we have [X] customers in [their industry] ranging from [size range]. The closest comparison to your situation is [specific customer]. (Bridge) I'd like to do two things: First, share their detailed case study. Second, offer to connect you with their [role] for a 15-minute reference call. If they can't convince you, I certainly won't try. Would one or both of those be useful? (Close)"

**Follow-up question**: "What would 'working for you' specifically look like? If I could prove [specific outcome], would that be enough to move forward?"

**Proof point to deploy**: The most relevant case study from a customer who matches their industry, size, and challenge. Offer a live reference call.

**When to walk away**: If you genuinely do not have proof points or reference customers in their specific industry/size/use case, be honest. Say "We're early in [their vertical] — I'd love to work with you as a design partner, but I understand if you need more proven results."

---

### Objection 15: "Just not interested"

**What it really means**: Could be genuine disinterest, could be a brush-off because they are busy, or could mean your initial pitch missed the mark entirely. This is the hardest objection because there is nothing specific to address.

**FFR Response**:
"I appreciate the honesty — that's refreshing. Before I let you go, can I ask one quick question? Most [their role] I talk to are dealing with [common pain point in their industry]. Is that something you've solved already, or is it just not a priority right now? I ask because [similar company] initially said the same thing, and when we dug into [specific area], they realized they had a [$X / X hours per month / X%] problem they hadn't quantified. If that doesn't resonate, I'll absolutely respect your time."

**ABC Response**:
"Fair enough — I appreciate you being direct rather than stringing me along. (Acknowledge) Can I ask one thing before I go? Was it something about how I described this, or is the problem space itself not relevant to you right now? (Bridge) If it's the former, I may have missed the mark on how this is relevant to your world. If it's the latter, totally understood — I'll leave you my info in case anything changes. (Close)"

**Follow-up question**: "Totally respect that. Just curious — is it that you've already solved [pain point], or that it's not a priority for you right now? I don't want to waste your time, but I also want to make sure I'm not missing something."

**Proof point to deploy**: The single most impressive, headline-grabbing metric from your best customer. If nothing else works, a jaw-dropping number might earn you 30 more seconds.

**When to walk away**: If after one genuine attempt to uncover the real objection they maintain "not interested," walk away immediately and gracefully. Do not push. A respectful exit preserves the relationship for future opportunities.

---

## Step 4: Industry-Specific Objections

Based on the `<topic/industry>` provided, generate 5 additional objections unique to that industry. Use the same format as the universal objections above (real meaning, FFR response, ABC response, follow-up question, proof point, when to walk away).

### Industry Objection Generation Rules

For each industry, identify objections that arise from:
- Industry-specific regulations or compliance requirements
- Common technology constraints in that vertical
- Industry-specific buying processes or budget cycles
- Competitive dynamics unique to that industry
- Cultural norms or expectations in that vertical

If the user provides a URL, use WebFetch to research the specific company and generate objections tailored to that company's situation, not just the industry.

---

## Step 5: Competitive Objections

Generate specific responses for "Why should I choose you over [Competitor X]?" for the top 3 competitors in the space.

For each competitor:

```
### "Why you over [Competitor Name]?"

**One-sentence positioning**: "[Your differentiator vs. this specific competitor]"

**Response script**: "[2-3 sentence response that acknowledges competitor strengths, differentiates without bashing, and redirects to your unique value]"

**3 landmine questions**: [Questions to ask that expose this competitor's weaknesses without directly mentioning them]

**If they say "[Competitor] is cheaper"**: "[Response]"
**If they say "[Competitor] has more features"**: "[Response]"
**If they say "[Competitor] is the market leader"**: "[Response]"
```

Rules for competitive responses:
- NEVER bash the competitor directly. Acknowledge their strengths honestly.
- Focus on YOUR strengths, not their weaknesses.
- Use landmine questions to let the prospect discover competitor weaknesses on their own.
- If you genuinely lose on a specific dimension, admit it and redirect to where you win.

---

## Step 6: Pricing Objections Deep Dive

Generate detailed scripts for 5 specific pricing tactics:

### Tactic 1: Reframe as Investment (Show ROI Math)

Script template:
"Let's look at this differently. The investment is [price]. Based on what you've told me about [their specific situation], you're currently [spending/losing] approximately [amount] on [the problem]. That means the breakeven point is [timeframe]. After that, every [month/quarter] is pure return. Here's the math: [walk through specific calculation using THEIR numbers]. Does that change how the investment looks?"

### Tactic 2: Cost of Inaction (What They Lose by NOT Buying)

Script template:
"I want to flip the question: what does it cost you to NOT solve this? Every [month/quarter] you're [specific cost of status quo — lost revenue, wasted time, manual effort, risk exposure]. Over the next 12 months, that adds up to approximately [calculated amount]. The question isn't whether you can afford [your solution] — it's whether you can afford to keep losing [inaction cost]."

### Tactic 3: Total Cost of Ownership Comparison

Script template:
"On the surface, [alternative / competitor / in-house] looks cheaper. But let's compare the true cost: [Your solution: price + implementation + support = total]. [Alternative: base price + hidden costs (maintenance, engineering time, downtime, missed features, scaling costs) = total]. When you factor in everything, [your solution] is actually [X%] less expensive over [timeframe]."

### Tactic 4: Reduce Scope / Tier Down

Script template:
"If the [top tier] pricing doesn't fit right now, here's what I'd recommend: start with [lower tier / reduced scope]. It covers [key features that address their primary pain point] at [lower price]. Once you see results, you can upgrade. Many of our best customers started exactly this way — [example customer] began with [starter tier] and expanded to [full tier] within [timeframe] because the ROI was clear."

### Tactic 5: Payment Terms Flexibility

Script template:
"Let's talk about making the investment work for your budget cycle. We can do [options: annual vs. monthly, deferred start, phased implementation, pilot period, milestone-based payments]. [Specific customer] started with a [90-day pilot / quarterly payments / phased rollout] and that made it easy to get budget approval. Which of those options would make this easier to say yes to?"

---

## Step 7: Objection Prevention

Generate 5 techniques to prevent objections from arising in the first place:

1. **Pre-emptive framing**: Address common concerns BEFORE the prospect raises them. "I know you might be wondering about [common concern] — here's how we handle that..."
2. **Social proof loading**: Drop relevant case studies and metrics throughout the conversation so objections feel already-answered when they arise.
3. **Discovery-driven selling**: Ask enough questions upfront that your presentation only covers what matters to them — fewer irrelevant features means fewer objections.
4. **Mutual action plan**: Establish a shared evaluation process early so the prospect feels in control, not sold to.
5. **Champion building**: Identify and equip an internal champion who can pre-handle objections within their organization before you encounter them.

For each prevention technique, provide:
- When to deploy it in the sales process
- Specific language/script to use
- Example of how it prevents a specific objection

---

## Output Format

Write the complete objection handling playbook to **OBJECTION-PLAYBOOK.md** in the current working directory with the following structure:

```markdown
# Objection Handling Playbook: [Industry/Topic]

Generated: [Date]
Industry: [Industry]
Customized For: [Prospect company if applicable]

---

## Quick Reference: Objection Response Matrix

| # | Objection | Real Meaning | Best Framework | Key Response |
|---|-----------|-------------|----------------|--------------|
| 1 | Too expensive | Value not proven | ABC | Show ROI math |
| 2 | Happy with current | Status quo bias | FFR | Gap analysis offer |
[...continue for all 15...]

---

## Frameworks

### Feel-Felt-Found (FFR)
[Framework description and structure]

### Acknowledge-Bridge-Close (ABC)
[Framework description and structure]

---

## Universal Objections (1-15)

[Full scripts for each objection]

---

## Industry-Specific Objections (16-20)

[5 additional objections specific to the industry]

---

## Competitive Objections

[Battle card responses for top 3 competitors]

---

## Pricing Deep Dive

[5 pricing tactics with scripts]

---

## Objection Prevention Tactics

[5 prevention techniques with scripts and examples]

---

## Practice Guide

- Role-play scenarios for the 5 hardest objections
- Recording prompts for self-coaching
- Common mistakes to avoid
```

---

## Rules and Constraints

1. **Word-for-word scripts.** Every response must be ready to speak aloud or copy-paste into an email. No summaries, frameworks-only, or "something like this" approximations.
2. **Honest about weaknesses.** If a competitor genuinely has an advantage, acknowledge it. Credibility is more valuable than winning one argument.
3. **Never manipulative.** No high-pressure tactics, guilt trips, fear-mongering, or manufactured urgency. Respect the prospect as an intelligent professional.
4. **Customized to context.** If the user provides a specific prospect or industry, every response must be tailored to that context — not generic.
5. **Both frameworks for every objection.** Always provide both FFR and ABC versions so the salesperson can choose the one that fits the moment and their style.
6. **Follow-up questions are mandatory.** An objection response without a follow-up question leaves the conversation dead. Every response must continue the dialogue.
7. **Include walk-away criteria.** Real salespeople need to know when to stop pushing. Every objection must include guidance on when the objection is genuine and the deal should be deprioritized.
8. **Proof points must be specific.** "Customers love us" is not a proof point. "[Company Name] increased [metric] by [X%] in [timeframe]" is a proof point. If specific customer data is not available, generate realistic placeholder examples and note that they should be replaced with real data.
9. **If previous analysis files exist** in the working directory, incorporate competitive intelligence, prospect challenges, and qualification data into the objection responses.
10. **Natural language.** Scripts should sound like a real human talking, not a sales robot. Use contractions, conversational transitions, and genuine empathy.
