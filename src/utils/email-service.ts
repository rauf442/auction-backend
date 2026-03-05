// backend/src/utils/email-service.ts
/**
 * High-level email service functions for sending branded emails
 * Uses email-core for sending and email-templates for placeholder management
 */

import { supabaseAdmin } from './supabase'
import { EmailCore, EmailAttachment } from './email-core'
import {
  buildPlaceholderMap,
  replaceEmailPlaceholders,
  wrapEmailWithFooter,
  getDefaultWinningBidTemplate,
  getDefaultPaymentConfirmationTemplate,
  getDefaultShippingConfirmationTemplate,
  getDefaultVendorSaleNotificationTemplate,
  getDefaultVendorPaymentConfirmationTemplate,
  BrandData,
  PlaceholderData
} from './email-templates'
import {
  generateBuyerInvoicePDF,
  generateVendorInvoicePDF
} from './invoice-pdf-generator'

interface EmailVariables {
  [key: string]: string | number
}

interface BrandEmailTemplates {
  winning_bid_email_subject?: string
  winning_bid_email_body?: string
  payment_confirmation_email_subject?: string
  payment_confirmation_email_body?: string
  shipping_confirmation_email_subject?: string
  shipping_confirmation_email_body?: string
  vendor_post_sale_invoice_email_subject?: string
  vendor_post_sale_invoice_email_body?: string
  vendor_paid_acknowledgement_email_subject?: string
  vendor_paid_acknowledgement_email_body?: string
}

export class EmailService {
  /**
   * Fetch email templates for a specific brand
   */
  static async getBrandEmailTemplates(brandId: number): Promise<BrandEmailTemplates | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('brands')
        .select('winning_bid_email_subject, winning_bid_email_body, payment_confirmation_email_subject, payment_confirmation_email_body, shipping_confirmation_email_subject, shipping_confirmation_email_body, vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body, vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body')
        .eq('id', brandId)
        .single()

      if (error) {
        console.error('❌ Error fetching brand email templates:', error)
        return null
      }

      return data
    } catch (error: any) {
      console.error('❌ Error in getBrandEmailTemplates:', error.message)
      return null
    }
  }

  /**
   * Generate and attach invoice PDF to email
   */
  static async attachInvoicePdf(
    invoice: any,
    brand: any,
    emailType: string,
    items?: any[]
  ): Promise<EmailAttachment | null> {
    try {
      let pdfType: 'internal' | 'final' = 'final'
      
      // Determine PDF type based on email type
      switch (emailType) {
        case 'winning_bid':
          pdfType = 'internal' // Without shipping
          break
        case 'payment_confirmation':
        case 'shipping_confirmation':
        case 'vendor_post_sale':
        case 'vendor_paid_acknowledgement':
          pdfType = 'final' // With all details
          break
        default:
          pdfType = 'final'
      }

      console.log(`📎 Generating ${pdfType} PDF for invoice ${invoice.invoice_number}`)

      // Generate PDF based on invoice type
      let pdfBuffer: Buffer
      if (invoice.type === 'vendor') {
        pdfBuffer = await generateVendorInvoicePDF(invoice, brand, pdfType, items || [])
      } else {
        pdfBuffer = await generateBuyerInvoicePDF(invoice, brand, pdfType, items || [])
      }

      // Convert buffer to base64
      const base64Pdf = pdfBuffer.toString('base64')

      return {
        content: base64Pdf,
        name: `invoice-${invoice.invoice_number}.pdf`
      }
    } catch (error: any) {
      console.error('❌ Error generating PDF attachment:', error)
      return null
    }
  }

  /**
   * Send winning bid email using custom template
   */
  static async sendWinningBidEmail(
    brandId: number,
    clientEmail: string,
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<boolean> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      if (!templates?.winning_bid_email_subject || !templates?.winning_bid_email_body) {
        console.log('⚠️ No custom winning bid template found, using default')
        return false
      }

      // Use comprehensive placeholder system
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      const subject = replaceEmailPlaceholders(templates.winning_bid_email_subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(templates.winning_bid_email_body, placeholderMap)
      const htmlBody = wrapEmailWithFooter(bodyContent, brand)

      // Attach invoice PDF (internal - without shipping)
      const attachments: EmailAttachment[] = []
      if (invoice && brand) {
        const pdfAttachment = await this.attachInvoicePdf(invoice, brand, 'winning_bid', items)
        if (pdfAttachment) {
          attachments.push(pdfAttachment)
        }
      }

      return await EmailCore.sendEmail({
        to: clientEmail,
        subject,
        html: htmlBody,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        attachments
      })
    } catch (error: any) {
      console.error('❌ Error sending winning bid email:', error.message)
      return false
    }
  }

  /**
   * Send payment confirmation email using custom template
   */
  static async sendPaymentConfirmationEmailCustom(
    brandId: number,
    clientEmail: string,
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<boolean> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      if (!templates?.payment_confirmation_email_subject || !templates?.payment_confirmation_email_body) {
        console.log('⚠️ No custom payment confirmation template found, falling back to default')
        return false
      }

      // Use comprehensive placeholder system
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      const subject = replaceEmailPlaceholders(templates.payment_confirmation_email_subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(templates.payment_confirmation_email_body, placeholderMap)
      const htmlBody = wrapEmailWithFooter(bodyContent, brand)

      // Attach invoice PDF (final - with shipping)
      const attachments: EmailAttachment[] = []
      if (invoice && brand) {
        const pdfAttachment = await this.attachInvoicePdf(invoice, brand, 'payment_confirmation', items)
        if (pdfAttachment) {
          attachments.push(pdfAttachment)
        }
      }

      return await EmailCore.sendEmail({
        to: clientEmail,
        subject,
        html: htmlBody,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        attachments
      })
    } catch (error: any) {
      console.error('❌ Error sending payment confirmation email:', error.message)
      return false
    }
  }

  /**
   * Send shipping confirmation email using custom template
   */
  static async sendShippingConfirmationEmailCustom(
    brandId: number,
    clientEmail: string,
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<boolean> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      if (!templates?.shipping_confirmation_email_subject || !templates?.shipping_confirmation_email_body) {
        console.log('⚠️ No custom shipping confirmation template found, falling back to default')
        return false
      }

      // Use comprehensive placeholder system
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      const subject = replaceEmailPlaceholders(templates.shipping_confirmation_email_subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(templates.shipping_confirmation_email_body, placeholderMap)
      const htmlBody = wrapEmailWithFooter(bodyContent, brand)

      // Attach invoice PDF (final - with shipping)
      const attachments: EmailAttachment[] = []
      if (invoice && brand) {
        const pdfAttachment = await this.attachInvoicePdf(invoice, brand, 'shipping_confirmation', items)
        if (pdfAttachment) {
          attachments.push(pdfAttachment)
        }
      }

      return await EmailCore.sendEmail({
        to: clientEmail,
        subject,
        html: htmlBody,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        attachments
      })
    } catch (error: any) {
      console.error('❌ Error sending shipping confirmation email:', error.message)
      return false
    }
  }

  /**
   * Send vendor sale notification email using brand template
   */
  static async sendVendorSaleNotificationEmail(
    brandId: number,
    vendorEmail: string,
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<boolean> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      if (!templates?.vendor_post_sale_invoice_email_subject || !templates?.vendor_post_sale_invoice_email_body) {
        console.log('⚠️ No custom vendor sale notification template found, using default')
        return false
      }

      // Use comprehensive placeholder system
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      const subject = replaceEmailPlaceholders(templates.vendor_post_sale_invoice_email_subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(templates.vendor_post_sale_invoice_email_body, placeholderMap)
//            const templates = await this.getBrandEmailTemplates(brandId)
// const emailSubjectTemplate = templates?.vendor_post_sale_invoice_email_subject || 'Post-Sale Invoice - [INVOICE_NUMBER]'
// const emailBodyTemplate = templates?.vendor_post_sale_invoice_email_body || `
// Dear [VENDOR_NAME],<br><br>
// Please find attached your post-sale invoice <strong>[INVOICE_NUMBER]</strong> for the recent auction.<br><br>
// <strong>Sale Summary:</strong><br>
// Hammer Price: [HAMMER_PRICE]<br>
// Vendor Premium: [VENDOR_PREMIUM]<br>
// Total: [TOTAL_AMOUNT]<br><br>
// Please review the attached invoice for full details.<br><br>
// Best regards,<br>
// [BRAND_NAME]
// `
// // Use comprehensive placeholder system
// const placeholderMap = invoice && brand
//     ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
//     : Object.keys(variables).reduce((acc, key) => {
//         acc[key.toUpperCase()] = String(variables[key])
//         return acc
//       }, {} as Record<string, string>)
// const subject = replaceEmailPlaceholders(emailSubjectTemplate, placeholderMap)
// const bodyContent = replaceEmailPlaceholders(emailBodyTemplate, placeholderMap)
      const htmlBody = wrapEmailWithFooter(bodyContent, brand)

      // Attach vendor invoice PDF (final)
      const attachments: EmailAttachment[] = []
      if (invoice && brand) {
        const pdfAttachment = await this.attachInvoicePdf(invoice, brand, 'vendor_post_sale', items)
        if (pdfAttachment) {
          attachments.push(pdfAttachment)
        }
      }

      return await EmailCore.sendEmail({
        to: vendorEmail,
        subject,
        html: htmlBody,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        attachments
      })
    } catch (error: any) {
      console.error('❌ Error sending vendor sale notification email:', error.message)
      return false
    }
  }

  /**
   * Send vendor payment confirmation email using brand template
   */
  static async sendVendorPaymentConfirmationEmail(
    brandId: number,
    vendorEmail: string,
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<boolean> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      if (!templates?.vendor_paid_acknowledgement_email_subject || !templates?.vendor_paid_acknowledgement_email_body) {
        console.log('⚠️ No custom vendor payment confirmation template found, using default')
        return false
      }

      // Use comprehensive placeholder system
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      const subject = replaceEmailPlaceholders(templates.vendor_paid_acknowledgement_email_subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(templates.vendor_paid_acknowledgement_email_body, placeholderMap)
      const htmlBody = wrapEmailWithFooter(bodyContent, brand)

      // Attach vendor invoice PDF (final)
      const attachments: EmailAttachment[] = []
      if (invoice && brand) {
        const pdfAttachment = await this.attachInvoicePdf(invoice, brand, 'vendor_paid_acknowledgement', items)
        if (pdfAttachment) {
          attachments.push(pdfAttachment)
        }
      }

      return await EmailCore.sendEmail({
        to: vendorEmail,
        subject,
        html: htmlBody,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        attachments
      })
    } catch (error: any) {
      console.error('❌ Error sending vendor payment confirmation email:', error.message)
      return false
    }
  }

  /**
   * Preview email template with variables
   */
  static async previewEmailTemplate(
    brandId: number,
    templateType: 'winning_bid' | 'payment_confirmation' | 'shipping_confirmation' | 'vendor_sale_notification' | 'vendor_payment_confirmation',
    variables: EmailVariables,
    invoice?: any,
    brand?: any,
    items?: any[]
  ): Promise<{ subject: string; body: string } | null> {
    try {
      const templates = await this.getBrandEmailTemplates(brandId)

      let subject = ''
      let body = ''

      // Use comprehensive placeholder system if invoice data available
      const placeholderMap = invoice && brand 
        ? buildPlaceholderMap({ invoice, client: invoice.client, brand, auction: invoice.auction, items })
        : Object.keys(variables).reduce((acc, key) => {
            acc[key.toUpperCase()] = String(variables[key])
            return acc
          }, {} as Record<string, string>)

      switch (templateType) {
        case 'winning_bid':
          subject = templates?.winning_bid_email_subject || `Congratulations! You have won ${placeholderMap['ITEM_TITLE'] || 'your auction item'}`
          body = templates?.winning_bid_email_body || getDefaultWinningBidTemplate()
          break
        case 'payment_confirmation':
          subject = templates?.payment_confirmation_email_subject || 'Payment Confirmed - [INVOICE_NUMBER] | [BRAND_NAME]'
          body = templates?.payment_confirmation_email_body || getDefaultPaymentConfirmationTemplate()
          break
        case 'shipping_confirmation':
          subject = templates?.shipping_confirmation_email_subject || 'Action Required: Please Confirm Shipping Method and Provide Collection Details'
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
      }

      if (!subject || !body) {
        return null
      }

      // Replace placeholders and add footer
      const processedSubject = replaceEmailPlaceholders(subject, placeholderMap)
      const bodyContent = replaceEmailPlaceholders(body, placeholderMap)
      const processedBody = wrapEmailWithFooter(bodyContent, brand)

      return {
        subject: processedSubject,
        body: processedBody
      }
    } catch (error: any) {
      console.error('❌ Error previewing email template:', error.message)
      return null
    }
  }

  /**
   * Send payment confirmation email with default template fallback
   * Legacy method for backward compatibility
   */
  static async sendPaymentConfirmationEmail(
    clientEmail: string,
    clientName: string,
    invoiceNumber: string,
    brandName: string,
    paymentType: 'invoice' | 'shipping',
    amount: number,
    invoiceId: string,
    brandId?: number,
    clientId?: number,
    brandCode?: string
  ): Promise<boolean> {
    try {
    // Try custom template first if brandId is provided
    if (brandId) {
      const variables = {
        client_name: clientName,
        invoice_number: invoiceNumber,
        brand_name: brandName,
        amount: amount.toFixed(2),
        base_url: process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000',
        invoice_id: invoiceId,
        payment_date: new Date().toLocaleDateString('en-GB')
      }

      const success = await this.sendPaymentConfirmationEmailCustom(brandId, clientEmail, variables)
      if (success) {
        return true
      }
      console.log('⚠️ Custom template failed, falling back to default template')
    }

    // Fall back to default implementation
    // Get brand-specific base URL
    let baseUrl = 'http://localhost:3000'
    if (brandCode) {
      const upperBrandCode = brandCode.toUpperCase()
      if (upperBrandCode === 'AURUM') {
        baseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL_AURUM || process.env.PUBLIC_FRONTEND_URL_AURUM || 'https://aurumauctions.com'
      } else if (upperBrandCode === 'METSAB') {
        baseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL_METSAB || process.env.PUBLIC_FRONTEND_URL_METSAB || 'https://met-sab.com'
      } else {
        baseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'
      }
    } else {
      baseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'
    }

    let subject = ''
    let htmlContent = ''

    if (paymentType === 'invoice') {
      subject = `Payment Received - Invoice ${invoiceNumber} | ${brandName}`
      htmlContent = this.generateInvoicePaymentEmail(clientName, invoiceNumber, brandName, amount, baseUrl, invoiceId, clientId)
    } else if (paymentType === 'shipping') {
      subject = `Shipping Payment Confirmed - Order Processing Started | ${brandName}`
      htmlContent = this.generateShippingPaymentEmail(clientName, invoiceNumber, brandName, amount, baseUrl, invoiceId, clientId)
    }

      return await EmailCore.sendEmail({
      to: clientEmail,
      subject,
      html: htmlContent,
      from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com'
    })
    } catch (error: any) {
      console.error('❌ Error in sendPaymentConfirmationEmail:', error.message)
      return false
    }
  }

  /**
   * Generate professional invoice payment email template (legacy)
   */
  private static generateInvoicePaymentEmail(
    clientName: string,
    invoiceNumber: string,
    brandName: string,
    amount: number,
    baseUrl: string,
    invoiceId: string,
    clientId?: number
  ): string {
    // Generate public invoice URL with client ID for access
    const invoiceUrl = clientId ? `${baseUrl}/invoice/${invoiceId}/${clientId}` : `${baseUrl}/invoice/${invoiceId}`
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Confirmation - ${brandName}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

          <!-- Header -->
          <div style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); padding: 40px 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Payment Confirmed</h1>
            <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 16px;">Thank you for your payment</p>
          </div>

          <!-- Content -->
          <div style="padding: 40px 30px;">
            <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear ${clientName},</h2>

            <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
              We have successfully received your payment for <strong>Invoice ${invoiceNumber}</strong>.
              Your transaction has been processed and confirmed.
            </p>

            <!-- Payment Details Card -->
            <div style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border: 1px solid #e5e7eb; border-radius: 12px; padding: 25px; margin: 30px 0;">
              <h3 style="color: #1f2937; margin: 0 0 20px 0; font-size: 18px;">Payment Details</h3>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="color: #6b7280; font-weight: 500;">Invoice Number:</span>
                <span style="color: #1f2937; font-weight: 600;">${invoiceNumber}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="color: #6b7280; font-weight: 500;">Amount Paid:</span>
                <span style="color: #059669; font-weight: 700; font-size: 18px;">£${amount.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #6b7280; font-weight: 500;">Payment Date:</span>
                <span style="color: #1f2937; font-weight: 600;">${new Date().toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
                })}</span>
              </div>
            </div>

            <!-- Next Steps -->
            <div style="background-color: #f0f9ff; border-left: 4px solid #2563eb; padding: 20px; margin: 30px 0;">
              <h3 style="color: #1e40af; margin: 0 0 15px 0; font-size: 18px;">What's Next?</h3>
              <p style="color: #1e40af; margin: 0; line-height: 1.6;">
                Your invoice payment has been processed successfully. You can now proceed to select your shipping method and complete your order.
              </p>
            </div>

            <!-- CTA Button -->
            <div style="text-align: center; margin: 40px 0;">
              <a href="${invoiceUrl}"
                 style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);">
                View Invoice
              </a>
            </div>

            <!-- Contact Info -->
            <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
              <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
                If you have any questions about your order, please don't hesitate to contact us.
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
                This email was sent by ${brandName}. Please keep this email for your records.
              </p>
            </div>
          </div>

          <!-- Footer -->
          <div style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #e5e7eb;">
            <p style="color: #6b7280; font-size: 14px; margin: 0; text-align: center;">
              Best regards,<br>
              <strong>The ${brandName} Team</strong>
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  }

  /**
   * Generate professional shipping payment email template (legacy)
   */
  private static generateShippingPaymentEmail(
    clientName: string,
    invoiceNumber: string,
    brandName: string,
    amount: number,
    baseUrl: string,
    invoiceId: string,
    clientId?: number
  ): string {
    // Generate public invoice tracking URL with client ID for access
    const trackingUrl = clientId ? `${baseUrl}/invoice/${invoiceId}/${clientId}/track` : `${baseUrl}/invoice/${invoiceId}/track`
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Shipping Payment Confirmed - ${brandName}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

          <!-- Header -->
          <div style="background: linear-gradient(135deg, #059669 0%, #047857 100%); padding: 40px 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Shipping Confirmed</h1>
            <p style="color: #d1fae5; margin: 10px 0 0 0; font-size: 16px;">Your order is now being processed</p>
          </div>

          <!-- Content -->
          <div style="padding: 40px 30px;">
            <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear ${clientName},</h2>

            <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
              Thank you for your shipping payment! We have received your payment and your order is now being processed for shipment.
            </p>

            <!-- Payment Details Card -->
            <div style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 1px solid #bbf7d0; border-radius: 12px; padding: 25px; margin: 30px 0;">
              <h3 style="color: #065f46; margin: 0 0 20px 0; font-size: 18px;">Shipping Payment Details</h3>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="color: #065f46; font-weight: 500;">Invoice Number:</span>
                <span style="color: #065f46; font-weight: 600;">${invoiceNumber}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="color: #065f46; font-weight: 500;">Shipping Amount:</span>
                <span style="color: #059669; font-weight: 700; font-size: 18px;">£${amount.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #065f46; font-weight: 500;">Payment Date:</span>
                <span style="color: #065f46; font-weight: 600;">${new Date().toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
                })}</span>
              </div>
            </div>

            <!-- Next Steps -->
            <div style="background-color: #f0f9ff; border-left: 4px solid #059669; padding: 20px; margin: 30px 0;">
              <h3 style="color: #065f46; margin: 0 0 15px 0; font-size: 18px;">What Happens Next?</h3>
              <ul style="color: #065f46; margin: 0; padding-left: 20px; line-height: 1.8;">
                <li>Our team will prepare your item(s) for shipping within 1-2 business days</li>
                <li>You will receive a tracking number once your order is dispatched</li>
                <li>Estimated delivery: 3-5 business days (UK), 7-14 days (International)</li>
                <li>We will send you updates at each stage of the shipping process</li>
              </ul>
            </div>

            <!-- CTA Button -->
            <div style="text-align: center; margin: 40px 0;">
              <a href="${trackingUrl}"
                 style="background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(5, 150, 105, 0.3);">
                Track Your Order
              </a>
            </div>

            <!-- Contact Info -->
            <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
              <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
                If you have any questions about your shipment, please don't hesitate to contact us.
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
                This email was sent by ${brandName}. Please keep this email for your shipping records.
              </p>
            </div>
          </div>

          <!-- Footer -->
          <div style="background-color: #f9fafb; padding: 20px 30px; border-top: 1px solid #e5e7eb;">
            <p style="color: #6b7280; font-size: 14px; margin: 0; text-align: center;">
              Best regards,<br>
              <strong>The ${brandName} Team</strong>
            </p>
          </div>
        </div>
      </body>
      </html>
    `
  }
}

export default EmailService
