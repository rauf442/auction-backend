// backend/src/utils/email-templates.ts
/**
 * Email template management with comprehensive placeholder system
 * Handles placeholder mapping, footer generation, and default templates
 */

import { calculateTotalAmount } from './invoice-calculations'

export interface BrandData {
  id: number
  name: string
  code: string
  brand_address?: string
  contact_email?: string
  contact_phone?: string
  business_whatsapp_number?: string
  logo_url?: string
  company_registration?: string
  vat_number?: string
  eori_number?: string
  terms_and_conditions?: string
  buyer_terms_and_conditions?: string
  vendor_terms_and_conditions?: string
  website_url?: string | null
}

export interface PlaceholderData {
  invoice: any
  client?: any
  brand?: BrandData
  auction?: any
  items?: any[]
}

/**
 * Build comprehensive placeholder map from invoice data
 * Auto-maps all available fields with [PLACEHOLDER] format
 */
export function buildPlaceholderMap(data: PlaceholderData): Record<string, string> {
  const { invoice, client, brand, auction, items } = data
  const placeholders: Record<string, string> = {}

  // Base URL - Use brand website URL if available, otherwise fall back to brand-specific or default URL
  let baseUrl = 'http://localhost:3000'
  if (brand?.website_url) {
    // Use brand's website URL from database
    baseUrl = brand.website_url
  }

  let invoiceBaseUrl = baseUrl
  if (brand?.code) {
    // Fall back to brand-specific environment variables
    const brandCode = brand.code.toUpperCase()
    if (brandCode === 'AURUM') {
      invoiceBaseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL_AURUM || process.env.PUBLIC_FRONTEND_URL_AURUM || 'https://aurumauctions.com'
    } else if (brandCode === 'METSAB') {
      invoiceBaseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL_METSAB || process.env.PUBLIC_FRONTEND_URL_METSAB || 'https://metsabauctions.com'
    } else {
      invoiceBaseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'
    }
  } else {
    // Default fallback
    invoiceBaseUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'
  }
  placeholders['BASE_URL'] = baseUrl
  placeholders['WEBSITE_URL'] = baseUrl // Alias for clarity

  // Generate public invoice URL with client access token
  // Format: [INVOICE_BASE_URL]/invoice/[INVOICE_ID]/[CLIENT_ID]
  if (invoice && client) {
    const publicInvoiceUrl = `${invoiceBaseUrl}/invoice/${invoice.id}/${client.id}`
    placeholders['INVOICE_URL'] = publicInvoiceUrl
    placeholders['PUBLIC_INVOICE_URL'] = publicInvoiceUrl
  } else if (invoice) {
    // Fallback if no client ID available
    placeholders['INVOICE_URL'] = `${invoiceBaseUrl}/invoice/${invoice.id}`
    placeholders['PUBLIC_INVOICE_URL'] = `${invoiceBaseUrl}/invoice/${invoice.id}`
  }

  // Invoice fields
  if (invoice) {
    placeholders['INVOICE_ID'] = String(invoice.id || '')
    placeholders['INVOICE_NUMBER'] = String(invoice.invoice_number || '')
    placeholders['STATUS'] = String(invoice.status || 'unpaid')
    placeholders['CREATED_AT'] = invoice.created_at ? new Date(invoice.created_at).toLocaleDateString('en-GB') : ''
    placeholders['PAID_AMOUNT'] = invoice.paid_amount ? `£${Number(invoice.paid_amount).toFixed(2)}` : '£0.00'
    placeholders['TYPE'] = String(invoice.type || 'buyer')
    
    // Lot and item details
    placeholders['LOT_IDS'] = Array.isArray(invoice.lot_ids) ? invoice.lot_ids.join(', ') : ''
    placeholders['LOT_NUMBER'] = placeholders['LOT_IDS'] // Alias
    placeholders['ITEM_IDS'] = Array.isArray(invoice.item_ids) ? invoice.item_ids.join(', ') : ''
    
    // Shipping/logistics fields
    placeholders['SHIPPING_METHOD'] = String(invoice.shipping_method || invoice.logistics?.shipping_method || '')
    placeholders['SHIPPING_STATUS'] = String(invoice.shipping_status || invoice.logistics?.shipping_status || '')
    placeholders['SHIPPING_CHARGE'] = invoice.shipping_charge || invoice.logistics?.shipping_charge 
      ? `£${Number(invoice.shipping_charge || invoice.logistics?.shipping_charge).toFixed(2)}` 
      : '£0.00'
    
    // Buyer information from invoice
    placeholders['BUYER_FIRST_NAME'] = String(invoice.buyer_first_name || '')
    placeholders['BUYER_LAST_NAME'] = String(invoice.buyer_last_name || '')
    placeholders['BUYER_EMAIL'] = String(invoice.buyer_email || '')
    placeholders['BUYER_PHONE'] = String(invoice.buyer_phone || '')
    placeholders['BUYER_USERNAME'] = String(invoice.buyer_username || '')
    
    // Calculate amounts
    const totalAmount = brand ? calculateTotalAmount(invoice, 'final', brand) : 0
    const hammerPrice = Array.isArray(invoice.sale_prices) 
      ? invoice.sale_prices.reduce((sum: number, price: number) => sum + price, 0) 
      : 0
    const buyerPremium = Array.isArray(invoice.buyer_premium_prices)
      ? invoice.buyer_premium_prices.reduce((sum: number, price: number) => sum + price, 0)
      : 0
    
    placeholders['TOTAL_AMOUNT'] = `£${totalAmount.toFixed(2)}`
    placeholders['HAMMER_PRICE'] = `£${hammerPrice.toFixed(2)}`
    placeholders['SALE_AMOUNT'] = placeholders['HAMMER_PRICE'] // Alias
    placeholders['BUYER_PREMIUM'] = `£${buyerPremium.toFixed(2)}`
    placeholders['PURCHASE_AMOUNT'] = placeholders['TOTAL_AMOUNT'] // Alias
    placeholders['FINAL_BID_AMOUNT'] = placeholders['TOTAL_AMOUNT'] // Alias
    
    // Commission and net amount calculations (for vendor invoices)
    // Use the SAME logic as invoice-pdf-generator.ts:
    // - For buyer invoices: use buyer_premium (commission the buyer pays)
    // - For vendor invoices: use vendor_premium (commission the vendor pays)
    let commissionRate = 0
    let commission = 0
    let netAmount = 0
    
    if (invoice.type === 'vendor') {
      // For vendor invoices: commission is vendor_premium applied to hammer price
      commissionRate = client?.vendor_premium || invoice.commission_rate || 0.1
      commission = hammerPrice * commissionRate
      netAmount = hammerPrice - commission
    } else {
      // For buyer invoices: commission is the buyer premium (already calculated above)
      commissionRate = client?.buyer_premium || invoice.commission_rate || 0
      commission = buyerPremium
      netAmount = totalAmount // For buyers, net amount is what they need to pay
    }
    
    placeholders['COMMISSION_RATE'] = `${(commissionRate * 100).toFixed(0)}%`
    placeholders['COMMISSION'] = `£${commission.toFixed(2)}`
    placeholders['NET_AMOUNT'] = `£${netAmount.toFixed(2)}`
    placeholders['PAYMENT_AMOUNT'] = invoice.type === 'vendor' ? placeholders['NET_AMOUNT'] : placeholders['TOTAL_AMOUNT']
    
    // Due amount
    const paidAmount = invoice.paid_amount || 0
    const dueAmount = Math.max(0, totalAmount - paidAmount)
    placeholders['DUE_AMOUNT'] = `£${dueAmount.toFixed(2)}`
    
    // Ship-to information
    if (invoice.logistics) {
      placeholders['SHIP_TO_FIRST_NAME'] = String(invoice.logistics.ship_to_first_name || '')
      placeholders['SHIP_TO_LAST_NAME'] = String(invoice.logistics.ship_to_last_name || '')
      placeholders['SHIP_TO_PHONE'] = String(invoice.logistics.ship_to_phone || '')
      placeholders['SHIP_TO_COMPANY'] = String(invoice.logistics.ship_to_company || '')
      placeholders['SHIP_TO_ADDRESS'] = String(invoice.logistics.ship_to_address || '')
      placeholders['SHIP_TO_CITY'] = String(invoice.logistics.ship_to_city || '')
      placeholders['SHIP_TO_STATE'] = String(invoice.logistics.ship_to_state || '')
      placeholders['SHIP_TO_COUNTRY'] = String(invoice.logistics.ship_to_country || '')
      placeholders['SHIP_TO_POSTAL_CODE'] = String(invoice.logistics.ship_to_postal_code || '')
    }
  }

  // Client fields (prefer client object over invoice buyer fields)
  if (client) {
    placeholders['CLIENT_ID'] = String(client.id || '')
    placeholders['CLIENT_FIRST_NAME'] = String(client.first_name || '')
    placeholders['CLIENT_LAST_NAME'] = String(client.last_name || '')
    placeholders['CLIENT_NAME'] = client.company_name || `${client.first_name || ''} ${client.last_name || ''}`.trim()
    placeholders['COMPANY_NAME'] = String(client.company_name || '')
    placeholders['CLIENT_EMAIL'] = String(client.email || '')
    placeholders['CLIENT_PHONE'] = String(client.phone_number || '')
    placeholders['VENDOR_NAME'] = placeholders['CLIENT_NAME'] // For vendor emails
    
    // Billing address fields
    placeholders['BILLING_ADDRESS1'] = String(client.billing_address1 || '')
    placeholders['BILLING_ADDRESS2'] = String(client.billing_address2 || '')
    placeholders['BILLING_ADDRESS3'] = String(client.billing_address3 || '')
    placeholders['BILLING_CITY'] = String(client.billing_city || '')
    placeholders['BILLING_REGION'] = String(client.billing_region || '')
    placeholders['BILLING_COUNTRY'] = String(client.billing_country || '')
    placeholders['BILLING_POST_CODE'] = String(client.billing_post_code || '')
    
    // Bank details (for vendor invoices)
    placeholders['BANK_ACCOUNT_DETAILS'] = String(client.bank_account_details || '')
    placeholders['BANK_ADDRESS'] = String(client.bank_address || '')
  } else if (invoice) {
    // Fallback to invoice buyer fields if no client object
    placeholders['CLIENT_NAME'] = `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()
    placeholders['VENDOR_NAME'] = placeholders['CLIENT_NAME']
  }

  // Brand fields
  if (brand) {
    placeholders['BRAND_ID'] = String(brand.id || '')
    placeholders['BRAND_NAME'] = String(brand.name || 'Aurum Auctions')
    placeholders['BRAND_CODE'] = String(brand.code || '')
    placeholders['BRAND_ADDRESS'] = String(brand.brand_address || '')
    placeholders['CONTACT_EMAIL'] = String(brand.contact_email || '')
    placeholders['CONTACT_PHONE'] = String(brand.contact_phone || '')
    placeholders['BUSINESS_WHATSAPP_NUMBER'] = String(brand.business_whatsapp_number || '')
    placeholders['VAT_NUMBER'] = String(brand.vat_number || '')
    placeholders['COMPANY_REGISTRATION'] = String(brand.company_registration || '')
    placeholders['EORI_NUMBER'] = String(brand.eori_number || '')
  }

  // Auction fields
  if (auction) {
    placeholders['AUCTION_ID'] = String(auction.id || '')
    placeholders['AUCTION_NAME'] = String(auction.long_name || auction.short_name || '')
    placeholders['AUCTION_SHORT_NAME'] = String(auction.short_name || '')
    placeholders['SETTLEMENT_DATE'] = auction.settlement_date 
      ? new Date(auction.settlement_date).toLocaleDateString('en-GB')
      : ''
  }

  // Items information
  if (items && items.length > 0) {
    placeholders['ITEM_COUNT'] = String(items.length)
    placeholders['ITEM_TITLE'] = items[0]?.title || 'Auction Items'
    placeholders['ITEM_TITLES'] = items.map(item => item.title).filter(Boolean).join(', ')
  }

  // Date fields
  placeholders['PAYMENT_DATE'] = new Date().toLocaleDateString('en-GB')
  placeholders['CURRENT_DATE'] = new Date().toLocaleDateString('en-GB')
  placeholders['CURRENT_YEAR'] = String(new Date().getFullYear())

  // Payment terms
  placeholders['PAYMENT_TERMS'] = '30 days'
  placeholders['REFERENCE_NUMBER'] = placeholders['INVOICE_NUMBER']

  return placeholders
}

/**
 * Convert plain text newlines to HTML line breaks
 * Handles both literal \n and actual newline characters
 */
export function convertNewlinesToHtml(text: string): string {
  if (!text) return ''
  
  // Replace literal \n string (from database) with actual newlines first
  let result = text.replace(/\\n/g, '\n')
  
  // Then convert actual newlines to <br> tags for HTML display
  result = result.replace(/\n/g, '<br />')
  
  return result
}

/**
 * Replace all placeholders in template with actual values
 * Supports both [PLACEHOLDER] and [placeholder] formats (case-insensitive)
 */
export function replaceEmailPlaceholders(
  template: string,
  placeholderMap: Record<string, string>
): string {
  // First, convert any newlines in the template to HTML breaks
  let result = convertNewlinesToHtml(template)

  // Replace all placeholders (case-insensitive)
  Object.keys(placeholderMap).forEach(key => {
    let value = String(placeholderMap[key])

    // Handle newlines in values - convert to <br> tags for HTML emails
    if (value.includes('\n')) {
      value = value.replace(/\n/g, '<br />')
    }

    // Create regex that matches both uppercase and lowercase versions
    const upperPlaceholder = new RegExp(`\\[${key.toUpperCase()}\\]`, 'g')
    const lowerPlaceholder = new RegExp(`\\[${key.toLowerCase()}\\]`, 'g')

    result = result.replace(upperPlaceholder, value)
    result = result.replace(lowerPlaceholder, value)
  })

  return result
}

/**
 * Generate branded email footer with logo, contact info, and legal disclaimer
 */
export function generateEmailFooter(brand?: BrandData): string {
  const brandName = brand?.name || 'Aurum Auctions'
  const brandCode = brand?.code?.toUpperCase() || ''
  const contactEmail = brand?.contact_email || 'info@aurumauctions.com'
  const contactPhone = brand?.contact_phone || ''
  const brandAddress = brand?.brand_address || ''
  const logoUrl = brand?.logo_url || ''
  const companyRegistration = brand?.company_registration || ''
  const vatNumber = brand?.vat_number || ''

  // Format company name for footer
  // For Aurum: "MSaber Limited trading as Aurum Auctions"
  // For others: Just the brand name
  let companyNameText = brandName
  if (brandCode === 'AURUM') {
    companyNameText = 'MSaber Limited trading as Aurum Auctions'
  }

  return `
    <!-- Email Footer -->
    <div style="background-color: #f9fafb; padding: 30px 30px 20px 30px; border-top: 2px solid #e5e7eb; margin-top: 40px;">
      ${logoUrl ? `
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="${logoUrl}" alt="${brandName}" style="max-width: 150px; height: auto;" />
        </div>
      ` : ''}
      
      <div style="text-align: center; margin-bottom: 20px;">
        ${companyRegistration ? `
          <p style="color: #6b7280; font-size: 13px; margin: 5px 0; line-height: 1.6;">
            ${companyNameText}, Registered in England and Wales under<br>
            Registration number: ${companyRegistration};
            ${brandAddress ? `<br>Registered Address: ${brandAddress.replace(/\n/g, ', ')}` : ''}
          </p>
        ` : `
          <p style="color: #1f2937; font-size: 16px; font-weight: 600; margin: 0 0 10px 0;">
            ${brandName}
          </p>
          ${brandAddress ? `
            <p style="color: #6b7280; font-size: 14px; margin: 5px 0;">
              ${brandAddress.replace(/\n/g, '<br>')}
            </p>
          ` : ''}
        `}
        <p style="color: #6b7280; font-size: 14px; margin: 5px 0;">
          ${contactEmail}${contactPhone ? ` | ${contactPhone}` : ''}
        </p>
      </div>

      ${vatNumber ? `
        <div style="text-align: center; margin-bottom: 15px; padding-top: 15px; border-top: 1px solid #e5e7eb;">
          <p style="color: #9ca3af; font-size: 12px; margin: 3px 0;">
            VAT: ${vatNumber}
          </p>
        </div>
      ` : ''}

      <div style="text-align: center; padding-top: 15px; border-top: 1px solid #e5e7eb;">
        <p style="color: #9ca3af; font-size: 11px; line-height: 1.6; margin: 0;">
          This email was sent by ${brandName}. Please keep this email for your records.<br>
          This is an automated message.<br>
          © ${new Date().getFullYear()} ${brandName}. All rights reserved.
        </p>
      </div>
    </div>
  `
}

/**
 * Wrap email content with footer
 */
export function wrapEmailWithFooter(htmlContent: string, brand?: BrandData): string {
  // Check if content already has a closing div structure
  const hasClosingStructure = htmlContent.includes('</div>') && htmlContent.includes('</body>')
  
  if (hasClosingStructure) {
    // Insert footer before closing body/html tags
    return htmlContent.replace(
      /([\s\S]*)<\/body>/i,
      `$1${generateEmailFooter(brand)}</body>`
    )
  } else {
    // Wrap content with basic structure and add footer
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
        <div style="max-width: 600px; margin: 0 auto; background-color: white;">
          ${htmlContent}
          ${generateEmailFooter(brand)}
        </div>
      </body>
      </html>
    `
  }
}

/**
 * Get default winning bid email template
 */
export function getDefaultWinningBidTemplate(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Congratulations on Your Winning Bid</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 40px 30px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Congratulations!</h1>
          <p style="color: #d1fae5; margin: 10px 0 0 0; font-size: 16px;">You have won the auction</p>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear [CLIENT_NAME],</h2>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            Congratulations! You have successfully won the auction for:
          </p>

          <div style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 1px solid #bbf7d0; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <h3 style="color: #065f46; margin: 0 0 20px 0; font-size: 18px;">Winning Details</h3>
            <div style="margin-bottom: 12px;">
              <span style="color: #065f46; font-weight: 500;">Item:</span>
              <span style="color: #065f46; font-weight: 600; margin-left: 10px;">[ITEM_TITLE]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #065f46; font-weight: 500;">Lot Number:</span>
              <span style="color: #065f46; font-weight: 600; margin-left: 10px;">[LOT_NUMBER]</span>
            </div>
            <div>
              <span style="color: #065f46; font-weight: 500;">Final Bid:</span>
              <span style="color: #059669; font-weight: 700; font-size: 18px; margin-left: 10px;">[FINAL_BID_AMOUNT]</span>
            </div>
          </div>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            Your winning bid has been confirmed and you are now the highest bidder for this lot. Our team will be in touch shortly with payment instructions and collection/shipping details.
          </p>

          <div style="background-color: #f0f9ff; border-left: 4px solid #3b82f6; padding: 20px; margin: 30px 0;">
            <h3 style="color: #1e40af; margin: 0 0 15px 0; font-size: 18px;">What's Next?</h3>
            <ul style="color: #1e40af; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li>Payment is due within [PAYMENT_TERMS] of the auction close</li>
              <li>Collection/shipping arrangements will be coordinated separately</li>
              <li>All sales are subject to our terms and conditions</li>
            </ul>
          </div>

          <!-- CTA Button -->
          <div style="text-align: center; margin: 40px 0;">
            <a href="[BASE_URL]/contact" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);"> Contact Our Team</a>
          </div>

          <!-- Contact Info -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
              If you have any questions, please don't hesitate to contact us.
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
              This email was sent by [BRAND_NAME]. Please keep this email for your records.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

/**
 * Get default payment confirmation email template
 */
export function getDefaultPaymentConfirmationTemplate(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Confirmation</title>
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
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear [CLIENT_NAME],</h2>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            We have successfully received your payment for <strong>Invoice [INVOICE_NUMBER]</strong>.
            Your transaction has been processed and confirmed.
          </p>

          <!-- Payment Details Card -->
          <div style="background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border: 1px solid #e5e7eb; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <h3 style="color: #1f2937; margin: 0 0 20px 0; font-size: 18px;">Payment Details</h3>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b7280; font-weight: 500;">Invoice Number:</span>
              <span style="color: #1f2937; font-weight: 600; margin-left: 10px;">[INVOICE_NUMBER]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b7280; font-weight: 500;">Amount Paid:</span>
              <span style="color: #059669; font-weight: 700; font-size: 18px; margin-left: 10px;">[PURCHASE_AMOUNT]</span>
            </div>
            <div>
              <span style="color: #6b7280; font-weight: 500;">Payment Date:</span>
              <span style="color: #1f2937; font-weight: 600; margin-left: 10px;">[PAYMENT_DATE]</span>
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
            <a href="[INVOICE_URL]"
               style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);">
              Select Shipping Method
            </a>
          </div>

          <!-- Contact Info -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
              If you have any questions about your order, please don't hesitate to contact us.
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
              This email was sent by [BRAND_NAME]. Please keep this email for your records.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

/**
 * Get default shipping confirmation email template
 */
export function getDefaultShippingConfirmationTemplate(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Shipping Confirmation</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 40px 30px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Shipping Confirmed</h1>
          <p style="color: #fef3c7; margin: 10px 0 0 0; font-size: 16px;">Your order is being processed</p>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear [CLIENT_NAME],</h2>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            Your payment has been confirmed and we now need some additional information from you to proceed with shipping your winning lot.
          </p>

          <!-- Order Details Card -->
          <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <h3 style="color: #92400e; margin: 0 0 20px 0; font-size: 18px;">Order Details</h3>
            <div style="margin-bottom: 12px;">
              <span style="color: #92400e; font-weight: 500;">Invoice Number:</span>
              <span style="color: #92400e; font-weight: 600; margin-left: 10px;">[INVOICE_NUMBER]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #92400e; font-weight: 500;">Purchase Amount:</span>
              <span style="color: #d97706; font-weight: 700; font-size: 18px; margin-left: 10px;">[PURCHASE_AMOUNT]</span>
            </div>
            <div>
              <span style="color: #92400e; font-weight: 500;">Reference:</span>
              <span style="color: #92400e; font-weight: 600; margin-left: 10px;">[REFERENCE_NUMBER]</span>
            </div>
          </div>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            Please reply to this email with the following information:
          </p>

          <div style="background-color: #f9fafb; border-left: 4px solid #f59e0b; padding: 20px; margin: 30px 0;">
            <h3 style="color: #92400e; margin: 0 0 15px 0; font-size: 18px;">Required Information:</h3>
            <ol style="color: #92400e; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li><strong>Preferred Shipping Method:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>Courier Delivery (additional charges may apply)</li>
                  <li>Collection from our premises</li>
                  <li>White glove delivery service</li>
                </ul>
              </li>
              <li><strong>If choosing Courier Delivery:</strong> Complete delivery address, preferred date/time, access restrictions</li>
              <li><strong>If choosing Collection:</strong> Preferred date/time, collection person details</li>
            </ol>
          </div>

          <!-- Important Notes -->
          <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 20px; margin: 30px 0;">
            <h3 style="color: #dc2626; margin: 0 0 15px 0; font-size: 18px;">Important Notes:</h3>
            <ul style="color: #dc2626; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li>Courier services are available Monday to Friday, 9 AM to 5 PM</li>
              <li>Collection is available by appointment only</li>
              <li>All items are insured during transit</li>
              <li>International shipping requires additional documentation</li>
            </ul>
          </div>

          <!-- CTA Button -->
          <div style="text-align: center; margin: 40px 0;">
            <a href="mailto:[CONTACT_EMAIL]?subject=Shipping Details for Invoice [INVOICE_NUMBER]"
               style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);">
              Reply with Shipping Details
            </a>
          </div>

          <!-- Contact Info -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
              Please reply to this email as soon as possible so we can expedite your order.
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
              This email was sent by [BRAND_NAME]. Please keep this email for your shipping records.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

/**
 * Get default vendor sale notification email template
 */
export function getDefaultVendorSaleNotificationTemplate(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Sale Notification</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 40px 30px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Sale Notification</h1>
          <p style="color: #d1fae5; margin: 10px 0 0 0; font-size: 16px;">Your item has been sold</p>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear [VENDOR_NAME],</h2>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            We are pleased to inform you that your item has been successfully sold at auction.
          </p>

          <!-- Sale Details Card -->
          <div style="background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border: 1px solid #10b981; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <h3 style="color: #065f46; margin: 0 0 20px 0; font-size: 18px;">Sale Details</h3>
            <div style="margin-bottom: 12px;">
              <span style="color: #065f46; font-weight: 500;">Invoice Number:</span>
              <span style="color: #065f46; font-weight: 600; margin-left: 10px;">[INVOICE_NUMBER]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #065f46; font-weight: 500;">Sale Amount:</span>
              <span style="color: #059669; font-weight: 700; font-size: 18px; margin-left: 10px;">[SALE_AMOUNT]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #065f46; font-weight: 500;">Commission:</span>
              <span style="color: #065f46; font-weight: 600; margin-left: 10px;">[COMMISSION]</span>
            </div>
            <div>
              <span style="color: #065f46; font-weight: 500;">Net Amount:</span>
              <span style="color: #059669; font-weight: 700; font-size: 18px; margin-left: 10px;">[NET_AMOUNT]</span>
            </div>
          </div>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            Payment will be processed according to our standard terms. You will receive a separate payment confirmation email once the buyer's payment has been received and cleared.
          </p>

          <!-- Important Notes -->
          <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 20px; margin: 30px 0;">
            <h3 style="color: #1d4ed8; margin: 0 0 15px 0; font-size: 18px;">Next Steps:</h3>
            <ul style="color: #1d4ed8; margin: 0; padding-left: 20px; line-height: 1.8;">
              <li>Payment processing typically takes 3-5 business days</li>
              <li>You will receive a payment confirmation email once funds are released</li>
              <li>Please ensure your banking details are up to date</li>
              <li>Contact us if you have any questions about this sale</li>
            </ul>
          </div>

          <!-- Contact Info -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
              If you have any questions about this sale, please don't hesitate to contact us.
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
              This email was sent by [BRAND_NAME]. Please keep this email for your records.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

/**
 * Get default vendor payment confirmation email template
 */
export function getDefaultVendorPaymentConfirmationTemplate(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Confirmation</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc;">
      <div style="max-width: 600px; margin: 0 auto; background-color: white; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 40px 30px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Payment Confirmed</h1>
          <p style="color: #e9d5ff; margin: 10px 0 0 0; font-size: 16px;">Your payment has been processed</p>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 24px;">Dear [VENDOR_NAME],</h2>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            We are pleased to confirm that payment for your recent sale has been processed successfully.
          </p>

          <!-- Payment Details Card -->
          <div style="background: linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%); border: 1px solid #8b5cf6; border-radius: 12px; padding: 25px; margin: 30px 0;">
            <h3 style="color: #6b21a8; margin: 0 0 20px 0; font-size: 18px;">Payment Details</h3>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b21a8; font-weight: 500;">Invoice Number:</span>
              <span style="color: #6b21a8; font-weight: 600; margin-left: 10px;">[INVOICE_NUMBER]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b21a8; font-weight: 500;">Sale Amount:</span>
              <span style="color: #7c3aed; font-weight: 700; font-size: 18px; margin-left: 10px;">[SALE_AMOUNT]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b21a8; font-weight: 500;">Commission:</span>
              <span style="color: #6b21a8; font-weight: 600; margin-left: 10px;">[COMMISSION]</span>
            </div>
            <div style="margin-bottom: 12px;">
              <span style="color: #6b21a8; font-weight: 500;">Payment Amount:</span>
              <span style="color: #7c3aed; font-weight: 700; font-size: 18px; margin-left: 10px;">[PAYMENT_AMOUNT]</span>
            </div>
            <div>
              <span style="color: #6b21a8; font-weight: 500;">Payment Date:</span>
              <span style="color: #6b21a8; font-weight: 600; margin-left: 10px;">[PAYMENT_DATE]</span>
            </div>
          </div>

          <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">
            The payment has been transferred to your registered bank account. Please allow 1-2 business days for the funds to appear in your account, depending on your bank's processing times.
          </p>

          <!-- Banking Info Reminder -->
          <div style="background-color: #fefce8; border-left: 4px solid #eab308; padding: 20px; margin: 30px 0;">
            <h3 style="color: #a16207; margin: 0 0 15px 0; font-size: 18px;">Banking Information:</h3>
            <p style="color: #a16207; margin: 0; line-height: 1.6;">
              If you need to update your banking details for future payments, please contact us immediately to ensure smooth processing of your payments.
            </p>
          </div>

          <!-- Contact Info -->
          <div style="border-top: 1px solid #e5e7eb; padding-top: 30px; margin-top: 40px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 15px 0; text-align: center;">
              Thank you for choosing [BRAND_NAME]. We look forward to working with you on future auctions.
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 0; text-align: center;">
              This email confirmation was sent by [BRAND_NAME]. Please keep this email for your records.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}

