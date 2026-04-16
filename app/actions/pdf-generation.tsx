"use server"

import { put } from "@vercel/blob"
import { createClient } from "@/lib/supabase/server"
import { dispatchEmail } from "@/lib/providers/dispatch"

// PDF Generation using jsPDF for client-side or Puppeteer for server-side
// For production, integrate with Puppeteer or similar for high-quality PDFs

interface PDFGenerationOptions {
  documentType: "cma" | "listing_packet" | "net_sheet" | "buyer_guide" | "seller_guide" | "offer_summary"
  data: any
  contactId?: string
  listingId?: string
  agentId: string
  emailRecipients?: string[]
  format?: "letter" | "a4"
  includeWatermark?: boolean
}

interface PDFGenerationResult {
  success: boolean
  pdfUrl?: string
  blobId?: string
  error?: string
  emailsSent?: number
}

// =====================================================
// GENERATE AND STORE PDF
// =====================================================

export async function generateAndStorePDF(options: PDFGenerationOptions): Promise<PDFGenerationResult> {
  const supabase = await createClient()
  
  try {
    // Get agent details for branding
    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, email, phone, license_number, brokerage_id, brokerage:brokerages(name)")
      .eq("id", options.agentId)
      .single()

    if (!agent) {
      return { success: false, error: "Agent not found" }
    }

    // Generate HTML content based on document type
    const htmlContent = await generateDocumentHTML(options, agent)

    // Convert HTML to PDF (in production, use Puppeteer or similar)
    const pdfBuffer = await htmlToPDF(htmlContent, options)

    // Generate filename
    const timestamp = new Date().toISOString().split("T")[0]
    const filename = `${options.documentType}_${timestamp}_${options.contactId || options.listingId || "doc"}.pdf`

    // Upload to Vercel Blob
    const blob = await put(filename, pdfBuffer, {
      access: "public",
      contentType: "application/pdf",
    })

    // Store record in database
    const { data: documentRecord, error: dbError } = await supabase
      .from("generated_documents")
      .insert({
        document_type: options.documentType,
        contact_id: options.contactId,
        listing_id: options.listingId,
        agent_id: options.agentId,
        blob_url: blob.url,
        blob_id: blob.pathname,
        file_name: filename,
        file_size: pdfBuffer.length,
        metadata: { options, agent },
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (dbError) {
      console.error("Error storing document record:", dbError)
    }

    // Send emails if recipients specified
    let emailsSent = 0
    if (options.emailRecipients && options.emailRecipients.length > 0) {
      for (const recipient of options.emailRecipients) {
        const emailResult = await sendDocumentEmail({
          to: recipient,
          documentType: options.documentType,
          pdfUrl: blob.url,
          agentName: `${agent.first_name} ${agent.last_name}`,
          agentEmail: agent.email,
          brokerageId: agent.brokerage_id,
          contactId: options.contactId,
          agentId: options.agentId,
        })
        if (emailResult.success) emailsSent++
      }
    }

    return {
      success: true,
      pdfUrl: blob.url,
      blobId: blob.pathname,
      emailsSent,
    }
  } catch (error) {
    console.error("Generate and store PDF error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "PDF generation failed",
    }
  }
}

// =====================================================
// GENERATE HTML CONTENT
// =====================================================

async function generateDocumentHTML(options: PDFGenerationOptions, agent: any): Promise<string> {
  const { documentType, data } = options

  // Base styles for PDF
  const baseStyles = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { 
        font-family: 'Inter', sans-serif; 
        color: #1e293b; 
        line-height: 1.6;
        padding: 40px;
      }
      h1 { font-size: 32px; font-weight: 900; margin-bottom: 8px; color: #0f172a; }
      h2 { font-size: 24px; font-weight: 700; margin: 24px 0 12px; color: #334155; }
      h3 { font-size: 18px; font-weight: 600; margin: 16px 0 8px; color: #475569; }
      p { margin-bottom: 12px; }
      .header { border-bottom: 4px solid #4f46e5; padding-bottom: 20px; margin-bottom: 30px; }
      .section { margin-bottom: 30px; page-break-inside: avoid; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
      .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
      .highlight { background: #eef2ff; border-left: 4px solid #4f46e5; padding: 16px; margin: 16px 0; }
      .footer { 
        margin-top: 40px; 
        padding-top: 20px; 
        border-top: 2px solid #e2e8f0; 
        font-size: 12px; 
        color: #64748b; 
      }
      .price { font-size: 28px; font-weight: 900; color: #4f46e5; }
      table { width: 100%; border-collapse: collapse; margin: 16px 0; }
      th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
      th { background: #f1f5f9; font-weight: 700; }
      .disclaimer { 
        font-size: 10px; 
        color: #94a3b8; 
        margin-top: 30px; 
        padding: 16px; 
        background: #f8fafc; 
        border-radius: 8px; 
      }
    </style>
  `

  switch (documentType) {
    case "cma":
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Comparative Market Analysis</title>
          ${baseStyles}
        </head>
        <body>
          <div class="header">
            <h1>Comparative Market Analysis</h1>
            <p>${data.address || "Property Address"}</p>
            <p>Prepared by ${agent.first_name} ${agent.last_name} | ${(agent.brokerage as any)?.name || ""}</p>
            <p>${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
          </div>

          <div class="section">
            <h2>Market Snapshot</h2>
            <div class="highlight">
              <p>${data.marketSnapshot || "Current market analysis based on recent comparable sales."}</p>
            </div>
          </div>

          <div class="section">
            <h2>Strategic Pricing Recommendations</h2>
            <div class="grid">
              <div class="card">
                <h3>Aggressive Pricing</h3>
                <div class="price">${data.pricing?.aggressive || "$0"}</div>
                <p>Target for premium positioning</p>
              </div>
              <div class="card">
                <h3>Market-Aligned</h3>
                <div class="price">${data.pricing?.market || "$0"}</div>
                <p>Recommended competitive price</p>
              </div>
              <div class="card">
                <h3>Speed to Sell</h3>
                <div class="price">${data.pricing?.speed || "$0"}</div>
                <p>Quick sale strategy</p>
              </div>
            </div>
          </div>

          <div class="section">
            <h2>Marketing Strategy</h2>
            <p><strong>Target Buyer Profile:</strong> ${data.marketing?.buyerProfile || "N/A"}</p>
            <p><strong>Pre-Listing Actions:</strong> ${data.marketing?.preList || "N/A"}</p>
            <p><strong>Online Marketing:</strong> ${data.marketing?.online || "N/A"}</p>
            <p><strong>Traditional Marketing:</strong> ${data.marketing?.offline || "N/A"}</p>
          </div>

          <div class="footer">
            <p><strong>${agent.first_name} ${agent.last_name}</strong></p>
            <p>${agent.email} | ${agent.phone || ""}</p>
            <p>License: ${agent.license_number || "N/A"}</p>
          </div>

          <div class="disclaimer">
            <strong>CMA Disclaimer:</strong> This report is a Comparative Market Analysis (CMA) prepared by a real estate licensee for marketing and pricing guidance. It is not an appraisal of value as defined under the Uniform Standards of Professional Appraisal Practice (USPAP). The analysis is based on publicly available data and professional judgment but should not be used for lending or legal purposes. For official property valuation, consult a licensed appraiser.
          </div>
        </body>
        </html>
      `

    case "net_sheet":
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Estimated Net Proceeds</title>
          ${baseStyles}
        </head>
        <body>
          <div class="header">
            <h1>Estimated Net Proceeds Statement</h1>
            <p>${data.address || "Property Address"}</p>
            <p>Prepared for ${data.sellerName || "Seller"}</p>
            <p>${new Date().toLocaleDateString()}</p>
          </div>

          <div class="section">
            <h2>Sale Price Scenarios</h2>
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Sale Price</th>
                  <th>Est. Net Proceeds</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>List Price</td>
                  <td class="price">${data.listPrice || "$0"}</td>
                  <td>${data.netAtListPrice || "$0"}</td>
                </tr>
                <tr>
                  <td>Current Offer</td>
                  <td class="price">${data.offerPrice || "$0"}</td>
                  <td>${data.netAtOfferPrice || "$0"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="section">
            <h2>Estimated Closing Costs</h2>
            <table>
              <tbody>
                <tr><td>Sale Price</td><td>${data.offerPrice || "$0"}</td></tr>
                <tr><td>Less: Commission (${data.commissionRate || 6}%)</td><td>-${data.commission || "$0"}</td></tr>
                <tr><td>Less: Closing Costs</td><td>-${data.closingCosts || "$0"}</td></tr>
                <tr><td>Less: Mortgage Payoff</td><td>-${data.mortgageBalance || "$0"}</td></tr>
                <tr><td>Less: Liens/HOA</td><td>-${data.liens || "$0"}</td></tr>
                <tr><td>Plus: Prorations</td><td>+${data.prorations || "$0"}</td></tr>
                <tr style="border-top: 2px solid #1e293b; font-weight: 700;">
                  <td><strong>Estimated Net Proceeds</strong></td>
                  <td class="price">${data.netProceeds || "$0"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="footer">
            <p><strong>${agent.first_name} ${agent.last_name}</strong></p>
            <p>${agent.email} | ${agent.phone || ""}</p>
          </div>

          <div class="disclaimer">
            <strong>Estimate Disclaimer:</strong> This net proceeds estimate is for informational purposes only and is not a guarantee of actual proceeds. Actual costs may vary. Consult with your title company and lender for precise closing cost calculations.
          </div>
        </body>
        </html>
      `

    default:
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Document</title>
          ${baseStyles}
        </head>
        <body>
          <div class="header">
            <h1>${documentType.replace("_", " ").toUpperCase()}</h1>
            <p>Prepared by ${agent.first_name} ${agent.last_name}</p>
          </div>
          <div class="section">
            <pre>${JSON.stringify(data, null, 2)}</pre>
          </div>
        </body>
        </html>
      `
  }
}

// =====================================================
// HTML TO PDF CONVERSION
// =====================================================

async function htmlToPDF(html: string, options: PDFGenerationOptions): Promise<Buffer> {
  // In production, use Puppeteer or similar
  // For now, return mock buffer for demonstration
  // Real implementation would be:
  // const browser = await puppeteer.launch()
  // const page = await browser.newPage()
  // await page.setContent(html)
  // const pdf = await page.pdf({ format: options.format || 'letter' })
  // await browser.close()
  // return pdf

  // Mock PDF buffer (in real app, this would be actual PDF binary)
  return Buffer.from(html, "utf-8")
}

// =====================================================
// SEND DOCUMENT EMAIL
// =====================================================

async function sendDocumentEmail(params: {
  to: string
  documentType: string
  pdfUrl: string
  agentName: string
  agentEmail: string
  brokerageId: string
  contactId?: string
  agentId?: string
}) {
  const documentNames: Record<string, string> = {
    cma: "Comparative Market Analysis",
    listing_packet: "Listing Packet",
    net_sheet: "Net Proceeds Estimate",
    buyer_guide: "Buyer's Guide",
    seller_guide: "Seller's Guide",
    offer_summary: "Offer Summary",
  }

  const subject = `Your ${documentNames[params.documentType] || "Document"} from ${params.agentName}`

  const body = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #4f46e5;">Your ${documentNames[params.documentType]} is Ready</h2>
      <p>Hi there,</p>
      <p>${params.agentName} has prepared your ${documentNames[params.documentType].toLowerCase()} and it's ready to view.</p>
      <p style="margin: 30px 0;">
        <a href="${params.pdfUrl}" 
           style="background: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600;">
          Download Your Document
        </a>
      </p>
      <p style="color: #64748b; font-size: 14px;">
        If you have any questions, please contact ${params.agentName} at ${params.agentEmail}.
      </p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
      <p style="color: #94a3b8; font-size: 12px;">
        This document was generated by Smart Engine AI Real Estate Platform.
      </p>
    </div>
  `

  return await dispatchEmail({
    brokerageId: params.brokerageId,
    to: params.to,
    subject,
    html: body,
    from: params.agentEmail,
    contactId: params.contactId,
    agentId: params.agentId,
    channelPurpose: "transactional",
  })
}

// =====================================================
// GET GENERATED DOCUMENTS
// =====================================================

export async function getGeneratedDocuments(filters: {
  contactId?: string
  listingId?: string
  agentId?: string
  documentType?: string
}) {
  const supabase = await createClient()

  try {
    let query = supabase
      .from("generated_documents")
      .select("*")
      .order("created_at", { ascending: false })

    if (filters.contactId) query = query.eq("contact_id", filters.contactId)
    if (filters.listingId) query = query.eq("listing_id", filters.listingId)
    if (filters.agentId) query = query.eq("agent_id", filters.agentId)
    if (filters.documentType) query = query.eq("document_type", filters.documentType)

    const { data, error } = await query

    if (error) throw error

    return { success: true, documents: data }
  } catch (error) {
    console.error("Get generated documents error:", error)
    return { success: false, error: "Failed to fetch documents" }
  }
}

// =====================================================
// DELETE DOCUMENT
// =====================================================

export async function deleteGeneratedDocument(documentId: string) {
  const supabase = await createClient()

  try {
    // Get document to retrieve blob URL
    const { data: doc } = await supabase
      .from("generated_documents")
      .select("blob_id")
      .eq("id", documentId)
      .single()

    if (doc?.blob_id) {
      // Delete from Vercel Blob
      // await del(doc.blob_id) // Requires @vercel/blob delete function
    }

    // Delete from database
    const { error } = await supabase
      .from("generated_documents")
      .delete()
      .eq("id", documentId)

    if (error) throw error

    return { success: true }
  } catch (error) {
    console.error("Delete document error:", error)
    return { success: false, error: "Failed to delete document" }
  }
}
