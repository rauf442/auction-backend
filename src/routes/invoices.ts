// backend/src/routes/invoices.ts
import express, { Request, Response } from 'express'
import { supabaseAdmin } from '../utils/supabase'
// import fetch from 'node-fetch'
import { authMiddleware } from '../middleware/auth'
import * as fs from 'fs'
import * as path from 'path'
import { XMLParser } from 'fast-xml-parser';
import {
  calculateTotalAmount,
  calculateDueAmount,
  getBuyerPremiumVATBreakdown
} from '../utils/invoice-calculations'
import {
  generateBuyerInvoicePDF,
  generateVendorInvoicePDF,
  BrandData
} from '../utils/invoice-pdf-generator'
import { platform } from 'os'


// Extend Request interface to include user property
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

// Helper function to generate secure brand-specific public URLs
function generateBrandSpecificUrl(brand: BrandData | undefined, invoiceId: number, accessToken: string): string {
    const defaultUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3000'

    if (!brand?.code) {
        console.log('No brand code found, using default URL:', defaultUrl)
        return `${defaultUrl}/invoice/${invoiceId}/${accessToken}`
    }

    const brandCode = brand.code.toUpperCase()

    // Generate brand-specific URLs
    let brandUrl: string
    switch (brandCode) {
        case 'AURUM':
            brandUrl = process.env.PUBLIC_FRONTEND_URL_AURUM || 'http://localhost:3002'
            break
        case 'METSAB':
            brandUrl = process.env.PUBLIC_FRONTEND_URL_METSAB || 'http://localhost:3003'
            break
        default:
            console.log('Unknown brand code, using default URL:', brandCode)
            brandUrl = defaultUrl
    }

    const finalUrl = `${brandUrl}/invoice/${invoiceId}/${accessToken}`
    console.log('Generated secure public URL:', finalUrl, 'for brand:', brandCode)
    return finalUrl
}

const router = express.Router()

// Apply auth middleware to all routes
router.use(authMiddleware)

// GET /api/invoices - Get all invoices with optional filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      auction_id,
      client_id,
      status,
      brand_code,
      type,
      page = 1,
      limit = 50
    } = req.query

    let query = supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        auction:auctions(id, short_name, long_name, settlement_date, subtype),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)

    // Apply filters
    if (auction_id) {
      query = query.eq('auction_id', auction_id)
    }
    if (client_id) {
      query = query.eq('client_id', client_id)
    }
    if (status && status !== 'all') {
      query = query.eq('status', status)
    }
    if (type && type !== 'all') {
      query = query.eq('type', type)
    }
    if (brand_code) {
      const { data: brand } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', brand_code.toString().toUpperCase())
        .single()
      if (brand?.id) {
        query = query.eq('brand_id', brand.id)
      }
    }

    // Apply pagination
    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    // Get total count
    const { count: totalCount } = await supabaseAdmin
      .from('invoices')
      .select('*', { count: 'exact', head: true })

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    const { data: invoices, error } = await query

    if (error) {
      console.error('Error fetching invoices:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch invoices',
        error: error.message
      })
    }

    // Calculate additional amounts for each invoice
    const invoicesWithCalculations = (invoices || []).map(invoice => {
      // Calculate total amounts using array-based sale_prices and buyer_premium_prices
      invoice.total_amount = calculateTotalAmount(invoice, 'final', invoice.brand)

      return invoice
    })

    const total = totalCount || 0
    const totalPages = Math.ceil(total / limitNum)

    res.json({
      success: true,
      data: invoicesWithCalculations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: totalPages
      }
    })
  } catch (error: any) {
    console.error('Error in GET /invoices:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/invoices/:id - Get single invoice with details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type, bank_account_details, bank_address),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', id)
      .single()

    if (error || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    // Get artwork details – prefer invoice.item_ids to ensure correct linkage
    let items: any[] = []
    const itemIds: number[] = Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0
      ? invoice.item_ids
      : (invoice.auction?.artwork_ids || [])

    if (itemIds && itemIds.length > 0) {
      const { data: itemsData, error: itemsError } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', itemIds)

      if (!itemsError && itemsData) {
        // Preserve the ordering of itemIds so lot_ids index matches
        items = itemIds
          .map((id: number) => itemsData.find((it: any) => it.id === id))
          .filter(Boolean) as any[]
      }
    }

    // Calculate additional amounts for the invoice
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    invoice.total_amount = totalAmount

    res.json({
      success: true,
      data: {
        ...invoice,
        items
      }
    })
  } catch (error: any) {
    console.error('Error in GET /invoices/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// Generate invoice PDF
router.post('/:invoiceId/pdf', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    const { type = 'internal', brand_code } = req.body

    // Get invoice data with all related information including items
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type, bank_account_details, bank_address),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' })
    }

    // Use brand from invoice or fetch by brand_code
    let brand = invoice.brand
    if (!brand && brand_code) {
      const { data: brandData, error: brandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', brand_code.toString().toUpperCase())
        .single()

      if (brandError || !brandData) {
        return res.status(404).json({ success: false, message: 'Brand not found' })
      }
      brand = brandData
    }

    if (!brand) {
      return res.status(400).json({ success: false, message: 'Brand information is required for PDF generation' })
    }

    // Get item details if invoice has item_ids
    let items: any[] = []
    if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', invoice.item_ids)
        .order('id')
      items = itemsData || []
    }

    // Generate PDF based on invoice type
    console.log('Generating PDF for invoice:', invoice.invoice_number, 'Type:', type, 'Invoice Type:', invoice.type || 'buyer')

    let pdfContent: Buffer
    if (invoice.type === 'vendor') {
      pdfContent = await generateVendorInvoicePDF(invoice, brand, type, items)
    } else {
      // Default to buyer invoice
      pdfContent = await generateBuyerInvoicePDF(invoice, brand, type, items)
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`)
    res.send(pdfContent)
  } catch (error: any) {
    console.error('Error in POST /invoices/:invoiceId/pdf:', error)
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message })
  }
})

// PUT /api/invoices/:id - Update invoice
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const updateData = req.body

    // Remove fields that shouldn't be updated
    delete updateData.id
    delete updateData.created_at
    delete updateData.updated_at

    // If paid_amount is being updated, check if it should change status to 'paid' or 'unpaid'
    if (updateData.paid_amount !== undefined) {
      // Get current invoice data to calculate total amount
      const { data: currentInvoice, error: fetchError } = await supabaseAdmin
        .from('invoices')
        .select(`
          *,
          brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
        `)
        .eq('id', id)
        .single()

      if (fetchError || !currentInvoice) {
        return res.status(404).json({
          success: false,
          message: 'Invoice not found'
        })
      }

      // Calculate total amount to compare with paid amount
      const totalAmount = calculateTotalAmount(currentInvoice, 'final', currentInvoice.brand)

      // Update status based on paid amount vs total amount
      if (updateData.paid_amount >= totalAmount) {
        updateData.status = 'paid'
      } else {
        // If paid amount is less than total, set status back to 'unpaid'
        updateData.status = 'unpaid'
      }
    }

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        auction:auctions(id, short_name, long_name, settlement_date, subtype),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .single()

    if (error || !invoice) {
      console.log('error', error)
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or failed to update'
      })
    }

    // Calculate additional amounts for the response
    invoice.total_amount = calculateTotalAmount(invoice, 'final', invoice.brand)

    console.log('invoice', invoice)
    res.json({
      success: true,
      data: invoice
    })
  } catch (error: any) {
    console.error('Error in PUT /invoices/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// DELETE /api/invoices/:id - Delete invoice
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params

    const { error } = await supabaseAdmin
      .from('invoices')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting invoice:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to delete invoice',
        error: error.message
      })
    }

    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    })
  } catch (error: any) {
    console.error('Error in DELETE /invoices/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/export-eoa-csv/:auctionId - Export EOA CSV with merged buyer/vendor data
router.post('/export-eoa-csv/:auctionId', async (req: AuthRequest, res: Response) => {
  try {
    const { auctionId } = req.params

    // Get all invoices for this auction (both buyer and vendor types)
    const { data: invoices, error: invoicesError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, bank_account_details, bank_address),
        auction:auctions(id, short_name, long_name)
      `)
      .eq('auction_id', auctionId)
      .in('type', ['buyer', 'vendor'])

    if (invoicesError) {
      console.error('Error fetching invoices for export:', invoicesError)
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch invoices',
        error: invoicesError.message
      })
    }

    if (!invoices || invoices.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No invoices found for this auction'
      })
    }

    // Group invoices by lot_id for easier processing
    const lotGroups = new Map<string, any[]>()

    // Process each invoice and group by lot
    for (const invoice of invoices) {
      if (invoice.lot_ids && Array.isArray(invoice.lot_ids)) {
        for (let i = 0; i < invoice.lot_ids.length; i++) {
          const lotId = invoice.lot_ids[i]
          const itemId = invoice.item_ids?.[i]
          const salePrice = invoice.sale_prices?.[i] || 0
          const buyerPremium = invoice.buyer_premium_prices?.[i] || 0

          if (!lotGroups.has(lotId)) {
            lotGroups.set(lotId, [])
          }

          lotGroups.get(lotId)!.push({
            invoice,
            itemId,
            salePrice,
            buyerPremium,
            index: i
          })
        }
      }
    }

    // Get all items for this auction to get additional item details
    const allItemIds = invoices.flatMap(inv => inv.item_ids || [])
    const uniqueItemIds = [...new Set(allItemIds)]

    let itemsMap = new Map<number, any>()
    if (uniqueItemIds.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('id, title, artist_maker, vendor_id')
        .in('id', uniqueItemIds)

      if (itemsData) {
        itemsData.forEach(item => {
          itemsMap.set(item.id, item)
        })
      }
    }

    // Prepare CSV data
    const csvData: any[] = []

    // Add header row
    csvData.push({
      'Lot Number': 'Lot Number',
      'Inventory ID': 'Inventory ID',
      'Title': 'Title',
      'Sale Price': 'Sale Price',
      'Buyer Premium': 'Buyer Premium',
      'First Name': 'First Name',
      'Last Name': 'Last Name',
      'Username': 'Username',
      'Email': 'Email',
      'Account phone': 'Account phone',
      'Shipping Method': 'Shipping Method',
      'Shipping Status': 'Shipping Status',
      'Ship to, Phone': 'Ship to, Phone',
      'Ship to, Name': 'Ship to, Name',
      'Ship to, Surname': 'Ship to, Surname',
      'Company': 'Company',
      'Address': 'Address',
      'City': 'City',
      'State': 'State',
      'Country': 'Country',
      'Postal Code': 'Postal Code',
      'Paddle Number': 'Paddle Number',
      'Premium Bidder': 'Premium Bidder',
      'Lot Reference Number': 'Lot Reference Number',
      'Listing Agent ID': 'Listing Agent ID',
      'Listing Agent': 'Listing Agent',
      'Commission Rate': 'Commission Rate',
      'Hammer': 'Hammer',
      'Commission': 'Commission',
      'Processing Fee (3% of Hammer)': 'Processing Fee (3% of Hammer)',
      'Sales Tax': 'Sales Tax',
      'Net to Pay Listing Agent': 'Net to Pay Listing Agent',
      'Domestic Flat Shipping': 'Domestic Flat Shipping',
      'Paid': 'Paid',
      'Buyer Address': 'Buyer Address',
      'Shipping (buyer, met-sab, or collection?)': 'Shipping (buyer, met-sab, or collection?)',
      'If Met-Sab, Shipping Cost': 'If Met-Sab, Shipping Cost',
      'And Insurance Cost': 'And Insurance Cost',
      'Vendor Name': 'Vendor Name',
      'Vendor Address': 'Vendor Address',
      'Vendor Commission %': 'Vendor Commission %',
      'Bank Account Details': 'Bank Account Details',
      'Bank Address': 'Bank Address',
      'Vendor Status (individual or business)': 'Vendor Status (individual or business)',
      'If Business, proof of business registration sent': 'If Business, proof of business registration sent'
    })

    // Process each lot group
    for (const [lotNumber, lotData] of lotGroups.entries()) {
      const buyerData = lotData.find(d => d.invoice.type === 'buyer')
      const vendorData = lotData.find(d => d.invoice.type === 'vendor')

      if (!buyerData) continue // Skip if no buyer data

      const buyer = buyerData.invoice
      const vendor = vendorData?.invoice
      const item = itemsMap.get(buyerData.itemId)

      // Create row data
      const row: any = {
        'Lot Number': lotNumber,
        'Inventory ID': item?.id || buyerData.itemId || '',
        'Title': item?.title || buyer.title || '',
        'Sale Price': buyerData.salePrice || 0,
        'Buyer Premium': buyerData.buyerPremium || 0,
        'First Name': buyer.buyer_first_name || '',
        'Last Name': buyer.buyer_last_name || '',
        'Username': buyer.buyer_username || '',
        'Email': buyer.buyer_email || '',
        'Account phone': buyer.buyer_phone || '',
        'Shipping Method': buyer.shipping_method || '',
        'Shipping Status': buyer.shipping_status || '',
        'Ship to, Phone': buyer.ship_to_phone || '',
        'Ship to, Name': buyer.ship_to_first_name || '',
        'Ship to, Surname': buyer.ship_to_last_name || '',
        'Company': buyer.ship_to_company || '',
        'Address': buyer.ship_to_address || '',
        'City': buyer.ship_to_city || '',
        'State': buyer.ship_to_state || '',
        'Country': buyer.ship_to_country || '',
        'Postal Code': buyer.ship_to_postal_code || '',
        'Paddle Number': buyer.paddle_number || '',
        'Premium Bidder': buyer.premium_bidder ? 'Yes' : 'No',
        'Lot Reference Number': lotNumber,
        'Listing Agent ID': '',
        'Listing Agent': '',
        'Commission Rate': '',
        'Hammer': buyerData.salePrice || 0,
        'Commission': 0,
        'Processing Fee (3% of Hammer)': 0,
        'Sales Tax': 0,
        'Net to Pay Listing Agent': 0,
        'Domestic Flat Shipping': 0,
        'Paid': buyer.status === 'paid' ? 'Yes' : 'No',
        'Buyer Address': `${buyer.ship_to_address || ''}, ${buyer.ship_to_city || ''}, ${buyer.ship_to_postal_code || ''}`.trim(),
        'Shipping (buyer, met-sab, or collection?)': buyer.shipping_method || '',
        'If Met-Sab, Shipping Cost': buyer.shipping_method?.toLowerCase().includes('met-sab') ? buyer.shipping_charge || 0 : '',
        'And Insurance Cost': buyer.insurance_charge || 0,
        'Vendor Name': vendor?.client?.company_name || `${vendor?.client?.first_name || ''} ${vendor?.client?.last_name || ''}`.trim() || '',
        'Vendor Address': vendor?.client?.billing_address1 || '',
        'Vendor Commission %': vendor?.commission_rate || '',
        'Bank Account Details': vendor?.client?.bank_account_details || '',
        'Bank Address': vendor?.client?.bank_address || '',
        'Vendor Status (individual or business)': vendor?.client?.client_type || '',
        'If Business, proof of business registration sent': vendor?.client?.client_type === 'business' ? 'Yes' : 'No'
      }

      csvData.push(row)
    }

    // Generate CSV content
    const headers = csvData[0]
    const rows = csvData.slice(1)

    const csvRows = [
      Object.values(headers), // Header row
      ...rows.map(row => Object.values(row)) // Data rows
    ]

    const csvContent = csvRows
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n')

    // Set response headers for CSV download
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="eoa-export-${auctionId}.csv"`)

    res.send(csvContent)
  } catch (error: any) {
    console.error('Error in POST /invoices/export-eoa-csv/:auctionId:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:invoiceId/generate-public-url - Generate secure public URL for invoice
router.post('/:invoiceId/generate-public-url', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    console.log('Generating secure public URL for invoice:', invoiceId)

    // Get invoice with all necessary data
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      console.error('Invoice not found:', invoiceError)
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    console.log('Invoice found:', { id: invoice.id, invoice_number: invoice.invoice_number })

    // Generate a secure token for this invoice access
    const crypto = require('crypto')
    const accessToken = crypto.randomBytes(32).toString('hex')

    // Store the access token in the database
    const { error: tokenError } = await supabaseAdmin
      .from('invoices')
      .update({
        public_access_token: accessToken,
        public_access_created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', invoiceId)

    if (tokenError) {
      console.error('Error storing access token:', tokenError)
      return res.status(500).json({
        success: false,
        message: 'Failed to generate secure access token'
      })
    }

    // Calculate total amount for payment link
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    const dueAmount = calculateDueAmount(invoice, 'final', invoice.brand)

    // If there's an amount due, create/update Xero payment link
    let paymentLink = invoice.payment_link
    if (dueAmount > 0 && invoice.brand?.id) {
      try {
        const { XeroService } = await import('../utils/xero-client')

        // Check if Xero is configured for this brand
        const xeroCredentials = await XeroService.getXeroCredentials(invoice.brand.id.toString())

        if (xeroCredentials && xeroCredentials.access_token) {
          // Create Xero payment link
          const xeroResult = await XeroService.createPaymentLink(
            invoice.brand.id.toString(),
            dueAmount,
            `Invoice ${invoice.invoice_number} - ${invoice.title || 'Auction Purchase'}`,
            invoice.client?.email || invoice.buyer_email
          )

          paymentLink = xeroResult.paymentUrl

          // Update invoice with payment link
          await supabaseAdmin
            .from('invoices')
            .update({
              payment_link: paymentLink,
              updated_at: new Date().toISOString()
            })
            .eq('id', invoiceId)
        }
      } catch (xeroError) {
        console.warn('Failed to create Xero payment link, proceeding without it:', xeroError)
        // Continue without payment link - user can still access the invoice
      }
    }

    // Generate brand-specific public URL with access token
    const publicUrl = generateBrandSpecificUrl(invoice.brand, parseInt(invoiceId), accessToken)

    console.log('Generated secure public URL:', publicUrl)

    res.json({
      success: true,
      url: publicUrl,
      paymentLink: paymentLink,
      message: 'Secure public URL generated successfully'
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:invoiceId/generate-public-url:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:invoiceId/create-shipping-payment-link - Create Xero payment link for shipping
router.post('/:invoiceId/create-shipping-payment-link', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    const { shippingAmount, customerEmail } = req.body

    if (!shippingAmount || shippingAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid shipping amount is required'
      })
    }

    // Get invoice with brand info
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        brand:brands(id, name, code)
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    if (!invoice.brand?.id) {
      return res.status(400).json({
        success: false,
        message: 'Brand information is required for payment processing'
      })
    }

    try {
      const { XeroService } = await import('../utils/xero-client')

      // Check if Xero is configured
      const xeroCredentials = await XeroService.getXeroCredentials(invoice.brand.id.toString())

      if (!xeroCredentials || !xeroCredentials.access_token) {
        return res.status(400).json({
          success: false,
          message: 'Xero payment integration is not configured for this brand'
        })
      }

      // Create Xero payment link for shipping
      const xeroResult = await XeroService.createPaymentLink(
        invoice.brand.id.toString(),
        shippingAmount,
        `Shipping for Invoice ${invoice.invoice_number}`,
        customerEmail || invoice.client?.email || invoice.buyer_email
      )

      // Update invoice with shipping payment link
      await supabaseAdmin
        .from('invoices')
        .update({
          shipping_payment_link: xeroResult.paymentUrl,
          total_shipping_amount: shippingAmount,
          updated_at: new Date().toISOString()
        })
        .eq('id', invoiceId)

      res.json({
        success: true,
        paymentLink: xeroResult.paymentUrl,
        message: 'Shipping payment link created successfully'
      })

    } catch (xeroError: any) {
      console.error('Error creating shipping payment link:', xeroError)
      res.status(500).json({
        success: false,
        message: 'Failed to create shipping payment link',
        error: xeroError.message
      })
    }

  } catch (error: any) {
    console.error('Error in POST /invoices/:invoiceId/create-shipping-payment-link:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/invoices/:invoiceId/payment-status - Check payment status from Xero
router.get('/:invoiceId/payment-status', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params

    // Get invoice with payment info
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        brand:brands(id, name, code)
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    if (!invoice.brand?.id) {
      return res.status(400).json({
        success: false,
        message: 'Brand information is required'
      })
    }

    try {
      const { XeroService } = await import('../utils/xero-client')

      // Check if Xero is configured
      const xeroCredentials = await XeroService.getXeroCredentials(invoice.brand.id.toString())

      if (!xeroCredentials || !xeroCredentials.access_token) {
        return res.json({
          success: true,
          status: 'unknown',
          message: 'Xero integration not configured'
        })
      }

      // For now, return current status from database
      // In a full implementation, you'd check Xero for real-time payment status
      const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
      const dueAmount = calculateDueAmount(invoice, 'final', invoice.brand)

      res.json({
        success: true,
        status: dueAmount <= 0 ? 'paid' : 'unpaid',
        totalAmount,
        paidAmount: invoice.paid_amount || 0,
        dueAmount,
        lastChecked: new Date().toISOString()
      })

    } catch (xeroError: any) {
      console.error('Error checking payment status:', xeroError)
      res.json({
        success: true,
        status: 'unknown',
        message: 'Unable to check payment status',
        error: xeroError.message
      })
    }

  } catch (error: any) {
    console.error('Error in GET /invoices/:invoiceId/payment-status:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:invoiceId/send-payment-confirmation - Send payment confirmation email
router.post('/:invoiceId/send-payment-confirmation', async (req: AuthRequest, res: Response) => {
  try {
    const { invoiceId } = req.params
    const { paymentType = 'invoice', amount, paymentDate } = req.body

    // Get invoice with all necessary data
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoiceId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    // Get client email
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

    // Prepare email content based on payment type
    let subject = ''
    let htmlContent = ''
    const brandName = invoice.brand?.name || 'Aurum Auctions'

    if (paymentType === 'invoice') {
      subject = `Payment Received - Invoice ${invoice.invoice_number}`
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-bottom: 20px;">Payment Confirmation</h2>
          <p>Dear ${clientName},</p>
          <p>Thank you for your payment! We have successfully received your payment for <strong>Invoice ${invoice.invoice_number}</strong>.</p>
          <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p><strong>Payment Details:</strong></p>
            <p>Invoice: ${invoice.invoice_number}</p>
            <p>Amount Paid: £${amount || invoice.paid_amount || 0}</p>
            <p>Date: ${paymentDate || new Date().toLocaleDateString()}</p>
          </div>
          <p>Your invoice payment has been processed successfully. You can now proceed to select your shipping method.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'}/invoice/${invoiceId}"
               style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Select Shipping Method
            </a>
          </div>
          <p>If you have any questions, please don't hesitate to contact us.</p>
          <br>
          <p>Best regards,</p>
          <p><strong>${brandName} Team</strong></p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #666;">
            ${brandName}<br>
            ${invoice.brand?.contact_email || ''}<br>
            ${invoice.brand?.contact_phone || ''}
          </p>
        </div>
      `
    } else if (paymentType === 'shipping') {
      subject = `Shipping Payment Received - Order Processing Started`
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #059669; margin-bottom: 20px;">Shipping Payment Confirmed</h2>
          <p>Dear ${clientName},</p>
          <p>Thank you for your shipping payment! We have received your payment and your order is now being processed.</p>
          <div style="background-color: #f0fdf4; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p><strong>Shipping Payment Details:</strong></p>
            <p>Invoice: ${invoice.invoice_number}</p>
            <p>Amount Paid: £${amount || invoice.total_shipping_amount || 0}</p>
            <p>Date: ${paymentDate || new Date().toLocaleDateString()}</p>
          </div>
          <p><strong>What happens next?</strong></p>
          <ul style="color: #374151; line-height: 1.6;">
            <li>Our team will prepare your item(s) for shipping</li>
            <li>You will receive tracking information once your order is dispatched</li>
            <li>Estimated delivery: 3-5 business days (UK), 7-14 days (International)</li>
          </ul>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'}/invoice/${invoiceId}/track"
               style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Track Your Order
            </a>
          </div>
          <p>If you have any questions about your order, please don't hesitate to contact us.</p>
          <br>
          <p>Best regards,</p>
          <p><strong>${brandName} Team</strong></p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #666;">
            ${brandName}<br>
            ${invoice.brand?.contact_email || ''}<br>
            ${invoice.brand?.contact_phone || ''}
          </p>
        </div>
      `
    }

    // Send the actual email using our email service
    const { EmailService } = await import('../utils/email-service')

    const emailSent = await EmailService.sendPaymentConfirmationEmail(
      clientEmail,
      clientName,
      invoice.invoice_number,
      brandName,
      paymentType,
      amount || invoice.paid_amount || 0,
      invoiceId
    )

    if (!emailSent) {
      console.warn('Failed to send payment confirmation email, but continuing with success response')
    }

    res.json({
      success: true,
      message: 'Payment confirmation email sent successfully'
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:invoiceId/send-payment-confirmation:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:id/send-acknowledgment-email - Send acknowledgment email
router.post('/:id/send-acknowledgment-email', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params

    // Get invoice with client information
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, logo_url, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', id)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    // Get client email
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

    // For now, we'll simulate email sending since we don't have an email service configured
    // In production, you would integrate with your email service (e.g., SendGrid, AWS SES, etc.)
    console.log('Sending acknowledgment email to:', {
      to: clientEmail,
      clientName: clientName,
      invoiceNumber: invoice.invoice_number,
      brandName: invoice.brand?.name || 'Aurum Auctions'
    })

    // Simulate email sending delay
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Here you would typically send the actual email
    // Example with a service like nodemailer or your preferred email service:
    /*
    const emailContent = {
      to: clientEmail,
      subject: `Payment Received - Invoice ${invoice.invoice_number}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Payment Acknowledgment</h2>
          <p>Dear ${clientName},</p>
          <p>Thank you for your payment. We have received payment for invoice ${invoice.invoice_number}.</p>
          <p>Your payment has been processed successfully.</p>
          <p>If you have any questions, please don't hesitate to contact us.</p>
          <br>
          <p>Best regards,</p>
          <p>${invoice.brand?.name || 'Aurum Auctions'} Team</p>
        </div>
      `
    }

    await emailService.sendEmail(emailContent)
    */

    res.json({
      success: true,
      message: 'Acknowledgment email sent successfully'
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:id/send-acknowledgment-email:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:id/send-vendor-email - Send vendor email using brand templates
router.post('/:id/send-vendor-email', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { type } = req.body

    // Get invoice details with full information
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, bank_account_details, bank_address),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions, website_url, vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body, vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body)
      `)
      .eq('id', id)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    const brandId = invoice.brand_id
    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: 'Brand ID not found for invoice'
      })
    }

    // Get items for the invoice
    let items: any[] = []
    if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', invoice.item_ids)
      items = itemsData || []
    }

    // Get vendor email - try multiple sources
    const vendorEmail = invoice.buyer_email || invoice.client?.email
    if (!vendorEmail) {
      return res.status(400).json({
        success: false,
        message: 'Vendor email address not found'
      })
    }

    // Prepare email variables (for backward compatibility)
    const brandName = invoice.brand?.name || 'Aurum Auctions'
    const auctionName = invoice.auction?.long_name || invoice.auction?.short_name || 'Auction'
    
    // For vendor emails, use hammer price (sale_prices) not total amount
    const hammerPrice = Array.isArray(invoice.sale_prices) 
      ? invoice.sale_prices.reduce((sum: number, price: number) => sum + price, 0) 
      : 0
    const vendorName = invoice.client?.company_name 
      || (invoice.client ? `${invoice.client.first_name || ''} ${invoice.client.last_name || ''}`.trim() : '')
      || `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim() 
      || 'Vendor'

    // Calculate commission and net amount based on hammer price
    const commissionRate = invoice.commission_rate || 0.1 // Default 10%
    const commission = hammerPrice * commissionRate
    const netAmount = hammerPrice - commission

    const variables = {
      VENDOR_NAME: vendorName,
      INVOICE_NUMBER: invoice.invoice_number,
      BRAND_NAME: brandName.toUpperCase(),
      AUCTION_NAME: auctionName,
      SALE_AMOUNT: `£${hammerPrice.toFixed(2)}`,
      COMMISSION: `£${commission.toFixed(2)}`,
      NET_AMOUNT: `£${netAmount.toFixed(2)}`,
      PAYMENT_AMOUNT: `£${netAmount.toFixed(2)}`,
      PAYMENT_DATE: new Date().toLocaleDateString('en-GB')
    }

    console.log('📧 Sending vendor email:', {
      type,
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      vendorEmail,
      vendorName,
      itemCount: items.length
    })

    // Import EmailService
    const { EmailService } = await import('../utils/email-service')

    let emailSent = false

    // Send appropriate vendor email based on type (with invoice, brand, and items data for PDF attachment)
    switch (type) {
      case 'sale_notification':
        emailSent = await EmailService.sendVendorSaleNotificationEmail(
          brandId,
          vendorEmail,
          variables,
          invoice,
          invoice.brand,
          items
        )
        break
      case 'payment_confirmation':
        emailSent = await EmailService.sendVendorPaymentConfirmationEmail(
          brandId,
          vendorEmail,
          variables,
          invoice,
          invoice.brand,
          items
        )
        break
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid email type. Supported types: sale_notification, payment_confirmation'
        })
    }

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send vendor email. Please check email service configuration and brand email templates.'
      })
    }

    // Update invoice to track email sent timestamp
    const now = new Date().toISOString()
    const emailTimestampField = type === 'sale_notification' 
      ? 'email_vendor_sale_notification_sent_at'
      : 'email_vendor_payment_confirmation_sent_at'
    
    try {
      await supabaseAdmin
        .from('invoices')
        .update({ [emailTimestampField]: now })
        .eq('id', id)
    } catch (updateError: any) {
      console.warn('Failed to update email timestamp:', updateError?.message || updateError)
      // Don't fail the request if timestamp update fails
    }

    res.status(200).json({
      success: true,
      message: 'Vendor email sent successfully',
      sentTo: vendorEmail,
      emailType: type
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:id/send-vendor-email:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/invoices/:id/email-preview - Preview email template with populated variables
router.get('/:id/email-preview', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { type } = req.query

    if (!type) {
      return res.status(400).json({
        success: false,
        message: 'Email type is required'
      })
    }

    // Get invoice details with all email template fields
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions, website_url, winning_bid_email_subject, winning_bid_email_body, payment_confirmation_email_subject, payment_confirmation_email_body, shipping_confirmation_email_subject, shipping_confirmation_email_body, vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body, vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body)
      `)
      .eq('id', id)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    const brandId = invoice.brand_id
    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: 'Brand ID not found for invoice'
      })
    }

    // Get items for the invoice
    let items: any[] = []
    if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', invoice.item_ids)
      items = itemsData || []
    }

    // Determine recipient details based on invoice type and email type
    let recipientEmail = ''
    let recipientName = ''
    let variables: any = {}

    const brandName = invoice.brand?.name || 'Aurum Auctions'
    const auctionName = invoice.auction?.long_name || invoice.auction?.short_name || 'Auction'
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)

    if (invoice.type === 'vendor' && (type === 'sale_notification' || type === 'payment_confirmation' || type === 'vendor_sale_notification' || type === 'vendor_payment_confirmation')) {
      // For vendor emails, get vendor details - prioritize client email and company name
      recipientEmail = invoice.client?.email || invoice.buyer_email || ''
      recipientName = invoice.client?.company_name 
        || (invoice.client ? `${invoice.client.first_name || ''} ${invoice.client.last_name || ''}`.trim() : '')
        || `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim() 
        || 'Vendor'

      // For vendor emails, use hammer price (sale_prices) not total amount
      const hammerPrice = Array.isArray(invoice.sale_prices) 
        ? invoice.sale_prices.reduce((sum: number, price: number) => sum + price, 0) 
        : 0
      const commissionRate = invoice.commission_rate || 0.1
      const commission = hammerPrice * commissionRate
      const netAmount = hammerPrice - commission

      variables = {
        VENDOR_NAME: recipientName,
        INVOICE_NUMBER: invoice.invoice_number,
        BRAND_NAME: brandName.toUpperCase(),
        AUCTION_NAME: auctionName,
        SALE_AMOUNT: `£${hammerPrice.toFixed(2)}`,
        COMMISSION: `£${commission.toFixed(2)}`,
        NET_AMOUNT: `£${netAmount.toFixed(2)}`,
        PAYMENT_AMOUNT: `£${netAmount.toFixed(2)}`,
        PAYMENT_DATE: new Date().toLocaleDateString('en-GB')
      }
      // Note: BASE_URL will be auto-generated from brand.website_url by buildPlaceholderMap
    } else {
      // For buyer emails, get client details
      recipientEmail = invoice.client?.email || invoice.buyer_email || ''
      recipientName = invoice.client
        ? (invoice.client.company_name || `${invoice.client.first_name} ${invoice.client.last_name}`.trim())
        : `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()

      variables = {
        CLIENT_NAME: recipientName,
        COMPANY_NAME: invoice.client?.company_name || '',
        INVOICE_NUMBER: invoice.invoice_number,
        INVOICE_ID: invoice.id,
        BRAND_NAME: brandName,
        AUCTION_NAME: auctionName,
        PURCHASE_AMOUNT: `£${totalAmount.toFixed(2)}`,
        PAYMENT_DATE: new Date().toLocaleDateString('en-GB'),
        CONTACT_EMAIL: invoice.brand?.contact_email || 'info@aurumauctions.com',
        ITEM_TITLE: items.length > 0 ? items[0].title : 'Auction Items',
        LOT_NUMBER: invoice.lot_ids?.join(', ') || 'N/A',
        FINAL_BID_AMOUNT: `£${totalAmount.toFixed(2)}`,
        PAYMENT_TERMS: '30 days',
        REFERENCE_NUMBER: invoice.invoice_number
      }
      // Note: BASE_URL will be auto-generated from brand.website_url by buildPlaceholderMap
    }

    // Import EmailService
    const { EmailService } = await import('../utils/email-service')

    // Validate email type
    const validTypes = ['winning_bid', 'payment_confirmation', 'shipping_confirmation', 'sale_notification', 'vendor_sale_notification', 'vendor_payment_confirmation']
    if (!validTypes.includes(type as string)) {
      return res.status(400).json({
        success: false,
        message: `Invalid email type. Supported types: ${validTypes.join(', ')}`
      })
    }

    // Map frontend types to backend EmailService types
    let emailServiceType: 'winning_bid' | 'payment_confirmation' | 'shipping_confirmation' | 'vendor_sale_notification' | 'vendor_payment_confirmation'
    switch (type) {
      case 'winning_bid':
        emailServiceType = 'winning_bid'
        break
      case 'payment_confirmation':
        emailServiceType = 'payment_confirmation'
        break
      case 'shipping_confirmation':
        emailServiceType = 'shipping_confirmation'
        break
      case 'sale_notification':
      case 'vendor_sale_notification':
        emailServiceType = 'vendor_sale_notification'
        break
      case 'vendor_payment_confirmation':
        emailServiceType = 'vendor_payment_confirmation'
        break
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid email type'
        })
    }

    // Get email preview with comprehensive data
    const emailPreview = await EmailService.previewEmailTemplate(
      brandId,
      emailServiceType,
      variables,
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

    res.status(200).json({
      success: true,
      preview: {
        to: recipientEmail,
        from: process.env.DEFAULT_FROM_EMAIL || 'info@aurumauctions.com',
        subject: emailPreview.subject,
        body: emailPreview.body,
        recipientName: recipientName
      }
    })

  } catch (error: any) {
    console.error('Error in GET /invoices/:id/email-preview:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/:id/send-buyer-email - Send buyer email using brand templates
router.post('/:id/send-buyer-email', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params
    const { type } = req.body

    if (!type) {
      return res.status(400).json({
        success: false,
        message: 'Email type is required'
      })
    }

    // Get invoice details with full data
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions, website_url, winning_bid_email_subject, winning_bid_email_body, payment_confirmation_email_subject, payment_confirmation_email_body, shipping_confirmation_email_subject, shipping_confirmation_email_body)
      `)
      .eq('id', id)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    const brandId = invoice.brand_id
    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: 'Brand ID not found for invoice'
      })
    }

    // Get items for the invoice
    let items: any[] = []
    if (invoice.item_ids && Array.isArray(invoice.item_ids) && invoice.item_ids.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', invoice.item_ids)
      items = itemsData || []
    }

    // Get client details
    const clientEmail = invoice.client?.email || invoice.buyer_email
    const clientName = invoice.client
      ? (invoice.client.company_name || `${invoice.client.first_name} ${invoice.client.last_name}`.trim())
      : `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()

    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'Client email address is required'
      })
    }

    // Prepare email variables (for backward compatibility)
    const brandName = invoice.brand?.name || 'Aurum Auctions'
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    
    const variables = {
      CLIENT_NAME: clientName,
      INVOICE_NUMBER: invoice.invoice_number,
      INVOICE_ID: invoice.id,
      BRAND_NAME: brandName,
      PURCHASE_AMOUNT: `£${totalAmount.toFixed(2)}`,
      PAYMENT_DATE: new Date().toLocaleDateString('en-GB'),
      CONTACT_EMAIL: invoice.brand?.contact_email || 'info@aurumauctions.com',
      ITEM_TITLE: items.length > 0 ? items[0].title : 'Auction Items',
      LOT_NUMBER: invoice.lot_ids?.join(', ') || 'N/A',
      FINAL_BID_AMOUNT: `£${totalAmount.toFixed(2)}`,
      PAYMENT_TERMS: '30 days',
      REFERENCE_NUMBER: invoice.invoice_number
    }
    // Note: BASE_URL will be auto-generated from brand.website_url by buildPlaceholderMap

    console.log('📧 Sending buyer email:', {
      type,
      invoiceId: id,
      invoiceNumber: invoice.invoice_number,
      clientEmail,
      clientName,
      itemCount: items.length
    })

    // Import EmailService
    const { EmailService } = await import('../utils/email-service')

    let emailSent = false

    // Send appropriate buyer email based on type (with invoice, brand, and items data for PDF attachment)
    switch (type) {
      case 'winning_bid':
        emailSent = await EmailService.sendWinningBidEmail(
          brandId,
          clientEmail,
          variables,
          invoice,
          invoice.brand,
          items
        )
        break
      case 'payment_confirmation':
        emailSent = await EmailService.sendPaymentConfirmationEmailCustom(
          brandId,
          clientEmail,
          variables,
          invoice,
          invoice.brand,
          items
        )
        break
      case 'shipping_confirmation':
        emailSent = await EmailService.sendShippingConfirmationEmailCustom(
          brandId,
          clientEmail,
          variables,
          invoice,
          invoice.brand,
          items
        )
        break
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid email type. Supported types: winning_bid, payment_confirmation, shipping_confirmation'
        })
    }

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send email. Please check email service configuration and brand email templates.'
      })
    }

    // Update invoice to track email sent timestamp
    const now = new Date().toISOString()
    let emailTimestampField: string
    
    switch (type) {
      case 'winning_bid':
        emailTimestampField = 'email_winning_bid_sent_at'
        break
      case 'payment_confirmation':
        emailTimestampField = 'email_payment_confirmation_sent_at'
        break
      case 'shipping_confirmation':
        emailTimestampField = 'email_shipping_confirmation_sent_at'
        break
      default:
        emailTimestampField = ''
    }
    
    if (emailTimestampField) {
      try {
        await supabaseAdmin
          .from('invoices')
          .update({ [emailTimestampField]: now })
          .eq('id', id)
      } catch (updateError: any) {
        console.warn('Failed to update email timestamp:', updateError?.message || updateError)
        // Don't fail the request if timestamp update fails
      }
    }

    res.status(200).json({
      success: true,
      message: 'Buyer email sent successfully',
      sentTo: clientEmail,
      emailType: type
    })

  } catch (error: any) {
    console.error('Error in POST /invoices/:id/send-buyer-email:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/invoices/private-sale - Create a private sale invoice
router.post('/private-sale', async (req: AuthRequest, res: Response) => {
  try {
    const { item_id, auction_id, client_id, sale_price, brand_id } = req.body

    // Validate required fields
    if (!item_id || !auction_id || !client_id || sale_price === undefined || !brand_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: item_id, auction_id, client_id, sale_price, brand_id'
      })
    }

    // Validate sale price
    if (typeof sale_price !== 'number' || sale_price <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Sale price must be a positive number'
      })
    }

    // Get item details and validate it's not already sold
    const { data: item, error: itemError } = await supabaseAdmin
      .from('items')
      .select('id, title, status, is_private_sale')
      .eq('id', item_id)
      .single()

    if (itemError || !item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      })
    }

    if (item.status === 'sold') {
      return res.status(400).json({
        success: false,
        message: 'Item is already sold'
      })
    }

    // Get auction details and validate item is in this auction
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, artwork_ids, brand_id')
      .eq('id', auction_id)
      .single()

    if (auctionError || !auction) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found'
      })
    }

    // Validate item is in the auction
    const artworkIds = auction.artwork_ids || []
    if (!artworkIds.includes(item_id)) {
      return res.status(400).json({
        success: false,
        message: 'Item is not part of this auction'
      })
    }

    // Get client details for buyer premium calculation
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('id', client_id)
      .single()

    if (clientError || !client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      })
    }

    // Calculate buyer premium
    const buyerPremiumRate = client.buyer_premium || 0
    const buyerPremiumAmount = (sale_price * buyerPremiumRate) / 100

    // Generate invoice number and access token
    const invoiceNumber = `IN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const accessToken = Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2)

    // Create invoice data
    const invoiceData = {
      auction_id: auction_id,
      brand_id: brand_id,
      platform: 'private_sale',
      lot_ids: ['1'], // Default lot number for private sales
      item_ids: [item_id],
      sale_prices: [sale_price],
      buyer_premium_prices: [buyerPremiumAmount],
      buyer_first_name: client.first_name || '',
      buyer_last_name: client.last_name || '',
      buyer_email: client.email || '',
      buyer_phone: client.phone_number || '',
      status: 'unpaid',
      client_id: client_id,
      type: 'buyer',
      paid_amount: 0,
      invoice_number: invoiceNumber,
      public_access_token: accessToken,
      public_access_created_at: new Date().toISOString(),
      invoice_date: new Date().toISOString()
    }

    // Insert invoice into database
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .insert(invoiceData)
      .select()
      .single()

    if (invoiceError) {
      console.error('Error creating private sale invoice:', invoiceError)
      return res.status(500).json({
        success: false,
        message: 'Failed to create invoice',
        error: invoiceError.message
      })
    }

    // Update item status to sold and mark as private sale
    const { error: updateError } = await supabaseAdmin
      .from('items')
      .update({
        status: 'sold',
        is_private_sale: true,
        buyer_id: client_id,
        sale_price: sale_price,
        date_sold: new Date().toISOString()
      })
      .eq('id', item_id)

    if (updateError) {
      console.error('Error updating item status:', updateError)
      // Log error but don't fail the request since invoice was created
    }

    res.json({
      success: true,
      message: 'Private sale invoice created successfully',
      data: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        access_token: accessToken
      }
    })
  } catch (error: any) {
    console.error('Error creating private sale invoice:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})


type Data = {
  success: boolean
  data?: any
  message?: string
}

//Genrate automatic invoices from Live Auctioneer

router.get('/generateautomaticinvoices/:auctionId', async (req: Request, res: Response) => {
  try {
    const auctionId = Number(req.params.auctionId);
    if (isNaN(auctionId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid auction ID'
      });
    }
    const brand = req.query.brand as string || "Aurum"; 
    const brandId = Number(req.query.brandId) || 2;

        const { data: auction, error } = await supabaseAdmin
      .from('auctions')
      .select('auction_liveauctioneers_id')
      .eq('id', auctionId)
      .single();

    if (error || !auction) {
      return res.status(404).json({
        success: false,
        message: 'Auction not found'
      });
    }

    const catalogIdWithString = auction.auction_liveauctioneers_id;
    if (!catalogIdWithString) {
      return res.status(400).json({
        success: false,
        message: 'Auction does not have a catalog ID'
      });
    }

    const catalogId = catalogIdWithString.substring(2); 

    // Convert to number if needed
    const catalogIdNumber = Number(catalogId);
    console.log("catalog Id : " + catalogId);
    const houseId = 10020;
    const response = await fetch(
      `https://classic.liveauctioneers.com/am-api/eoa-list?catalogId=${catalogId}&preview=yes&houseId=${houseId}`,
      {
        headers: {
          'Accept': 'text/xml',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Cookie': `auctioneer-auth=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NzMwMzUwNjQsImhvdXNlX2lkIjoiMTAwMjAiLCJob3VzZV9uYW1lIjoiQXVydW0gQXVjdGlvbnMgIiwiaWF0IjoxNzcxODI1NDY0LCJpc3MiOiJob3VzZS11c2VyLXNlcnZpY2UiLCJzdWIiOiIxNjY3OCIsInR5cGUiOiJhdWN0aW9uZWVyIn0.Lo29k0SXmUTnQi_A4l3VOqXs1NGMrRA0rsifcm7QQlM; PHPSESSID=1plnpe5ioae33mi3k5ojobbbpu; visid_incap_3258118=0h2I3RhETo6kg3vQ1V3D0Nvnm2kAAAAAQUIPAAAAAAC5k7dd2dMzWCOM4ba35F9Y; la_ah_867=10ada23b6973290db93db337c11dd975; incap_ses_932_3258118=incap_ses_932_3258118 CT=Y52`

        },
      }
    )

    const xml = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    });
    const parsed = parser.parse(xml);

    const items = parsed.amapi.response.eoa.item;
    const invoiceNumber = generateInvoiceNumber(brand);

    const itemList = Array.isArray(items) ? items : [items];

    const invoices = itemList.map((item: any) => ({
      invoiceId: item.sale.invoiceID,
      buyerName: `${item.buyer.buyer_first_name} ${item.buyer.buyer_last_name}`,
      email: item.buyer.email,
      lot: item.details.lotNumber,
      title: item.details.title,
      hammer: parseFloat(item.sale.hammer),
      premium: parseFloat(item.sale.buyersPrem),
      total: parseFloat(item.sale.hammer) + parseFloat(item.sale.buyersPrem),
      currency: item.sale.currencyCode,
    }));
    const invoicesList = await Promise.all(
      itemList.map(async (item: any) => {
        console.log(item.details.title);
        const email = item.buyer.email;
        const buyerFirstName = item.buyer.buyer_first_name;
        const buyerLastName = item.buyer.buyer_last_name;
        const title = item.details?.title || '';
        
        let artworks = await getArtworkByFullTitle(title);
        if (artworks.length === 0) {
          // fallback: partial matching (not just artist)
          artworks = await getArtworkBySmartTitle(title);
        }

        const item_ids = artworks.map(a => String(a.id));
        if (item_ids.length === 0) {
          console.log(`⚠️ No artwork matched for title: ${title}. Skipping invoice.`);
          return;
        }

        let client = await getClientByEmail(email);
        if (!client) {
          client = await createNewClient({
            email: item.buyer.email,
            firstName: item.buyer.buyer_first_name,
            lastName: item.buyer.buyer_last_name
          });

          if (!client?.id) {
            console.error("❌ Failed to create client, skipping invoice.");
            return;
          }
        }

        const invoiceNumber = generateInvoiceNumber(brand);
       
        await insertInvoiceWithItems({
          invoiceId: invoiceNumber,
          clientId: client.id,
          itemIds: item_ids,
          hammer: parseFloat(item.sale.hammer),
          premium: parseFloat(item.sale.buyersPrem),
          total: parseFloat(item.sale.hammer) + parseFloat(item.sale.buyersPrem),
          brand_id: brandId,
          auctionId: auctionId,
          buyerFirstName: buyerFirstName,
          buyerLastName: buyerLastName,
          buyerEmail: email

        });
        await updateInventoryAfterSale({
          itemIds: item_ids,
          hammer: parseFloat(item.sale.hammer),
          premium: parseFloat(item.sale.buyersPrem),
          clientId: client.id
        });
      })
    );
    res.json({
      success: true,
      count: invoices.length,
      data: invoices,
    });
  } catch (error: any) {
    console.error('Error fetching catalog:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

async function getArtworkByFullTitle(title: string) {
  const cleanTitle = normalizeTitle(title);
  const { data, error } = await supabaseAdmin
    .from('items')
    .select('*')
    .ilike('title', cleanTitle); // exact match (case-insensitive)

  if (!error && data?.length > 0) return data;
  return [];
}


async function getClientByEmail(email: string) {
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !client) {
    return null;
  }
  return client;
}

async function createNewClient(data: {email: string; firstName: string; lastName: string;}) {
  const { data: newClient, error } = await supabaseAdmin
    .from('clients')
    .insert([
      {
        email: data.email,
        first_name: data.firstName,
        last_name: data.lastName,
        status: 'active',
        role: 'BUYER',
        client_type: 'buyer',
        platform: 'Liveauctioneer',
        preferred_language: 'English',
        time_zone: 'UTC',
      }
    ])
    .select()      
    .single();

  if (error) {
    console.error("❌ Error creating client:", error.message);
    return null;
  }

  console.log("✅ New client created with ID:", newClient.id);

  return newClient;
}

function normalizeTitle(title: string) {
  return title
    .replace(/&#\d+;/g, '')        // remove HTML entities
    .replace(/â/g, '-')          // fix weird dash encoding
    .replace(/[|"'`]/g, '')        // remove quotes and separators
    .replace(/\s+/g, ' ')          // normalize spaces
    .trim()
    .toLowerCase();
}



async function getArtworkBySmartTitle(rawTitle: string) {
  if (!rawTitle) return [];

  const cleanTitle = normalizeTitle(rawTitle);

  // First, try exact-ish match ignoring encoding/quotes
  const { data: exactMatches, error: exactError } = await supabaseAdmin
    .from('items')
    .select('*')
    .ilike('title', `%${cleanTitle}%`);

  if (!exactError && exactMatches?.length > 0) return exactMatches;

  // Fallback: split title into words/phrases and match any
  const keyPhrases = cleanTitle.split(/\s+/).filter(w => w.length > 2); // ignore tiny words
  if (keyPhrases.length === 0) return [];

  const queries = keyPhrases.map(p => `title.ilike.%${p}%`).join(',');
  const { data: fallbackMatches, error: fallbackError } = await supabaseAdmin
    .from('items')
    .select('*')
    .or(queries); // Supabase "or" query for any key phrase match

  if (!fallbackError && fallbackMatches?.length > 0) return fallbackMatches;

  return [];
}

async function insertInvoiceWithItems(data: {invoiceId: string; 
  clientId: string | number;
  itemIds: string[];
  hammer: number; 
  premium: number; 
  total: number; 
  brand_id: number; 
  auctionId: number
  buyerFirstName: string;
  buyerLastName: string;
  buyerEmail: string;
}) {
  const exists = await invoiceExists(data.clientId, data.itemIds);
  if (exists) {
    console.log("⚠️ Invoice already exists for client and items. Skipping insertion.");
    return null;
  }

  // Since your DB expects arrays, create arrays matching itemIds length
  const hammerArray = data.itemIds.map(() => data.hammer);
  const premiumArray = data.itemIds.map(() => data.premium);

  const { data: newInvoice, error } = await supabaseAdmin
    .from('invoices')
    .insert([
      {
        client_id: data.clientId,
        item_ids: data.itemIds,
        sale_prices: hammerArray,
        buyer_premium_prices: premiumArray,
        invoice_number: data.invoiceId,
        auction_id: data.auctionId,
        status: 'unpaid',
        brand_id: 2,
        platform: 'liveauctioneer',
        buyer_first_name: data.buyerFirstName,
        buyer_last_name: data.buyerLastName,
        buyer_email: data.buyerEmail
      }
    ])
    .select()
    .single();

  if (error) {
    console.error("❌ Error inserting invoice:", error.message);
    return null;
  }

  console.log("✅ Invoice inserted with ID:", newInvoice.id);
  return newInvoice;
}

function generateInvoiceNumber(brand:string): string {
  const date = new Date()
  const year = date.getFullYear().toString().slice(-2)
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  const brandName = brand.substring(0, 3).toUpperCase();
  return `${brandName}-INV-${year}${month}${random}`
}

async function invoiceExists(clientId: string | number, itemIds: string[]): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('client_id', clientId)
    .contains('item_ids', itemIds); // Supabase allows checking arrays
  if (error) {
    console.error("❌ Error checking existing invoice:", error.message);
    return false;
  }
  return data && data.length > 0;
}



async function updateInventoryAfterSale(data: {
  itemIds: string[];
  hammer: number;
  premium: number;
  clientId: string | number;
}) {
  try {
    const finalPrice = data.hammer + data.premium;

    const { data: updatedItems, error } = await supabaseAdmin
      .from('items')
      .update({
        status: 'sold',
        sale_price: data.hammer,
        final_price: finalPrice,
        date_sold: new Date().toISOString(),
        buyer_id: data.clientId
      })
      .in('id', data.itemIds) 
      .select();

    if (error) {
      console.error("❌ Error updating inventory:", error.message);
      return null;
    }

    console.log(`✅ Updated ${updatedItems?.length || 0} items as SOLD`);
    return updatedItems;

  } catch (err: any) {
    console.error("❌ Inventory update failed:", err.message);
    return null;
  }
}

export default router