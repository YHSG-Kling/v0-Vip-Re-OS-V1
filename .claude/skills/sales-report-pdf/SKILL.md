# Professional Sales Report PDF Generator

## Metadata
- **Title:** Professional Sales Report PDF Generator
- **Invocation:** `/sales report-pdf`
- **Input:** None (reads SALES-REPORT.md and prospect files from current directory)
- **Output:** `SALES-REPORT-{YYYY-MM-DD}.pdf` written to the current working directory
- **Dependencies:** Python 3, `reportlab` library, `scripts/generate_pdf_report.py`

---

## Purpose

You generate a professional, visually polished PDF version of the sales pipeline report. The PDF is designed for sharing with sales leadership, investors, or team members who need a clean, portable document rather than a markdown file. It includes charts, formatted tables, color-coded scores, and a professional layout.

---

## Instructions

When the user invokes `/sales report-pdf`, follow this process:

### Step 1: Verify Prerequisites

Check that `SALES-REPORT.md` exists in the current working directory.

**If SALES-REPORT.md does NOT exist:**
- Inform the user: "No SALES-REPORT.md found. Run `/sales report` first to generate the pipeline report, then run `/sales report-pdf` to create the PDF version."
- Stop execution.

**If SALES-REPORT.md exists:**
- Read its contents
- Also scan for individual prospect analysis files (`**/PROSPECT-ANALYSIS.md`, `**/COMPANY-RESEARCH.md`, etc.) to enrich the PDF with additional detail

### Step 2: Check for reportlab

Verify that the `reportlab` Python library is available by running:
```bash
python3 -c "import reportlab; print(reportlab.Version)"
```

**If reportlab is NOT installed:**
- Inform the user: "The `reportlab` Python library is required for PDF generation. Install it with: `pip install reportlab`"
- Offer to run the install command for them: `pip install reportlab`
- After installation, continue with PDF generation

**If Python 3 is NOT available:**
- Inform the user: "Python 3 is required for PDF generation. Please install Python 3 and the reportlab library."
- Stop execution.

### Step 3: Parse Report Data

Extract the following data from `SALES-REPORT.md` and any prospect analysis files:

#### Pipeline Overview Data
- Report generation date
- Total number of prospects
- Average pipeline score (0-100)
- Overall pipeline health assessment

#### Prospect Data Array
For each prospect, extract into a structured object:
```json
{
  "name": "Company Name",
  "url": "https://company.com",
  "score": 85,
  "grade": "A",
  "stage": "Qualified",
  "next_action": "Send intro email to VP Engineering",
  "est_value": "$24,000 ARR",
  "component_scores": {
    "company_fit": 88,
    "contact_access": 75,
    "opportunity_quality": 90,
    "competitive_position": 82,
    "outreach_readiness": 80
  },
  "key_pain_point": "Manual API monitoring causing outages",
  "key_contact": "Jane Smith, VP Engineering",
  "risk_factors": "Long procurement cycle"
}
```

#### Top Prospects Data
For the top 5 prospects, extract detailed data including:
- Full component score breakdown
- Key contacts with titles
- Pain points with severity
- Recommended approach
- Risk factors

#### Action Items
Extract the prioritized action list:
```json
[
  {
    "priority": 1,
    "company": "Acme Corp",
    "action": "Send personalized email to VP Engineering",
    "urgency": "immediate",
    "reason": "Recent funding round creates budget window"
  }
]
```

#### Pipeline Health Metrics
```json
{
  "total_prospects": 10,
  "average_score": 72,
  "a_grade_count": 3,
  "a_grade_pct": 30,
  "b_grade_count": 4,
  "b_grade_pct": 40,
  "c_grade_count": 2,
  "c_grade_pct": 20,
  "d_grade_count": 1,
  "d_grade_pct": 10,
  "highest_score": 92,
  "lowest_score": 35,
  "health_rating": "Good"
}
```

### Step 4: Build JSON Input File

Write a JSON file at `_pdf_input.json` in the current working directory containing all extracted data:

```json
{
  "title": "Sales Pipeline Report",
  "date": "2025-01-15",
  "overall_pipeline_score": 72,
  "health_rating": "Good",
  "total_prospects": 10,
  "prospects": [
    {
      "name": "...",
      "url": "...",
      "score": 85,
      "grade": "A",
      "stage": "Qualified",
      "next_action": "...",
      "est_value": "...",
      "component_scores": { ... },
      "key_pain_point": "...",
      "key_contact": "...",
      "risk_factors": "..."
    }
  ],
  "top_prospects": [ ... ],
  "action_items": [ ... ],
  "pipeline_health": { ... },
  "score_distribution": {
    "A+": { "count": 1, "pct": 10, "prospects": ["Acme Corp"] },
    "A": { "count": 2, "pct": 20, "prospects": ["Beta Inc", "Gamma Ltd"] },
    "B": { "count": 4, "pct": 40, "prospects": ["..."] },
    "C": { "count": 2, "pct": 20, "prospects": ["..."] },
    "D": { "count": 1, "pct": 10, "prospects": ["..."] }
  },
  "weekly_focus": [
    {
      "rank": 1,
      "company": "Acme Corp",
      "score": 92,
      "reason": "Highest score with active trigger event",
      "actions": ["Send intro email", "Connect on LinkedIn", "Schedule demo"]
    }
  ],
  "methodology": {
    "company_fit_weight": 25,
    "contact_access_weight": 20,
    "opportunity_quality_weight": 20,
    "competitive_position_weight": 15,
    "outreach_readiness_weight": 20
  }
}
```

### Step 5: Locate or Create the PDF Generation Script

Check if the PDF generation script exists at `scripts/generate_pdf_report.py` relative to the project root.

**Finding the project root:** Look for the `scripts/` directory in these locations (in order):
1. The ai-sales-team-claude project directory (where the agents/ and skills/ folders are)
2. The current working directory
3. One level up from the current working directory

**If the script does NOT exist:**
- Inform the user: "The PDF generation script was not found at `scripts/generate_pdf_report.py`. This script is part of the AI Sales Team project setup. Please ensure the project is properly installed."
- Stop execution.

**If the script exists:**
- Proceed to execution.

### Step 6: Generate the PDF

Run the PDF generation script:

```bash
python3 scripts/generate_pdf_report.py _pdf_input.json "SALES-REPORT-$(date +%Y-%m-%d).pdf"
```

The script should produce a PDF with these sections:

#### PDF Section 1: Cover Page
- Title: "Sales Pipeline Report"
- Date of generation
- Overall Pipeline Score displayed as a large circular gauge (0-100)
- Pipeline health rating with color indicator
- Quick stats: total prospects, average score, top grade count

#### PDF Section 2: Score Breakdown
- Horizontal bar chart showing score distribution by grade band
- Color coded: A+ = dark green, A = green, B = blue, C = orange, D = red
- Each bar labeled with count and percentage

#### PDF Section 3: Prospect Comparison Table
- Full table of all prospects with columns: Rank, Company, Score, Grade, Stage, Next Action, Est. Value
- Alternating row colors for readability
- Grade column color-coded
- Sorted by score descending

#### PDF Section 4: Top Prospects Detail
- One page (or half-page) per top prospect
- Component score radar chart or bar chart
- Key contacts listed
- Pain points and approach summary
- Risk factors highlighted

#### PDF Section 5: Action Plan
- Prioritized action items in a numbered list
- Grouped by timeframe: Immediate, Short-Term, Pipeline Building
- Each with company name, specific action, and urgency level

#### PDF Section 6: Methodology
- Brief explanation of the scoring methodology
- Weight breakdown with percentages
- Grade band definitions
- Disclaimer that scores are based on publicly available information

### Step 7: Clean Up and Report

After PDF generation:

1. Verify the PDF file was created and check its file size
2. Remove the temporary `_pdf_input.json` file
3. Report to the user:
   - PDF file name and location
   - File size
   - Number of pages
   - Summary of contents

---

## Error Handling

### reportlab Not Installed
```
The PDF generation requires the reportlab Python library.
Install it by running: pip install reportlab

Shall I install it for you?
```

### Python Not Available
```
Python 3 is required for PDF generation but was not found.
Please install Python 3 from https://python.org and then run:
  pip install reportlab
```

### Script Not Found
```
The PDF generation script was not found at scripts/generate_pdf_report.py.
This script is part of the AI Sales Team project. Please ensure the project
directory structure is intact.
```

### No Report Data
```
SALES-REPORT.md was not found in the current directory.
Run `/sales report` first to generate the pipeline report, then run
`/sales report-pdf` to create the PDF version.
```

### PDF Generation Failed
If the Python script exits with an error:
1. Capture the error output
2. Check for common issues:
   - Invalid JSON input (malformed data)
   - File permission errors
   - Disk space issues
   - reportlab version incompatibility
3. Report the specific error to the user with a suggested fix
4. Keep the `_pdf_input.json` file for debugging (don't delete it on failure)

---

## Output Specifications

- **File Name:** `SALES-REPORT-{YYYY-MM-DD}.pdf` (using current date)
- **Page Size:** Letter (8.5" x 11")
- **Orientation:** Portrait for most pages, landscape for wide tables if needed
- **Color Scheme:** Professional blues and grays with color-coded score indicators
- **Font:** Helvetica or similar sans-serif for readability
- **Margins:** 0.75 inch on all sides
- **Expected Length:** 4-8 pages depending on number of prospects

---

## Important Rules

1. ALWAYS check for SALES-REPORT.md before attempting PDF generation. Never generate a PDF from scratch without the markdown report.
2. ALWAYS check for reportlab before running the script. Provide clear installation instructions if missing.
3. Clean up temporary files (_pdf_input.json) on success. Keep them on failure for debugging.
4. The JSON input must be valid JSON. Validate it before passing to the script.
5. If the PDF script fails, provide the full error output to help the user debug.
6. Never modify the original SALES-REPORT.md file during PDF generation.
7. Report the final PDF file path, size, and page count to the user after successful generation.
8. If prospect data is incomplete, still generate the PDF with available data rather than failing. Mark missing data as "N/A" in the PDF.
