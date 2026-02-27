// backend/src/routes/public-invoices.ts
import express, { Request, Response } from 'express'
import { supabaseAdmin } from '../utils/supabase'
import {
  calculateTotalAmount,
  calculateDueAmount
} from '../utils/invoice-calculations'
import {
  generateBuyerInvoicePDF,
  generateVendorInvoicePDF
} from '../utils/invoice-pdf-generator'

const router = express.Router()

// Helper function to check brand access based on request origin
function validateBrandAccess(invoice: any, req: Request): boolean {
  const origin = req.get('origin') || req.get('referer') || ''
  const invoiceBrandCode = invoice.brand?.code?.toUpperCase()
  
  console.log('Brand validation - Origin:', origin, 'Invoice Brand:', invoiceBrandCode)
  
  // Extract brand from origin/referer
  let requestBrand = ''
  if (origin.includes('aurum') || origin.includes('3003')) {
    requestBrand = 'AURUM'
  } else if (origin.includes('metsab') || origin.includes('3002')) {
    requestBrand = 'METSAB'
  }
  
  // If we can't determine the requesting brand, allow access (admin or direct access)
  if (!requestBrand) {
    console.log('Unable to determine requesting brand, allowing access')
    return true
  }
  
  // Check if invoice brand matches requesting brand
  if (invoiceBrandCode && requestBrand !== invoiceBrandCode) {
    console.log(`Brand mismatch: ${requestBrand} trying to access ${invoiceBrandCode} invoice`)
    return false
  }
  
  return true
}

// GET /api/public/invoices/:invoiceId/client/:clientId - Get public invoice with client ID verification (no auth required)
router.get('/:invoiceId/client/:clientId', async (req: Request, res: Response) => {
  try {
    const { invoiceId, clientId } = req.params

    console.log('Accessing public invoice:', { invoiceId, clientId })

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoiceId)
      .eq('client_id', clientId)
      .single()

    if (error || !invoice) {
      console.log('Invoice access denied:', { error: error?.message, invoiceFound: !!invoice })
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
      })
    }

    // Validate brand access
    if (!validateBrandAccess(invoice, req)) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
      })
    }

    // Get artwork details
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
        items = itemIds
          .map((id: number) => itemsData.find((it: any) => it.id === id))
          .filter(Boolean) as any[]
      }
    }

    // Calculate additional amounts using array-based pricing
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    const dueAmount = calculateDueAmount(invoice, 'final', invoice.brand)
    
    invoice.total_amount = totalAmount
    invoice.due_amount = dueAmount

    res.json({
      success: true,
      data: {
        ...invoice,
        items
      }
    })
  } catch (error: any) {
    console.error('Error in GET /public/invoices/:invoiceId/client/:clientId:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/public/invoices/:invoiceId/client/:clientId/pdf - Generate PDF for public invoice with client ID verification
router.get('/:invoiceId/client/:clientId/pdf', async (req: Request, res: Response) => {
  try {
    const { invoiceId, clientId } = req.params

    // Get invoice data with all related information and verify client ID
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoiceId)
      .eq('client_id', clientId)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' })
    }

    // Validate brand access
    if (!validateBrandAccess(invoice, req)) {
      return res.status(404).json({ success: false, message: 'Invoice not found' })
    }

    const brand = invoice.brand
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
    console.log('Generating PDF for invoice:', invoice.invoice_number, 'Type:', invoice.type || 'buyer')

    let pdfContent: Buffer
    if (invoice.type === 'vendor') {
      pdfContent = await generateVendorInvoicePDF(invoice, brand, 'final', items)
    } else {
      pdfContent = await generateBuyerInvoicePDF(invoice, brand, 'final', items)
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoice_number}.pdf"`)
    res.send(pdfContent)
  } catch (error: any) {
    console.error('Error in GET /public/invoices/:invoiceId/client/:clientId/pdf:', error)
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message })
  }
})

// GET /api/public/invoices/:id/:token - Get public invoice with token verification (no auth required)
router.get('/:id/:token', async (req: Request, res: Response) => {
  try {
    const { id, token } = req.params

    console.log('Accessing public invoice:', { id, tokenProvided: !!token })

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', id)
      .eq('public_access_token', token)
      .single()

    if (error || !invoice) {
      console.log('Invoice access denied:', { error: error?.message, invoiceFound: !!invoice })
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
      })
    }

    // Validate brand access
    if (!validateBrandAccess(invoice, req)) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
      })
    }

    // Check if token has expired (optional - 30 days expiry)
    if (invoice.public_access_created_at) {
      const createdAt = new Date(invoice.public_access_created_at)
      const now = new Date()
      const daysDiff = (now.getTime() - createdAt.getTime()) / (1000 * 3600 * 24)

      if (daysDiff > 30) {
        console.log('Public access token expired for invoice:', id)
        return res.status(403).json({
          success: false,
          message: 'Access link has expired'
        })
      }
    }

    // Get artwork details
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
        items = itemIds
          .map((id: number) => itemsData.find((it: any) => it.id === id))
          .filter(Boolean) as any[]
      }
    }

    // Calculate additional amounts using array-based pricing
    const totalAmount = calculateTotalAmount(invoice, 'final', invoice.brand)
    const dueAmount = calculateDueAmount(invoice, 'final', invoice.brand)
    
    invoice.total_amount = totalAmount
    invoice.due_amount = dueAmount

    res.json({
      success: true,
      data: {
        ...invoice,
        items
      }
    })
  } catch (error: any) {
    console.error('Error in GET /public/invoices/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/public/invoices/:id/:token/pdf - Generate PDF for public invoice with token verification
router.get('/:id/:token/pdf', async (req: Request, res: Response) => {
  try {
    const { id, token } = req.params

    // Get invoice data with all related information and verify token
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', id)
      .eq('public_access_token', token)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' })
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

    // Determine PDF type based on payment status
    const hammerAndPremium = (invoice.hammer_price || 0) + (invoice.buyers_premium || 0)
    const paidAmount = invoice.paid_amount || 0
    const pdfType = paidAmount >= hammerAndPremium ? 'final' : 'internal'

    // Generate PDF based on invoice type
    let pdfContent: Buffer
    if (invoice.type === 'vendor') {
      pdfContent = await generateVendorInvoicePDF(invoice, invoice.brand, pdfType, items, token)
    } else {
      pdfContent = await generateBuyerInvoicePDF(invoice, invoice.brand, pdfType, items, token)
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoice_number}.pdf"`)
    res.send(pdfContent)
  } catch (error: any) {
    console.error('Error in GET /public/invoices/:id/pdf:', error)
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message })
  }
})

// PUT /api/public/invoices/:id/:token/shipping - Update shipping selection for public invoice with token verification
router.put('/:id/:token/shipping', async (req: Request, res: Response) => {
  try {
    const { id, token } = req.params
    const { l_method, l_status, l_postal_code, l_destination, l_country, logistics_method, shipping_address, shipping_cost, insurance_cost, total_cost, total_shipping_amount } = req.body

    // Get current invoice and verify access
    let currentInvoice;
    let fetchError;

    if (token === 'client-access') {
      // For client-based access, verify by client ID from the invoice data
      // We need to get the client ID from the request body or from a different approach
      // Since this is a shipping update, we'll assume the invoice exists and can be accessed
      // by the same client that accessed it originally
      const clientId = req.body.client_id; // This should be passed from frontend

      if (!clientId) {
        return res.status(400).json({
          success: false,
          message: 'Client ID required for client-based access'
        })
      }

      const result = await supabaseAdmin
        .from('invoices')
        .select('*')
        .eq('id', id)
        .eq('client_id', clientId)
        .single()

      currentInvoice = result.data;
      fetchError = result.error;
    } else {
      // For token-based access, verify by public access token
      const result = await supabaseAdmin
        .from('invoices')
        .select('*')
        .eq('id', id)
        .eq('public_access_token', token)
        .single()

      currentInvoice = result.data;
      fetchError = result.error;
    }

    if (fetchError || !currentInvoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
      })
    }

    console.log('Current invoice data:', {
      id: currentInvoice.id,
      client_id: currentInvoice.client_id,
      logistics: currentInvoice.logistics,
      l_method: currentInvoice.l_method,
      shipping_method: currentInvoice.shipping_method
    })

    console.log('Request body:', {
      l_method, l_status, l_postal_code, l_destination, l_country,
      logistics_method, shipping_address, shipping_cost, insurance_cost, total_cost, total_shipping_amount
    })

    // Prepare logistics data
    const logisticsData = {
      status: 'approved',
      logistics_method: l_method || logistics_method,
      shipping_cost: shipping_cost || 0,
      insurance_cost: insurance_cost || 0,
      total_cost: total_cost || 0
    }

    // Add shipping address if provided (for metsab_courier)
    const selectedMethod = l_method || logistics_method
    if (shipping_address && selectedMethod === 'metsab_courier') {
      Object.assign(logisticsData, {
        destination: shipping_address.country === 'United Kingdom' ? 'domestic' : 'international',
        country: shipping_address.country,
        postal_code: shipping_address.postal_code
      })
    }

    // Update invoice with shipping information
    const updateData: any = {
      logistics: logisticsData,
      l_method: l_method || logistics_method,
      l_status: l_status || 'approved',
      shipping_charge: shipping_cost || 0,
      insurance_charge: insurance_cost || 0,
      total_shipping_amount: total_shipping_amount || total_cost || 0,
      updated_at: new Date().toISOString()
    }

    // Only set location fields if they have valid values
    if (l_postal_code !== undefined && l_postal_code !== null) {
      updateData.l_postal_code = l_postal_code
    }
    if (l_destination !== undefined && l_destination !== null) {
      updateData.l_destination = l_destination
    }
    if (l_country !== undefined && l_country !== null) {
      updateData.l_country = l_country
    }

    console.log('Update data:', updateData)

    // Update shipping address fields if provided
    if (shipping_address) {
      Object.assign(updateData, {
        ship_to_address: shipping_address.address || '',
        ship_to_city: shipping_address.city || '',
        ship_to_postal_code: shipping_address.postal_code || '',
        ship_to_country: shipping_address.country || ''
      })
    }

    const { error: updateError } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', id)

    if (updateError) {
      console.error('Error updating invoice shipping:', updateError)
      console.error('Update error details:', {
        code: updateError.code,
        message: updateError.message,
        details: updateError.details,
        hint: updateError.hint
      })
      return res.status(500).json({
        success: false,
        message: 'Failed to update shipping information'
      })
    }

    // TODO: Send email notification about shipping selection
    console.log('Shipping method selected for invoice:', id, {
      method: selectedMethod,
      cost: total_cost
    })

    res.json({
      success: true,
      message: 'Shipping information updated successfully'
    })

  } catch (error: any) {
    console.error('Error in PUT /public/invoices/:id/shipping:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/public/invoices/:id/:token/create-shipping-payment-link - Create Xero payment link for shipping (public) with token verification
router.post('/:id/:token/create-shipping-payment-link', async (req: Request, res: Response) => {
  try {
    const { id, token } = req.params
    const { shippingAmount, customerEmail, client_id } = req.body

    if (!shippingAmount || shippingAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid shipping amount is required'
      })
    }

    // Get invoice with brand info and verify access
    let invoice;
    let invoiceError;

    if (token === 'client-access') {
      // For client-based access, verify by client ID
      if (!client_id) {
        return res.status(400).json({
          success: false,
          message: 'Client ID required for client-based access'
        })
      }

      const result = await supabaseAdmin
        .from('invoices')
        .select(`
          *,
          brand:brands(id, name, code)
        `)
        .eq('id', id)
        .eq('client_id', client_id)
        .single()

      invoice = result.data;
      invoiceError = result.error;
    } else {
      // For token-based access, verify by public access token
      const result = await supabaseAdmin
        .from('invoices')
        .select(`
          *,
          brand:brands(id, name, code)
        `)
        .eq('id', id)
        .eq('public_access_token', token)
        .single()

      invoice = result.data;
      invoiceError = result.error;
    }

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
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
        .eq('id', id)

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
    console.error('Error in POST /public/invoices/:id/create-shipping-payment-link:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/public/invoices/:id/:token/payment-status - Check payment status (public) with token verification
router.get('/:id/:token/payment-status', async (req: Request, res: Response) => {
  try {
    const { id, token } = req.params

    // Get invoice with payment info and verify token
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        brand:brands(id, name, code)
      `)
      .eq('id', id)
      .eq('public_access_token', token)
      .single()

    if (invoiceError || !invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found or access denied'
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

      // Calculate current payment status
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
    console.error('Error in GET /public/invoices/:id/payment-status:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/public/verify-invoice-access - Verify invoice access and generate admin redirect URL
router.post('/verify-invoice-access', async (req: Request, res: Response) => {
  try {
    console.log('=== INVOICE ACCESS VERIFICATION STARTED ===')
    const { invoiceNumber, invoiceId, clientIdentifier, brandCode } = req.body
    console.log('Request body:', { invoiceNumber, invoiceId, clientIdentifier, brandCode })

    if ((!invoiceNumber && !invoiceId) || !clientIdentifier) {
      console.log('Missing required parameters')
      return res.status(400).json({
        success: false,
        message: 'Invoice identifier and client identifier are required'
      })
    }

    console.log('Verifying invoice access:', { invoiceNumber, invoiceId, clientIdentifier, brandCode })

    // Find invoice by invoice number OR invoice ID and verify client access
    let invoice

    if (invoiceId) {
      // Search by invoice ID
      console.log('Searching by invoice ID:', invoiceId)
      const { data: invoiceData, error: invoiceError } = await supabaseAdmin
        .from('invoices')
        .select(`
          id,
          invoice_number,
          public_access_token,
          public_access_created_at,
          client_id,
          brand_id
        `)
        .eq('id', parseInt(invoiceId))
        .single()

      console.log('Invoice ID search result:', { invoiceData, invoiceError })

      if (invoiceData) {
        let clientData = null
        let brandData = null

        // Fetch client and brand separately (only if IDs exist)
        if (invoiceData.client_id) {
          const clientResult = await supabaseAdmin
            .from('clients')
            .select('id, first_name, last_name, company_name, email, phone_number')
            .eq('id', invoiceData.client_id)
            .single()
          clientData = clientResult.data
          if (clientResult.error) {
            console.error('Error fetching client data:', clientResult.error)
          }
        }

        if (invoiceData.brand_id) {
          const brandResult = await supabaseAdmin
            .from('brands')
            .select('id, name, code')
            .eq('id', invoiceData.brand_id)
            .single()
          brandData = brandResult.data
          if (brandResult.error) {
            console.error('Error fetching brand data:', brandResult.error)
          }
        }

        invoice = {
          ...invoiceData,
          client: clientData,
          brand: brandData
        }
        console.log('Invoice with relations:', { invoice, clientData, brandData })
      }

      if (invoiceError && invoiceError.code !== 'PGRST116') { // PGRST116 is "not found"
        console.error('Database error searching by invoice ID:', invoiceError)
      }
    } else {
      // Search by invoice number - try both with and without INV- prefix
      const searchTerms = [invoiceNumber.trim()]
      // If it doesn't start with INV-, also try with INV- prefix
      if (!invoiceNumber.trim().toUpperCase().startsWith('INV-')) {
        searchTerms.push(`INV-${invoiceNumber.trim()}`)
      }
      // If it starts with INV-, also try without INV- prefix
      else if (invoiceNumber.trim().toUpperCase().startsWith('INV-')) {
        searchTerms.push(invoiceNumber.trim().substring(4))
      }

      for (const term of searchTerms) {
        console.log('Searching by invoice number:', term)
        const { data: invoiceData, error: invoiceError } = await supabaseAdmin
          .from('invoices')
          .select(`
            id,
            invoice_number,
            public_access_token,
            public_access_created_at,
            client_id,
            brand_id
          `)
          .eq('invoice_number', term)
          .single()

        console.log('Invoice number search result:', term, { invoiceData, invoiceError })

        if (invoiceData && !invoiceError) {
          let clientData = null
          let brandData = null

          // Fetch client and brand separately (only if IDs exist)
          if (invoiceData.client_id) {
            const clientResult = await supabaseAdmin
              .from('clients')
              .select('id, first_name, last_name, company_name, email, phone_number')
              .eq('id', invoiceData.client_id)
              .single()
            clientData = clientResult.data
            if (clientResult.error) {
              console.error('Error fetching client data:', clientResult.error)
            }
          }

          if (invoiceData.brand_id) {
            const brandResult = await supabaseAdmin
              .from('brands')
              .select('id, name, code')
              .eq('id', invoiceData.brand_id)
              .single()
            brandData = brandResult.data
            if (brandResult.error) {
              console.error('Error fetching brand data:', brandResult.error)
            }
          }

          invoice = {
            ...invoiceData,
            client: clientData,
            brand: brandData
          }
          console.log('Found invoice by invoice number:', term, '-> ID:', invoice.id)
          break
        }
        if (invoiceError && invoiceError.code !== 'PGRST116') { // PGRST116 is "not found"
          console.error('Database error searching by invoice number:', term, invoiceError)
        } else if (invoiceError && invoiceError.code === 'PGRST116') {
          console.log('Invoice not found with term:', term)
        }
      }
    }

    let error = null
    if (!invoice) {
      error = { message: 'Invoice not found' }
    }

    if (error || !invoice) {
      console.log('Invoice not found:', { error: error?.message, invoiceNumber })
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    // Verify client access - check if clientIdentifier matches client ID or email
    const client = Array.isArray(invoice.client) ? invoice.client[0] : invoice.client
    const clientIdMatch = client?.id?.toString() === clientIdentifier.trim()
    const emailMatch = client?.email?.toLowerCase() === clientIdentifier.trim().toLowerCase()

    console.log('Client verification:', {
      provided: clientIdentifier,
      client: client,
      clientIdMatch,
      emailMatch,
      invoiceClientId: client?.id,
      invoiceClientEmail: client?.email
    })

    if (!clientIdMatch && !emailMatch) {
      console.log('Client verification failed')
      return res.status(403).json({
        success: false,
        message: 'Access denied. Please check your client ID or email address.'
      })
    }

    console.log('Client verification passed')

    // Verify brand access - ensure client belongs to the correct brand
    const brand = Array.isArray(invoice.brand) ? invoice.brand[0] : invoice.brand
    if (brandCode && brand?.code !== brandCode) {
      console.log('Brand verification failed:', {
        requestedBrand: brandCode,
        invoiceBrand: brand?.code,
        clientId: client?.id
      })
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      })
    }

    console.log('Client access verified for invoice:', invoice.id)

    // Generate or retrieve public access token
    let accessToken = invoice.public_access_token

    if (!accessToken) {
      // Generate a new secure token
      const crypto = require('crypto')
      accessToken = crypto.randomBytes(32).toString('hex')

      // Store the access token in the database
      const { error: tokenError } = await supabaseAdmin
        .from('invoices')
        .update({
          public_access_token: accessToken,
          public_access_created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', invoice.id)

      if (tokenError) {
        console.error('Error storing access token:', tokenError)
        return res.status(500).json({
          success: false,
          message: 'Failed to generate secure access token'
        })
      }

      console.log('Generated new access token for invoice:', invoice.id)
    }

    // Generate the admin URL (assuming admin is at localhost:3000)
    const adminBaseUrl = process.env.ADMIN_FRONTEND_URL || 'http://localhost:3000'
    const adminUrl = `${adminBaseUrl}/invoice/${invoice.id}/${accessToken}`

    console.log('Generated admin URL:', adminUrl)

    // Get full invoice data for the response
    const { data: fullInvoice, error: fullInvoiceError } = await supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number, billing_address1, billing_address2, billing_address3, billing_city, billing_region, billing_country, billing_post_code, buyer_premium, vendor_premium, client_type),
        auction:auctions(id, short_name, long_name, settlement_date, artwork_ids),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `)
      .eq('id', invoice.id)
      .single()

    if (fullInvoiceError) {
      console.error('Error fetching full invoice data:', fullInvoiceError)
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve invoice data'
      })
    }

    // Calculate additional amounts using array-based pricing
    const totalAmount = calculateTotalAmount(fullInvoice, 'final', fullInvoice.brand)
    const dueAmount = calculateDueAmount(fullInvoice, 'final', fullInvoice.brand)

    fullInvoice.total_amount = totalAmount
    fullInvoice.due_amount = dueAmount

    // Get artwork details
    let items: any[] = []
    const itemIds: number[] = Array.isArray(fullInvoice.item_ids) && fullInvoice.item_ids.length > 0
      ? fullInvoice.item_ids
      : (fullInvoice.auction?.artwork_ids || [])

    if (itemIds && itemIds.length > 0) {
      const { data: itemsData, error: itemsError } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', itemIds)

      if (!itemsError && itemsData) {
        items = itemIds
          .map((id: number) => itemsData.find((it: any) => it.id === id))
          .filter(Boolean) as any[]
      }
    }

    res.json({
      success: true,
      adminUrl,
      invoice: {
        ...fullInvoice,
        items
      },
      accessToken,
      invoiceId: invoice.id,
      message: 'Invoice access verified successfully'
    })

  } catch (error: any) {
    console.error('=== ERROR IN INVOICE ACCESS VERIFICATION ===')
    console.error('Error details:', error)
    console.error('Stack trace:', error.stack)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

export default router
