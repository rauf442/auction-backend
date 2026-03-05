// backend/src/routes/invoice-emails.ts
import express, { Request, Response } from 'express'
import { supabaseAdmin } from '../utils/supabase'
import { authMiddleware } from '../middleware/auth'
import { EmailService } from '../utils/email-service'
import { EmailCore } from '../utils/email-core'
import {
  replaceEmailPlaceholders,
  getDefaultWinningBidTemplate,
  getDefaultPaymentConfirmationTemplate,
  getDefaultShippingConfirmationTemplate,
  getDefaultVendorSaleNotificationTemplate,
  getDefaultVendorPaymentConfirmationTemplate
} from '../utils/email-templates'
import { calculateTotalAmount } from '../utils/invoice-calculations'

// Extend Request interface to include user property
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router()

// Apply auth middleware to all routes
router.use(authMiddleware)

// Debug email for testing (will be used as BCC or primary recipient in development)
const DEBUG_EMAIL = process.env.DEBUG_EMAIL || 'test@example.com'

/**
 * GET /api/invoices/:invoiceId/email-preview
 * Preview email before sending
 */
router.get('/:invoiceId/email-preview', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    const { type } = req.query // All email types including vendor

    const validTypes = ['winning_bid', 'payment_confirmation', 'shipping_confirmation', 'vendor_sale_notification', 'vendor_payment_confirmation']
    if (!type || !validTypes.includes(type as string)) {
      return res.status(400).json({
        success: false,
        message: `Invalid email type. Must be one of: ${validTypes.join(', ')}`
      })
    }

    // Get invoice with all necessary data
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(
          id, name, code, brand_address, contact_email, contact_phone, 
          business_whatsapp_number, logo_url, website_url,
          winning_bid_email_subject, winning_bid_email_body,
          payment_confirmation_email_subject, payment_confirmation_email_body,
          shipping_confirmation_email_subject, shipping_confirmation_email_body,
          vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body,
          vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body
        )
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    // Determine recipient based on email type and invoice type
    let recipientEmail = ''
    let recipientName = ''
    
    if (invoice.type === 'vendor' && (type === 'vendor_sale_notification' || type === 'vendor_payment_confirmation')) {
      // For vendor emails, get vendor details
      recipientEmail = invoice.client?.email || invoice.buyer_email || ''
      recipientName = invoice.client?.company_name 
        || (invoice.client ? `${invoice.client.first_name || ''} ${invoice.client.last_name || ''}`.trim() : '')
        || `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim() 
        || 'Vendor'
    } else {
      // For buyer emails, get client details
      recipientEmail = invoice.client?.email || invoice.buyer_email || ''
      recipientName = invoice.client?.company_name 
        || (invoice.client ? `${invoice.client.first_name} ${invoice.client.last_name}`.trim() : '')
        || `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()
    }

    if (!recipientEmail) {
      return res.status(400).json({
        success: false,
        message: 'No email address found for this client'
      })
    }

    const brandName = invoice.brand?.name || 'Aurum Auctions'
    const brandEmail = invoice.brand?.contact_email || process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com'
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)

    // Get items for comprehensive placeholder mapping
    let items: any[] = []
    if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', invoice.item_ids)
      items = itemsData || []
    }

    // Use EmailService.previewEmailTemplate to ensure preview matches actual sent email
    const emailServiceType = type === 'vendor_sale_notification' ? 'vendor_sale_notification' :
                              type === 'vendor_payment_confirmation' ? 'vendor_payment_confirmation' :
                              type as 'winning_bid' | 'payment_confirmation' | 'shipping_confirmation'

    // Get comprehensive email preview with footer
    const emailPreview = await EmailService.previewEmailTemplate(
      invoice.brand_id,
      emailServiceType,
      {}, // Variables will be auto-generated from invoice data
      invoice,
      invoice.brand,
      items
    )

    if (!emailPreview) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate email preview'
      })
    }

    // Return preview with ACTUAL recipient email (not test email)
    res.json({
      success: true,
      preview: {
        to: recipientEmail, // Show actual recipient email in preview
        from: brandEmail,
        subject: emailPreview.subject,
        body: emailPreview.body // Includes footer and all formatting
      }
    })

  } catch (error: any) {
    console.error('Error in GET /invoices/:invoiceId/email-preview:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

/**
 * POST /api/invoices/:invoiceId/send-email
 * Send email after preview approval
 */
router.post('/:invoiceId/send-email', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    const { type } = req.body // All email types including vendor

    const validTypes = ['winning_bid', 'payment_confirmation', 'shipping_confirmation', 'vendor_sale_notification', 'vendor_payment_confirmation']
    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid email type. Must be one of: ${validTypes.join(', ')}`
      })
    }

    // Get invoice with all necessary data
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(
          id, name, code, brand_address, contact_email, contact_phone, 
          business_whatsapp_number, logo_url, website_url,
          winning_bid_email_subject, winning_bid_email_body,
          payment_confirmation_email_subject, payment_confirmation_email_body,
          shipping_confirmation_email_subject, shipping_confirmation_email_body,
          vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body,
          vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body
        )
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    const clientEmail = invoice.client?.email || invoice.buyer_email
    const clientName = invoice.client
      ? `${invoice.client.first_name} ${invoice.client.last_name}`.trim()
      : `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()

    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'No email address found for this client'
      })
    }

    const brandName = invoice.brand?.name || 'Aurum Auctions'
    const brandEmail = invoice.brand?.contact_email || process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com'
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    const baseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'
    // Fetch items for placeholder replacement
let items: any[] = []
if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
  const { data: itemsData } = await supabaseAdmin
    .from('items')
    .select('*')
    .in('id', invoice.item_ids)
  items = itemsData || []
}
    // Prepare variables for template replacement
    const variables: any = {
      client_name: clientName,
      invoice_number: invoice.invoice_number,
      invoice_id: invoiceId,
      brand_name: brandName,
      purchase_amount: `£${totalAmount.toFixed(2)}`,
      total_amount: `£${totalAmount.toFixed(2)}`,
      amount: totalAmount.toFixed(2),
      payment_date: new Date().toLocaleDateString('en-GB'),
      base_url: baseUrl,
      contact_email: invoice.brand?.contact_email || '',
      contact_phone: invoice.brand?.contact_phone || '',
      whatsapp_number: invoice.brand?.business_whatsapp_number || '',
      item_title: items?.[0]?.title || invoice.title || 'Your auction item',
      lot_number: invoice.lot_ids?.[0] || 'N/A',
      lot_ids: invoice.lot_ids?.join(', ') || 'N/A',
      final_bid_amount: `£${totalAmount.toFixed(2)}`,
      hammer_price: `£${(invoice.sale_prices?.reduce((sum: number, p: number) => sum + p, 0) || 0).toFixed(2)}`,
      payment_terms: '7 days',
      reference_number: invoice.invoice_number,
      auction_name: invoice.auction?.long_name || invoice.auction?.short_name || 'Auction'
    }

    let subject = ''
    let body = ''

    // Get template based on type
    const templates = invoice.brand

    switch (type) {
      case 'winning_bid':
        subject = templates?.winning_bid_email_subject || 'Congratulations! You have won [ITEM_TITLE]'
        body = templates?.winning_bid_email_body || getDefaultWinningBidTemplate()
        break

      case 'payment_confirmation':
        subject = templates?.payment_confirmation_email_subject || 'Payment Confirmed - [INVOICE_NUMBER] | [BRAND_NAME]'
        body = templates?.payment_confirmation_email_body || getDefaultPaymentConfirmationTemplate()
        break

      case 'shipping_confirmation':
        subject = templates?.shipping_confirmation_email_subject || 'Action Required: Please Confirm Shipping Method'
        body = templates?.shipping_confirmation_email_body || getDefaultShippingConfirmationTemplate()
        break

      case 'vendor_sale_notification':
        subject = templates?.vendor_post_sale_invoice_email_subject || 'Sale Notification - [INVOICE_NUMBER] | [BRAND_NAME]'
        body = templates?.vendor_post_sale_invoice_email_body || getDefaultVendorSaleNotificationTemplate()
        break

      case 'vendor_payment_confirmation':
        subject = templates?.vendor_paid_acknowledgement_email_subject || 'Payment Confirmation - [INVOICE_NUMBER] | [BRAND_NAME]'
        body = templates?.vendor_paid_acknowledgement_email_body || getDefaultVendorPaymentConfirmationTemplate()
        break

      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid email type'
        })
    }

    // Replace variables in subject and body
    subject = replaceEmailPlaceholders(subject, variables)
    body = replaceEmailPlaceholders(body, variables)

    // Send email using Brevo
    // For testing: send to DEBUG_EMAIL, in production: send to clientEmail
    const recipientEmail = process.env.NODE_ENV === 'production' ? clientEmail : DEBUG_EMAIL

    console.log(`📧 Sending ${type} email to ${recipientEmail} (original: ${clientEmail})`)

    const emailSent = await EmailCore.sendEmail({
      to: recipientEmail,
      subject,
      html: body,
      from: brandEmail,
      replyTo: invoice.brand?.contact_email
    })

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send email'
      })
    }

    // Log email sent to database (optional)
    try {
      await supabaseAdmin
        .from('email_logs')
        .insert({
          invoice_id: parseInt(invoiceId),
          email_type: type,
          recipient_email: clientEmail,
          sent_to_email: recipientEmail,
          subject,
          sent_at: new Date().toISOString(),
          status: 'sent'
        })
    } catch (logError: any) {
      console.warn('Failed to log email to database (table may not exist):', logError?.message || logError)
      // Don't fail the request if logging fails
    }

    res.json({
      success: true,
      message: `${type.replace('_', ' ')} email sent successfully to ${recipientEmail}`,
      sentTo: recipientEmail
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:invoiceId/send-email:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

export default router

