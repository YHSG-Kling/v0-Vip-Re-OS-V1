---
name: finance-compare
description: Side-by-side comparison of two financial scenarios (buy vs rent, new job vs stay, payoff house vs invest, Roth vs Traditional, lease vs buy car, etc). Projects each scenario over 10 years, compares total cost, opportunity cost, risk profile, and produces a structured recommendation. Output saved as FINANCE-COMPARE.md.
---

# /finance compare — Side-by-Side Scenario Comparison

**DISCLAIMER: For educational/informational purposes only. Not financial advice.**

## Purpose

Help the user make better financial decisions by modeling two paths side-by-side over a 10-year horizon. Surfaces total cost, opportunity cost, risk, and a clear recommendation with reasoning.

## When To Trigger

- User types `/finance compare <scenario1> <scenario2>`
- User asks "should I X or Y?" where both are financial choices
- User is weighing a major decision: housing, job, debt, investing, retirement vehicle, vehicle purchase, education

## Supported Scenario Pairs

The skill handles any two financial paths. Common pairs:

| Decision | Scenario A | Scenario B |
|----------|------------|------------|
| Housing | Buy home | Continue renting |
| Career | Take new job ($X salary) | Stay current job |
| Debt strategy | Pay off mortgage early | Invest the extra cash |
| Retirement vehicle | Roth IRA | Traditional IRA / 401k |
| Vehicle | Buy new car | Lease |
| Vehicle | Buy used cash | Finance new |
| Education | Graduate degree | Stay working |
| Geographic | Move to lower-cost city | Stay in current city |
| Business | W-2 employment | Self-employment / 1099 |
| Investing | Pay down debt | Invest in index funds |

## Required Inputs

Ask the user to specify:

1. **The two scenarios** (one sentence each)
2. **Time horizon** (default 10 years; some decisions warrant 20-30)
3. **Key financial assumptions per scenario:**
   - Initial cost / down payment
   - Recurring monthly cost
   - Expected appreciation/return rate
   - Tax treatment
   - End-state value (if applicable: home equity, vehicle value, account balance)
4. **User's marginal tax rate** (for tax-aware comparisons)
5. **User's discount rate** (default: 7% — long-run S&P 500 real return)

If user doesn't know assumptions, use reasonable defaults and label them clearly:
- Home appreciation: 3.5%/yr
- Rent inflation: 3%/yr
- Stock market real return: 7%/yr
- Bond real return: 2%/yr
- Inflation: 3%/yr
- Mortgage rate: current market (ask user or use 7% as 2026 default)
- Property tax: 1.1% of home value/yr
- Maintenance: 1% of home value/yr
- Insurance: 0.5% of home value/yr

## Calculation Framework

For each scenario, compute year-by-year:

1. **Cash outflow** — All money leaving (down payment, monthly costs, taxes)
2. **Cash inflow / equity buildup** — Principal paydown, appreciation, investment returns
3. **Net worth impact** — End-state value minus cumulative cash spent
4. **Opportunity cost** — What would the cash outflows have earned if invested at 7%?

### Total Cost (10-year)
```
total_cost = sum(annual_cash_outflow) - end_state_asset_value
```

### Opportunity Cost
```
opportunity_cost = FV(monthly_diff, 7%, 10yr) where monthly_diff = scenario_A_cost - scenario_B_cost
```

### Risk Profile
Score each scenario 1-10 on:
- **Liquidity risk** — Can you get your money out?
- **Concentration risk** — Is too much net worth tied up here?
- **Income/job risk** — Does it require stable employment?
- **Market risk** — Sensitive to interest rates, housing market, equity market?
- **Reversibility** — Can you undo this decision easily?

## Output Format

Save to `FINANCE-COMPARE.md` in current working directory.

```markdown
# Financial Scenario Comparison

**Decision:** [One-sentence framing]
**Time Horizon:** [X] years
**Generated:** [Date]

> **DISCLAIMER:** For educational/informational purposes only. Not financial advice.

---

## Executive Summary

**Recommendation:** [Scenario A or B] — [one-sentence reason]
**Confidence:** [High / Medium / Low]
**Key Driver:** [The single number that tips the decision]

## Scenario A: [Name]

**Assumptions:**
- [List each assumption with value]

**10-Year Projection:**
| Year | Cash Out | Equity/Value | Cumulative Net |
|------|----------|--------------|----------------|
| 1    | $X       | $Y           | $Z             |
| 5    | $X       | $Y           | $Z             |
| 10   | $X       | $Y           | $Z             |

**Total Cost (10yr):** $X
**End-State Value:** $Y
**Net Position:** $Z

## Scenario B: [Name]

[Same structure as A]

## Side-by-Side

| Metric | Scenario A | Scenario B | Winner |
|--------|------------|------------|--------|
| Total Cost (10yr) | $X | $X | A/B |
| End-State Value | $X | $X | A/B |
| Net Position (10yr) | $X | $X | A/B |
| Monthly Cash Flow | $X | $X | A/B |
| Opportunity Cost | $X | $X | A/B |
| Tax Drag (annual) | $X | $X | A/B |
| Liquidity (1-10) | X | X | A/B |
| Concentration Risk | X | X | A/B |
| Reversibility | X | X | A/B |

## Opportunity Cost Analysis

If the higher-cost scenario costs $X more per month, investing that difference at 7% real return over 10 years would compound to **$Y**.

That is the true cost of choosing [scenario].

## Risk Profile

**Scenario A Risks:**
- [Specific risk + magnitude]
- [Specific risk + magnitude]

**Scenario B Risks:**
- [Specific risk + magnitude]
- [Specific risk + magnitude]

## Break-Even Analysis

Scenario A becomes cheaper than B at **year [N]** if [assumption holds].
Scenario A becomes WORSE than B if [trigger condition].

## Sensitivity Analysis

What changes the answer?

| If This Changes | Recommendation Flips To |
|-----------------|-------------------------|
| Stock returns < 4%/yr | [Scenario] |
| Home appreciation < 2%/yr | [Scenario] |
| You move within 5 years | [Scenario] |
| Tax bracket changes | [Scenario] |

## Recommendation

**Choose [Scenario A or B].**

**Reasoning:**
1. [Primary reason with number]
2. [Secondary reason]
3. [Tie-breaker]

**Caveats:**
- [What would change this]
- [Personal preference factor]

## Action Steps This Week

1. [Specific concrete action]
2. [Specific concrete action]
3. [Specific concrete action]

---

**DISCLAIMER:** For educational/informational purposes only. Not financial advice. Consult a licensed financial advisor, CPA, or tax professional before making major financial decisions. All projections rely on assumptions that may not hold. Past performance does not guarantee future results.
```

## Common Pitfalls To Avoid

- **Don't ignore taxes** — Roth vs Traditional flips entirely on future vs current tax rate
- **Don't ignore transaction costs** — Buying a home incurs ~6% selling fees later
- **Don't double-count appreciation** — If you assume 7% returns, don't also assume 7% home appreciation (housing is closer to 3-4% long run)
- **Don't ignore behavioral factors** — Forced savings via mortgage may beat "invest the difference" if user won't actually invest it
- **Don't assume linear costs** — Cars depreciate non-linearly; homes have lumpy maintenance

## Scenario-Specific Templates

### Buy vs Rent
Track: mortgage P&I, property tax, insurance, maintenance, opportunity cost of down payment, vs rent + investing the down payment.
Key flip: years lived in home. Under 5 years usually favors rent.

### Pay Off Mortgage vs Invest
Compare: mortgage APR (after tax deduction) vs expected market return. If mortgage is 7% and expected return is 7%, the guaranteed return wins.

### Roth vs Traditional
Compare: current marginal tax rate vs expected retirement tax rate. Higher now → Traditional. Lower now → Roth.

### New Job vs Stay
Factor: salary delta, equity comp, retirement match, benefits cost difference, commute, career trajectory.

**DISCLAIMER: For educational/informational purposes only. Not financial advice.**
