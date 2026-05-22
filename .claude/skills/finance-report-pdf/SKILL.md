---
name: finance-report-pdf
description: Professional PDF financial plan generator. Scans current working directory for FINANCE-*.md files, extracts scores and financial data, then runs the bundled Python ReportLab script to produce a polished, client-ready PDF with cover page, Financial Health Score gauge, score breakdown, cash flow, debt, retirement, portfolio, and prioritized action plan. Output: FINANCE-PLAN.pdf.
---

# /finance report-pdf — PDF Financial Plan Generator

**DISCLAIMER: For educational/informational purposes only. Not financial advice.**

## Purpose

Compile all the FINANCE-*.md markdown analyses in the current working directory into a single polished PDF that an advisor, family member, or accountability partner can read end-to-end.

## When To Trigger

- User types `/finance report-pdf` or `/finance pdf`
- User asks "make a PDF report", "give me a client-ready document", "export my financial plan"
- After running `/finance analyze` (suggest this as the natural follow-up)

## Prerequisites

Before generating, ensure the user has at least one analysis file in the current working directory:

- `FINANCE-ANALYSIS.md` (from `/finance analyze`) — primary input
- `FINANCE-BUDGET.md`
- `FINANCE-DEBT.md`
- `FINANCE-RETIREMENT.md`
- `FINANCE-PORTFOLIO.md`
- `FINANCE-EMERGENCY.md`
- `FINANCE-NETWORTH.md`
- `FINANCE-GOALS.md`
- `FINANCE-COMPARE.md`
- `FINANCE-SCREEN.md`
- `FINANCE-FIRE.md`
- `FINANCE-TAXES.md`

If no files are found, prompt user to first run `/finance analyze` or `/finance quick`.

## Process

### Step 1: Scan for Source Files
```
ls FINANCE-*.md
```
Read every file found. The Python generator script also performs its own scan; Claude pre-reads to validate content quality and surface any obvious gaps before generating.

### Step 2: Extract Data
Pull from the markdown files:

- **Composite Financial Health Score** (0-100) and letter grade
- **Sub-scores** for each of the 5 categories (Cash Flow, Debt, Investments, Retirement, Protection)
- **Key financial data points:**
  - Monthly income / expenses / surplus
  - Savings rate
  - Net worth
  - Total debt and DTI
  - Emergency fund months covered
  - Retirement projected balance vs needed
  - Asset allocation
- **Action items** (ranked by priority)
- **User name / household name** (if provided)
- **Date generated**

### Step 3: Run the PDF Generator

Execute:
```
Bash(python3 ~/.claude/skills/finance/scripts/generate_finance_pdf.py)
```

The script reads all FINANCE-*.md files from the current working directory, parses the structured sections, and assembles a PDF using ReportLab.

If the script is missing or errors, gracefully fall back to a markdown-only consolidated report named `FINANCE-PLAN.md` and inform the user.

### Step 4: Confirm Output

After generation:
1. Verify `FINANCE-PLAN.pdf` exists in the current working directory
2. Report file size and page count to user
3. Suggest sharing it with their financial advisor / CPA

## PDF Structure

The generator produces the following sections:

### Cover Page
- Title: "Personal Financial Plan"
- User / household name
- Date
- Composite Financial Health Score gauge (visual 0-100 dial)
- Letter grade (A+ to F)
- One-line signal ("Excellent — minor optimizations only")
- Disclaimer footer

### Page 2: Executive Summary
- Top 3 strengths
- Top 3 priority gaps
- This quarter's focus (single sentence)
- Key numbers table:
  - Net worth
  - Monthly surplus
  - Savings rate
  - DTI
  - Emergency months

### Page 3: Financial Health Score Breakdown
- Bar chart of 5 category scores
- Each category: score / weight / what-it-measures / signal

### Page 4: Cash Flow & Budget
- Income vs Expenses chart
- Top 5 expense categories
- Surplus trend
- Recommended budget adjustments

### Page 5: Debt Profile
- Total debt by type (table)
- Average APR
- Payoff timeline (avalanche method)
- Interest cost over current trajectory vs accelerated

### Page 6: Retirement Outlook
- Years to retirement
- Current balance vs age benchmark
- Projected balance at retirement (3 scenarios: conservative / moderate / aggressive)
- Needed balance for desired lifestyle
- Gap analysis
- Recommended contribution rate

### Page 7: Investment Portfolio
- Current allocation pie chart
- Recommended allocation pie chart
- Drift / rebalancing needs
- Expense ratio analysis
- Diversification score

### Page 8: Financial Protection
- Emergency fund status
- Insurance coverage matrix (health, life, disability, auto, home)
- Estate planning checklist (will, beneficiaries, POA, healthcare directive)
- Gaps and priority fills

### Page 9-10: Action Plan
- 30-day priorities
- 90-day priorities
- 1-year priorities
- 5-year priorities
- Each action includes: specific dollar amount, specific account/vehicle, due date

### Final Page: Disclosures & Glossary
- Full disclaimer
- Methodology notes
- Glossary of terms (DTI, SWR, ER, etc.)
- "Next steps" — when to consult professionals

## Visual Design Standards

- **Color palette:** Blue (#1f4e79) primary, green for positive metrics, amber for warnings, red for critical
- **Typography:** Sans-serif for headings, serif for body
- **Charts:** Clean, minimal grid lines, labels in plain language
- **Gauges:** 0-100 scale with color-coded zones (red <40, amber 40-69, green 70+)
- **Tables:** Alternating row shading, right-align numbers, currency formatting with thousands separators

## Tone & Language

- Plain English, not jargon-heavy
- Specific numbers, never vague ranges
- Empathetic on shortfalls, concrete on actions
- Confident on strengths

## Error Handling

| Error | Response |
|-------|----------|
| No FINANCE-*.md files found | "Run `/finance analyze` or `/finance quick` first to generate input data." |
| Python script missing | Generate consolidated `FINANCE-PLAN.md` instead; tell user how to install ReportLab |
| ReportLab not installed | Instruct: `pip3 install reportlab` |
| Empty/malformed markdown | Skip that section, generate PDF without it, note in summary |
| PDF generation succeeds but file is < 50KB | Likely no data; warn user |

## Customization Options

If the user wants to customize:
- **Name on cover** — Ask for household name to display
- **Selective sections** — Allow `/finance report-pdf --sections=debt,retirement` to limit scope
- **Branding** — If advisor use, allow logo path injection
- **Currency** — Default USD; allow override

## Example Invocation Flow

```
User: /finance report-pdf

Claude: Scanning current directory for FINANCE-*.md files...
        Found: FINANCE-ANALYSIS.md, FINANCE-DEBT.md, FINANCE-RETIREMENT.md, FINANCE-BUDGET.md

        Generating PDF...
        [runs Bash(python3 ~/.claude/skills/finance/scripts/generate_finance_pdf.py)]

        Done. Generated FINANCE-PLAN.pdf (12 pages, 487 KB).

        Key takeaways:
        - Financial Health Score: 72/100 (Grade B)
        - Strongest area: Debt Management (88/100)
        - Weakest area: Retirement Readiness (52/100)
        - Top action: Increase 401k contribution from 6% to 12% to capture full match

        Recommended next step: Share this PDF with your CPA before year-end tax planning.

        DISCLAIMER: For educational/informational purposes only. Not financial advice.
```

## Validation Checklist

Before declaring success, verify:
- [ ] PDF file exists at expected path
- [ ] File size > 50KB (rough sanity check)
- [ ] Disclaimer appears on cover and final page
- [ ] All category scores are present (not "N/A" for everything)
- [ ] At least 3 action items in the plan

---

**DISCLAIMER:** For educational/informational purposes only. Not financial advice. The generated PDF compiles AI-produced analysis based on user-supplied data. Always consult a licensed financial advisor, CPA, or tax professional before making major financial decisions. Past performance does not guarantee future results.
