// backend/src/routes/consignments.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import { parsePhoneNumber, AsYouType } from 'libphonenumber-js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Create a separate router for public endpoints (no auth required)
const publicRouter = express.Router();

// Public endpoint for consignment receipt PDF generation
publicRouter.post('/:id/receipt-pdf', async (req: Request, res: Response) => {
  try {
    const { id: consignmentId } = req.params;

    // Get consignment with client and items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        items(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generateConsignmentReceiptPDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generateConsignmentReceiptPDF(
      consignment,
      consignment.clients,
      consignment.items || [],
      brand
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="consignment-receipt-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating public consignment receipt PDF:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});

// Public endpoint for pre-sale invoice PDF generation
publicRouter.post('/:id/presale-invoice-pdf', async (req: Request, res: Response) => {
  try {
    const { id: consignmentId } = req.params;
    const { sale_details } = req.body;

    if (!sale_details) {
      return res.status(400).json({ error: 'Sale details are required' });
    }

    // Get consignment with client and items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        items(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generatePreSaleInvoicePDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generatePreSaleInvoicePDF(
      consignment,
      consignment.clients,
      consignment.items || [],
      sale_details,
      brand
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="presale-invoice-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating public pre-sale invoice PDF:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});

// Public endpoint for collection receipt PDF generation
publicRouter.post('/:id/collection-receipt-pdf', async (req: Request, res: Response) => {
  try {
    const { id: consignmentId } = req.params;
    const { returned_items, collection_date, collected_by, released_by } = req.body;

    if (!returned_items || !Array.isArray(returned_items)) {
      return res.status(400).json({ error: 'Returned items are required' });
    }

    // Get consignment with client and items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        items(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generateCollectionReceiptPDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generateCollectionReceiptPDF(
      consignment,
      consignment.clients,
      returned_items,
      brand,
      collection_date,
      collected_by,
      released_by
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="collection-receipt-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating public collection receipt PDF:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});

// Export both routers
export { router as consignmentsRouter, publicRouter as consignmentsPublicRouter };

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

// Interface for Consignment with integer IDs
interface Consignment {
  id?: number;
  client_id: number;
  specialist_id?: number;
  valuation_day_id?: number;
  online_valuation_reference?: string;
  reference?: string; // New field
  reference_commission?: number; // New field
  default_sale_id?: number;
  default_vendor_commission?: number;
  status?: string;
  is_signed?: boolean;
  signing_date?: string;
  items_count?: number;
  total_estimated_value?: number;
  total_reserve_value?: number;
  total_sold_value?: number;
  sold_items_count?: number;
  created_at?: string;
  updated_at?: string;
  consignment_receipt_date?: string | null; // Calculated date (1 month back from auction)
  pre_sale_date?: string | null; // Calculated date (15 days back from auction)
}

// GET /consignments - List consignments with client information
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      status,
      client_id,
      search,
      page = 1,
      limit = 25,
      sort_field = 'created_at',
      sort_direction = 'asc'
    } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    // Build base filter function to reuse for both count and data queries
    const applyFilters = (query: any) => {
      if (status && status !== 'all') {
        query = query.eq('status', status);
      }
      if (client_id) {
        const parsedClientId = parseInt(client_id as string);
        if (!isNaN(parsedClientId)) {
          query = query.eq('client_id', parsedClientId);
        }
      }
      if (search) {
        const searchAsNumber = parseInt(search as string);
        if (!isNaN(searchAsNumber)) {
          query = query.or(`id.eq.${searchAsNumber},client_first_name.ilike.%${search}%,client_last_name.ilike.%${search}%,client_company.ilike.%${search}%,client_name.ilike.%${search}%`);
        } else {
          query = query.or(`client_first_name.ilike.%${search}%,client_last_name.ilike.%${search}%,client_company.ilike.%${search}%,client_name.ilike.%${search}%`);
        }
      }
      return query;
    };

    // ✅ Count query WITH same filters applied
    let countQuery = supabaseAdmin
      .from('consignments')
      .select('*', { count: 'exact', head: true });
    countQuery = applyFilters(countQuery);
    const { count: totalCount } = await countQuery;

    // Data query
    let dataQuery = supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        ),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        )
      `);

    dataQuery = applyFilters(dataQuery);

    dataQuery = dataQuery.order(sort_field as string, {
      ascending: sort_direction === 'asc'
    });

    dataQuery = dataQuery.range(offset, offset + limitNum - 1);

    const { data: consignments, error } = await dataQuery;

    if (error) {
      console.error('Error fetching consignments:', error);
      return res.status(500).json({
        error: 'Failed to fetch consignments',
        details: error.message
      });
    }

    // Enrich consignments with flattened brand/specialist data
    const enrichedConsignments = (consignments || []).map((c: any) => {
      const clientBrandRel = c.clients?.brands || {};
      const specialistRel = c.specialists || {};
      return {
        ...c,
        client_brand_code: clientBrandRel?.code || null,
        brand_code: clientBrandRel?.code || null,
        brand_name: clientBrandRel?.name || null,
        specialist_name: (specialistRel && specialistRel.first_name)
          ? `${specialistRel.first_name} ${specialistRel.last_name || ''}`.trim()
          : null,
      };
    });

    // Get items count for each consignment
    for (const consignment of enrichedConsignments) {
      const { count: itemsCount } = await supabaseAdmin
        .from('items')
        .select('*', { count: 'exact', head: true })
        .eq('consignment_id', consignment.id);
      consignment.items_count = itemsCount || 0;
    }

    // Status counts (unfiltered, for sidebar badges)
    const { data: statusCounts } = await supabaseAdmin
      .from('consignments')
      .select('status');

    const counts = { active: 0, pending: 0, completed: 0, cancelled: 0, archived: 0 };
    statusCounts?.forEach(c => {
      if (c.status in counts) counts[c.status as keyof typeof counts]++;
    });

    res.json({
      success: true,
      data: enrichedConsignments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / limitNum)
      },
      counts
    });

  } catch (error: any) {
    console.error('Error in GET /consignments:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
// GET /consignments/:id/presale-options - Get available pre-sale invoice options
router.get('/:id/presale-options', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Parse and validate integer ID
    const consignmentId = parseInt(id);
    if (isNaN(consignmentId)) {
      return res.status(400).json({ error: 'Invalid consignment ID format. Must be an integer.' });
    }

    // Get consignment with items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        id,
        items!left(
          id,
          title,
          description,
          status,
          low_est,
          high_est,
          reserve,
          artist_id
        )
      `)
      .eq('id', consignmentId)
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Filter for non-returned items only
    const nonReturnedItems = consignment.items.filter((item: any) => item.status !== 'passed');

    if (nonReturnedItems.length === 0) {
      return res.json({
        success: true,
        data: {
          presaleOptions: [],
          message: 'No non-returned items found in this consignment'
        }
      });
    }

    // Get all auctions that contain these item IDs
    const itemIds = nonReturnedItems.map((item: any) => item.id);

    const { data: auctions, error: auctionsError } = await supabaseAdmin
      .from('auctions')
      .select(`
        id,
        short_name,
        long_name,
        settlement_date,
        type,
        subtype,
        catalogue_launch_date,
        brand_id,
        brand:brand_id(id, code, name),
        artwork_ids,
        specialist_id,
        specialists:profiles(id, first_name, last_name)
      `)
      .contains('artwork_ids', itemIds);

    if (auctionsError) {
      console.error('Error fetching auctions:', auctionsError);
      return res.status(500).json({ error: 'Failed to fetch auction data' });
    }

    // Group items by auction and create presale options
    const presaleOptions = (auctions || []).map(auction => {
      // Find items that are in this auction
      const auctionItems = nonReturnedItems.filter((item: any) =>
        auction.artwork_ids && auction.artwork_ids.includes(item.id)
      );

      // Add auction information to items
      const itemsWithAuctionInfo = auctionItems.map((item: any) => ({
        ...item,
        auction_id: auction.id,
        auction_short_name: auction.short_name,
        auction_long_name: auction.long_name,
        auction_settlement_date: auction.settlement_date
      }));

      // Handle specialist name properly
      let specialist_name = null;
      const specialistData = (auction as any).specialists;

      if (auction.specialist_id && specialistData && typeof specialistData === 'object') {
        if (specialistData.first_name || specialistData.last_name) {
          specialist_name = `${specialistData.first_name || ''} ${specialistData.last_name || ''}`.trim();
        }
      }

      return {
        auction_id: auction.id,
        auction_short_name: auction.short_name,
        auction_long_name: auction.long_name,
        auction_settlement_date: auction.settlement_date,
        auction_type: auction.type,
        auction_subtype: auction.subtype,
        auction_catalogue_launch_date: auction.catalogue_launch_date,
        brand_id: auction.brand_id,
        brand_code: (auction as any).brand?.code,
        brand_name: (auction as any).brand?.name,
        specialist_id: auction.specialist_id,
        specialist_name: specialist_name,
        items_count: auctionItems.length,
        items: itemsWithAuctionInfo,
        total_low_est: auctionItems.reduce((sum: number, item: any) => sum + (item.low_est || 0), 0),
        total_high_est: auctionItems.reduce((sum: number, item: any) => sum + (item.high_est || 0), 0),
        total_reserve: auctionItems.reduce((sum: number, item: any) => sum + (item.reserve || 0), 0)
      };
    });

    res.json({
      success: true,
      data: {
        consignment_id: consignmentId,
        total_items: nonReturnedItems.length,
        presaleOptions: presaleOptions,
        message: presaleOptions.length > 0
          ? `${presaleOptions.length} pre-sale invoice option(s) available`
          : 'No auctions found containing items from this consignment'
      }
    });

  } catch (error: any) {
    console.error('Error in GET /consignments/:id/presale-options:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /consignments/:id - Get single consignment by integer ID
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Parse and validate integer ID
    const consignmentId = parseInt(id);
    if (isNaN(consignmentId)) {
      return res.status(400).json({ error: 'Invalid consignment ID format. Must be an integer.' });
    }

    const { data: consignment, error } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        ),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        )
      `)
      .eq('id', consignmentId)
      .single();

    // Enrich consignment with flattened brand data (same as clients route)
    let enrichedConsignment = consignment;
    if (consignment && !error) {
      const clientBrandRel = (consignment as any).clients?.brands || {};
      const specialistRel = (consignment as any).specialists || {};
      enrichedConsignment = {
        ...consignment,
        // Flatten client brand data for formatClientDisplay compatibility
        client_brand_code: clientBrandRel?.code || null,
        brand_code: clientBrandRel?.code || null,
        brand_name: clientBrandRel?.name || null,
        // Flatten specialist data
        specialist_name: (specialistRel && specialistRel.first_name) ?
          `${specialistRel.first_name} ${specialistRel.last_name || ''}`.trim() : null,
      };

      // Get actual items count for this consignment
      const { count: itemsCount } = await supabaseAdmin
        .from('items')
        .select('*', { count: 'exact', head: true })
        .eq('consignment_id', consignmentId);

      enrichedConsignment.items_count = itemsCount || 0;
    }

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Consignment not found' });
      }
      console.error('Error fetching consignment:', error);
      return res.status(500).json({
        error: 'Failed to fetch consignment',
        details: error.message
      });
    }

    res.json({
      success: true,
      data: enrichedConsignment
    });

  } catch (error: any) {
    console.error('Error in GET /consignments/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /consignments - Create new consignment
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const consignmentData: Consignment = req.body;
    const userId = req.user?.id;

    // Validate required fields
    if (!consignmentData.client_id) {
      return res.status(400).json({
        error: 'Client ID is required'
      });
    }

    // Parse and validate client_id as integer
    const clientId = parseInt(consignmentData.client_id.toString());
    if (isNaN(clientId)) {
      return res.status(400).json({
        error: 'Client ID must be a valid integer'
      });
    }

    // Verify client exists (do not reference legacy display_id)
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      console.error('Client validation error:', clientError);
      return res.status(400).json({
        error: 'Invalid client ID. Client not found.',
        details: clientError?.message
      });
    }

    // No need to check for duplicate consignment number since we use auto-generated IDs

    // Calculate consignment dates based on auction if provided
    let consignmentReceiptDate = null
    let preSaleDate = null
    
    if (consignmentData.default_sale_id) {
      // Fetch auction to get start date
      const { data: auction } = await supabaseAdmin
        .from('auctions')
        .select('auction_days')
        .eq('id', consignmentData.default_sale_id)
        .single()
      
      if (auction && auction.auction_days && Array.isArray(auction.auction_days) && auction.auction_days.length > 0) {
        // Get first auction day as start date
        const firstDay = auction.auction_days[0]
        if (firstDay && (firstDay as any).date) {
          const auctionStartDate = new Date((firstDay as any).date)
          
          // Calculate consignment receipt date (1 month back from auction start)
          consignmentReceiptDate = new Date(auctionStartDate)
          consignmentReceiptDate.setMonth(consignmentReceiptDate.getMonth() - 1)
          
          // Calculate pre-sale date (15 days back from auction start)
          preSaleDate = new Date(auctionStartDate)
          preSaleDate.setDate(preSaleDate.getDate() - 15)
        }
      }
    }

    // Prepare consignment data with audit fields and validated client_id
    const newConsignment = {
      ...consignmentData,
      client_id: clientId, // Use parsed integer
      consignment_receipt_date: consignmentReceiptDate?.toISOString() || consignmentData.consignment_receipt_date || null,
      pre_sale_date: preSaleDate?.toISOString() || consignmentData.pre_sale_date || null
    } as any;

    const { data: consignment, error } = await supabaseAdmin
      .from('consignments')
      .insert([newConsignment])
      .select()
      .single();

    if (error) {
      console.error('Error creating consignment:', error);
      return res.status(500).json({
        error: 'Failed to create consignment',
        details: error.message
      });
    }

    // Fetch the created consignment with client information and brand data
    const { data: consignmentWithClient, error: fetchError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        )
      `)
      .eq('id', consignment.id)
      .single();

    if (fetchError) {
      console.error('Error fetching created consignment with client:', fetchError);
      // Return the basic consignment if view fetch fails
      return res.status(201).json({
        success: true,
        data: consignment,
        message: 'Consignment created successfully'
      });
    }

    // Enrich with flattened brand data
    const clientBrandRel = (consignmentWithClient as any).clients?.brands || {};
    const enrichedConsignmentWithClient = {
      ...consignmentWithClient,
      client_brand_code: clientBrandRel?.code || null,
      brand_code: clientBrandRel?.code || null,
      brand_name: clientBrandRel?.name || null,
    };

    // Auto-sync to Google Sheets if configured
    console.log('Auto-syncing to Google Sheets for consignment:', consignment?.id);
    if (consignment?.id) {
      autoSyncConsignmentToGoogleSheets(consignment.id);
    }

    res.status(201).json({
      success: true,
      data: enrichedConsignmentWithClient,
      message: 'Consignment created successfully'
    });

  } catch (error: any) {
    console.error('Error in POST /consignments:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// PUT /consignments/:id - Update consignment by integer ID
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const consignmentData: Consignment = req.body;
    const userId = req.user?.id;

    // Parse and validate integer ID
    const consignmentId = parseInt(id);
    if (isNaN(consignmentId)) {
      return res.status(400).json({ error: 'Invalid consignment ID format. Must be an integer.' });
    }

    // Check if consignment exists
    const { data: existingConsignment, error: fetchError } = await supabaseAdmin
      .from('consignments')
      .select('id')
      .eq('id', consignmentId)
      .single();

    if (fetchError || !existingConsignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Validate client_id if being updated
    if (consignmentData.client_id) {
      const clientId = parseInt(consignmentData.client_id.toString());
      if (isNaN(clientId)) {
        return res.status(400).json({
          error: 'Client ID must be a valid integer'
        });
      }

      // Verify client exists
      const { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', clientId)
        .single();

      if (clientError || !client) {
        return res.status(400).json({
          error: 'Invalid client ID. Client not found.'
        });
      }

      consignmentData.client_id = clientId; // Use parsed integer
    }

    // No need to check for duplicate consignment number since we use auto-generated IDs

    // Prepare update data with audit fields
    const updateData = {
      ...consignmentData
    } as any;

    const { data: consignment, error } = await supabaseAdmin
      .from('consignments')
      .update(updateData)
      .eq('id', consignmentId)
      .select()
      .single();

    if (error) {
      console.error('Error updating consignment:', error);
      return res.status(500).json({
        error: 'Failed to update consignment',
        details: error.message
      });
    }

    // Fetch the updated consignment with client information and brand data
    const { data: consignmentWithClient, error: fetchWithClientError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        )
      `)
      .eq('id', consignmentId)
      .single();

    // Enrich with flattened brand data if fetch was successful
    let enrichedData = consignmentWithClient || consignment;
    if (consignmentWithClient && !fetchWithClientError) {
      const clientBrandRel = (consignmentWithClient as any).clients?.brands || {};
      enrichedData = {
        ...consignmentWithClient,
        client_brand_code: clientBrandRel?.code || null,
        brand_code: clientBrandRel?.code || null,
        brand_name: clientBrandRel?.name || null,
      };
    }

    // Auto-sync to Google Sheets if configured
    if (consignment?.id) {
      autoSyncConsignmentToGoogleSheets(consignment.id);
    }

    res.json({
      success: true,
      data: enrichedData,
      message: 'Consignment updated successfully'
    });

  } catch (error: any) {
    console.error('Error in PUT /consignments/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// DELETE /consignments/:id - Delete consignment by integer ID (soft delete by default)
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { hard_delete = false } = req.query;
    const userId = req.user?.id;

    // Parse and validate integer ID
    const consignmentId = parseInt(id);
    if (isNaN(consignmentId)) {
      return res.status(400).json({ error: 'Invalid consignment ID format. Must be an integer.' });
    }

    // First, reset all items' consignment_id to null for this consignment
    const { error: resetItemsError } = await supabaseAdmin
      .from('items')
      .update({ consignment_id: null })
      .eq('consignment_id', consignmentId);

    if (resetItemsError) {
      console.error('Error resetting items consignment_id:', resetItemsError);
      return res.status(500).json({
        error: 'Failed to reset items consignment_id',
        details: resetItemsError.message
      });
    }

    console.log(`Reset consignment_id to null for all items in consignment ${consignmentId}`);

    if (hard_delete === 'true') {
      // Hard delete - permanently remove consignment
      const { error } = await supabaseAdmin
        .from('consignments')
        .delete()
        .eq('id', consignmentId);

      if (error) {
        console.error('Error hard deleting consignment:', error);
        return res.status(500).json({
          error: 'Failed to delete consignment',
          details: error.message
        });
      }

      res.json({
        success: true,
        message: 'Consignment permanently deleted'
      });
    } else {
      // Soft delete - mark as cancelled or archived
      const { data: consignment, error } = await supabaseAdmin
        .from('consignments')
        .update({
          status: 'cancelled',
        })
        .eq('id', consignmentId)
        .select()
        .single();

      if (error) {
        console.error('Error soft deleting consignment:', error);
        return res.status(500).json({
          error: 'Failed to delete consignment',
          details: error.message
        });
      }

      res.json({
        success: true,
        data: consignment,
        message: 'Consignment marked as cancelled'
      });
    }

  } catch (error: any) {
    console.error('Error in DELETE /consignments/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /consignments/bulk-action - Bulk operations on consignments
router.post('/bulk-action', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, consignment_ids, data } = req.body;
    const userId = req.user?.id;

    if (!action || !consignment_ids || !Array.isArray(consignment_ids)) {
      return res.status(400).json({
        error: 'Action and consignment_ids array are required'
      });
    }

    // Parse consignment IDs to integers
    const parsedConsignmentIds = consignment_ids.map((id: any) => {
      const parsed = parseInt(id);
      if (isNaN(parsed)) {
        throw new Error(`Invalid consignment ID: ${id}`);
      }
      return parsed;
    });

    let result;
    switch (action) {
      case 'delete':
        // First, reset all items' consignment_id to null for these consignments
        const { error: resetItemsError } = await supabaseAdmin
          .from('items')
          .update({ consignment_id: null })
          .in('consignment_id', parsedConsignmentIds);

        if (resetItemsError) {
          console.error('Error resetting items consignment_id in bulk action:', resetItemsError);
          return res.status(500).json({
            error: 'Failed to reset items consignment_id',
            details: resetItemsError.message
          });
        }

        console.log(`Reset consignment_id to null for all items in consignments: ${parsedConsignmentIds.join(', ')}`);

        result = await supabaseAdmin
          .from('consignments')
          .update({
            status: 'cancelled',
          })
          .in('id', parsedConsignmentIds);
        break;

      case 'hard_delete':
        // First, reset all items' consignment_id to null for these consignments
        const { error: resetItemsErrorHard } = await supabaseAdmin
          .from('items')
          .update({ consignment_id: null })
          .in('consignment_id', parsedConsignmentIds);

        if (resetItemsErrorHard) {
          console.error('Error resetting items consignment_id in bulk hard delete:', resetItemsErrorHard);
          return res.status(500).json({
            error: 'Failed to reset items consignment_id',
            details: resetItemsErrorHard.message
          });
        }

        console.log(`Reset consignment_id to null for all items in consignments: ${parsedConsignmentIds.join(', ')}`);

        result = await supabaseAdmin
          .from('consignments')
          .delete()
          .in('id', parsedConsignmentIds);
        break;

      case 'update_status':
        if (!data?.status) {
          return res.status(400).json({
            error: 'Status is required for update_status action'
          });
        }
        result = await supabaseAdmin
          .from('consignments')
          .update({
            status: data.status,
          })
          .in('id', parsedConsignmentIds);
        break;

      default:
        return res.status(400).json({
          error: 'Invalid action. Supported actions: delete, hard_delete, update_status'
        });
    }

    if (result.error) {
      console.error('Error in bulk action:', result.error);
      return res.status(500).json({
        error: 'Failed to perform bulk action',
        details: result.error.message
      });
    }

    res.json({
      success: true,
      message: `Bulk ${action} completed successfully`,
      affected_count: parsedConsignmentIds.length
    });

  } catch (error: any) {
    console.error('Error in POST /consignments/bulk-action:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /consignments/generate-pdf - Generate PDF report for selected consignments
router.post('/generate-pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { consignments, template, customization, userRole } = req.body;
    const userId = req.user?.id;

    // Check if user has permission (super admin only for custom templates)
    if (template === 'custom' && userRole !== 'super_admin') {
      return res.status(403).json({ 
        error: 'Custom PDF templates are only available to super administrators' 
      });
    }

    if (!consignments || !Array.isArray(consignments) || consignments.length === 0) {
      return res.status(400).json({ error: 'No consignments provided' });
    }

    // Get detailed consignment data from database
    const consignmentIds = consignments.map(c => c.id).filter(Boolean);
    
    const { data: detailedConsignments, error: consignmentError } = await supabaseAdmin
      .from('consignments_with_details')
      .select('*')
      .in('id', consignmentIds);

    if (consignmentError) {
      console.error('Error fetching consignment details:', consignmentError);
      return res.status(500).json({ 
        error: 'Failed to fetch consignment details',
        details: consignmentError.message 
      });
    }

    // Generate HTML content based on template
    let htmlContent = '';
    
    switch (template) {
      case 'summary':
        htmlContent = generateSummaryHTML(detailedConsignments, customization);
        break;
      case 'detailed':
        htmlContent = generateDetailedHTML(detailedConsignments, customization);
        break;
      case 'financial':
        htmlContent = generateFinancialHTML(detailedConsignments, customization);
        break;
      case 'custom':
        htmlContent = generateCustomHTML(detailedConsignments, customization);
        break;
      default:
        htmlContent = generateSummaryHTML(detailedConsignments, customization);
    }

    // For now, return HTML content that can be converted to PDF on frontend
    // In production, you might want to use a server-side PDF library like puppeteer
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);

  } catch (error: any) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      details: error.message 
    });
  }
});

// Helper function to generate summary HTML
function generateSummaryHTML(consignments: any[], customization: any): string {
  const { 
    includeHeader = true, 
    includeFooter = true, 
    headerText = 'Consignment Summary Report',
    footerText = 'Confidential Document',
    documentTitle = 'Consignment Summary',
    fontSize = 'medium'
  } = customization || {};

  const fontSizeClass = fontSize === 'small' ? 'text-sm' : fontSize === 'large' ? 'text-lg' : 'text-base';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${documentTitle}</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 20px; 
          line-height: 1.6;
          color: #333;
        }
        .header { 
          text-align: center; 
          border-bottom: 2px solid #333; 
          padding-bottom: 20px; 
          margin-bottom: 30px; 
        }
        .footer { 
          text-align: center; 
          border-top: 1px solid #ccc; 
          padding-top: 20px; 
          margin-top: 30px; 
          font-size: 12px;
          color: #666;
        }
        .consignment-item { 
          border: 1px solid #ddd; 
          margin-bottom: 20px; 
          padding: 15px; 
          border-radius: 5px;
        }
        .consignment-header { 
          font-weight: bold; 
          font-size: 16px; 
          margin-bottom: 10px; 
          color: #2563eb;
        }
        .detail-row { 
          display: flex; 
          justify-content: space-between; 
          margin-bottom: 5px; 
        }
        .label { 
          font-weight: bold; 
          width: 150px; 
        }
        .value { 
          flex: 1; 
        }
        .summary-stats {
          background-color: #f8f9fa;
          padding: 20px;
          border-radius: 5px;
          margin-bottom: 30px;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 15px;
        }
        .stat-item {
          text-align: center;
        }
        .stat-number {
          font-size: 24px;
          font-weight: bold;
          color: #2563eb;
        }
        .stat-label {
          font-size: 14px;
          color: #666;
          margin-top: 5px;
        }
      </style>
    </head>
    <body>
      ${includeHeader ? `<div class="header"><h1>${headerText}</h1><p>Generated on ${new Date().toLocaleDateString()}</p></div>` : ''}
      
      <div class="summary-stats">
        <h2>Summary Statistics</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-number">${consignments.length}</div>
            <div class="stat-label">Total Consignments</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${consignments.reduce((sum, c) => sum + (c.items_count || 0), 0)}</div>
            <div class="stat-label">Total Items</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">£${consignments.reduce((sum, c) => sum + (c.total_estimated_value || 0), 0).toLocaleString()}</div>
            <div class="stat-label">Total Estimated Value</div>
          </div>
        </div>
      </div>

      ${consignments.map(consignment => `
        <div class="consignment-item">
          <div class="consignment-header">Consignment #${consignment.id}</div>
          <div class="detail-row">
            <span class="label">Client:</span>
            <span class="value">${consignment.client_name || 'Unknown Client'}</span>
          </div>
          <div class="detail-row">
            <span class="label">Items Count:</span>
            <span class="value">${consignment.items_count || 0}</span>
          </div>
          <div class="detail-row">
            <span class="label">Status:</span>
            <span class="value">${consignment.status || 'Draft'}</span>
          </div>
          <div class="detail-row">
            <span class="label">Specialist:</span>
            <span class="value">${consignment.specialist_name || 'Not assigned'}</span>
          </div>
          <div class="detail-row">
            <span class="label">Created:</span>
            <span class="value">${consignment.created_at ? new Date(consignment.created_at).toLocaleDateString() : 'Unknown'}</span>
          </div>
        </div>
      `).join('')}

      ${includeFooter ? `<div class="footer">${footerText} - Generated by MSaber System</div>` : ''}
    </body>
    </html>
  `;
}

// Helper function to generate detailed HTML (placeholder)
function generateDetailedHTML(consignments: any[], customization: any): string {
  // Similar to summary but with more details
  return generateSummaryHTML(consignments, customization).replace(
    'Consignment Summary Report',
    'Detailed Consignment Report'
  );
}

// Helper function to generate financial HTML (placeholder)  
function generateFinancialHTML(consignments: any[], customization: any): string {
  // Similar to summary but with financial focus
  return generateSummaryHTML(consignments, customization).replace(
    'Consignment Summary Report',
    'Financial Consignment Report'
  );
}

// Helper function to generate custom HTML
function generateCustomHTML(consignments: any[], customization: any): string {
  // Full customization based on user preferences
  return generateSummaryHTML(consignments, customization);
}

// GET /api/consignments/export/csv - Export consignments to CSV
router.get('/export/csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { 
      status, 
      client_id,
      search 
    } = req.query;

    let query = supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        )
      `);

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (client_id) {
      const parsedClientId = parseInt(client_id as string);
      if (!isNaN(parsedClientId)) {
        query = query.eq('client_id', parsedClientId);
      }
    }

    if (search) {
      // Try to parse search as number for ID search
      const searchAsNumber = parseInt(search as string);
      if (!isNaN(searchAsNumber)) {
        query = query.or(`id.eq.${searchAsNumber},client_first_name.ilike.%${search}%,client_last_name.ilike.%${search}%,client_company.ilike.%${search}%,client_name.ilike.%${search}%`);
      } else {
        query = query.or(`client_first_name.ilike.%${search}%,client_last_name.ilike.%${search}%,client_company.ilike.%${search}%,client_name.ilike.%${search}%`);
      }
    }

    const { data: consignments, error } = await query;

    if (error) {
      console.error('Error fetching consignments for export:', error);
      return res.status(500).json({ error: 'Failed to fetch consignments for export' });
    }

    // CSV headers
    const headers = [
      'ID', 'Client ID', 'Client Name', 'Client Company', 
      'Items Count', 'Specialist', 'Status', 'Signed', 'Total Estimated Value',
      'Total Reserve Value', 'Created Date'
    ];

    // Convert consignments to CSV format
    const csvData = (consignments || []).map(consignment => [
      consignment.id,
      consignment.client_id,
      consignment.client_name || `${consignment.client_first_name || ''} ${consignment.client_last_name || ''}`.trim(),
      consignment.client_company || '',
      consignment.items_count || 0,
      consignment.specialist_name || '',
      consignment.status,
      consignment.is_signed ? 'Yes' : 'No',
      consignment.total_estimated_value || 0,
      consignment.total_reserve_value || 0,
      consignment.created_at
    ]);

    // Create CSV content
    const csvContent = [headers, ...csvData]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=consignments-export-${timestamp}.csv`);
    res.send(csvContent);

  } catch (error: any) {
    console.error('Error in GET /consignments/export/csv:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to write consignment data to Google Sheets
async function writeConsignmentsToGoogleSheets(sheetUrl: string | { url: string }, consignments: any[]): Promise<boolean> {
  try {
    console.log(`📝 writeConsignmentsToGoogleSheets called with ${consignments.length} consignments`);
    console.log(`🔗 Sheet URL: ${sheetUrl}`);
    
    const { google } = require('googleapis');
    
    // Handle both string and object formats for sheetUrl
    const actualSheetUrl = typeof sheetUrl === 'string' ? sheetUrl : sheetUrl.url;
    console.log('sheeturl', actualSheetUrl);

    // Extract sheet ID from URL
    const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);    
    if (!sheetIdMatch) {
      console.error('❌ Invalid Google Sheets URL format');
      throw new Error('Invalid Google Sheets URL format');
    }
    
    const spreadsheetId = sheetIdMatch[1];
    console.log(`📊 Spreadsheet ID: ${spreadsheetId}`);
    
    // Check if required environment variables are set
    const requiredEnvVars = ['GOOGLE_PROJECT_ID', 'GOOGLE_PRIVATE_KEY_ID', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_CLIENT_ID'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    console.log('🔐 Google service account credentials found');
    
    // Initialize Google Sheets API with service account
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID
      } as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    console.log('🔧 Google Sheets API client initialized');

    // Prepare data for Google Sheets
    const headers = [
      'ID', 'Client ID', 'Client Name', 'Client Company', 
      'Items Count', 'Specialist', 'Status', 'Signed', 'Total Estimated Value',
      'Total Reserve Value', 'Created Date'
    ];

    const data = [
        headers,
          ...consignments.map(consignment => {
        const client = consignment.clients; 

        const clientName = client
          ? (
              client.company_name ||
              `${client.first_name || ''} ${client.last_name || ''}`.trim()
            )
          : '';

        return [
          consignment.id,
          consignment.client_id,
          clientName,
          client?.company_name || '',
          consignment.items_count || 0,
          consignment.specialist_name || '',
          consignment.status,
          consignment.is_signed ? 'Yes' : 'No',
          consignment.total_estimated_value || 0,
          consignment.total_reserve_value || 0,
          consignment.created_at
        ];
      })
    ];

    console.log(`📋 Prepared ${data.length} rows for Google Sheets (including header)`);

    // Clear existing data first
    console.log('🧹 Clearing existing data in Sheet1...');
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Sheet1',
    });

    // Write new data
    console.log('✍️ Writing new data to Google Sheets...');
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: data,
      },
    });

    console.log('✅ Successfully wrote consignments to Google Sheets:', result.data.updatedCells, 'cells updated');
    return true;

  } catch (error: any) {
    console.error('❌ Error writing consignments to Google Sheets:', error.message);
    console.error('❌ Full error:', error);
    return false;
  }
}

// POST /api/consignments/sync-to-google-sheet - Sync consignments to Google Sheets
router.post('/sync-to-google-sheet', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sheet_url, consignment_ids } = req.body;

    if (!sheet_url) {
      return res.status(400).json({ error: 'Google Sheets URL is required' });
    }

    // Get consignments data
    let query = supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        )
      `);

    // Filter by specific consignment IDs if provided
    if (consignment_ids && Array.isArray(consignment_ids) && consignment_ids.length > 0) {
      query = query.in('id', consignment_ids);
    }

    const { data: consignments, error } = await query;

    if (error) {
      console.error('Error fetching consignments for sync:', error);
      return res.status(500).json({ error: 'Failed to fetch consignments' });
    }

    // Calculate items count for each consignment
    if (consignments && consignments.length > 0) {
      for (const consignment of consignments) {
        const { count: itemsCount } = await supabaseAdmin
          .from('items')
          .select('*', { count: 'exact', head: true })
          .eq('consignment_id', consignment.id);
        
        consignment.items_count = itemsCount || 0;
      }
    }

    // Write to Google Sheets
    const success = await writeConsignmentsToGoogleSheets(sheet_url, consignments || []);

    if (success) {
      res.json({
        success: true,
        message: `Successfully synced ${(consignments || []).length} consignments to Google Sheets`,
        count: (consignments || []).length
      });
    } else {
      res.status(500).json({
        error: 'Failed to sync consignments to Google Sheets. Please check your Google Sheets configuration.'
      });
    }

  } catch (error: any) {
    console.error('Error in POST /consignments/sync-to-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to convert Google Sheets URL to CSV format
function convertToGoogleSheetsCSVUrl(url: string): string {
  // Check if it's already a CSV export URL
  if (url.includes('/export?format=csv')) {
    return url;
  }
  
  // Extract sheet ID from various Google Sheets URL formats
  let sheetId = '';
  const patterns = [
    /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    /docs\.google\.com.*[\/=]([a-zA-Z0-9-_]{44})/,
    /^([a-zA-Z0-9-_]{44})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      sheetId = match[1];
      break;
    }
  }
  
  if (!sheetId) {
    throw new Error('Invalid Google Sheets URL format');
  }
  
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
}

// POST /api/consignments/sync-google-sheet - Import consignments from Google Sheets
router.post('/sync-google-sheet', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sheet_url, default_brand } = req.body as { sheet_url?: string; default_brand?: string };
    console.log('Original sheet_url:', sheet_url);
    console.log('Default brand for empty fields:', default_brand);
    
    if (!sheet_url) {
      return res.status(400).json({ error: 'sheet_url is required' });
    }

    // Convert to proper CSV export URL
    const csvUrl = convertToGoogleSheetsCSVUrl(sheet_url);
    console.log('Converted CSV URL:', csvUrl);

    // Fetch CSV with proper headers
    const response = await fetch(csvUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      console.error('Fetch failed:', response.status, response.statusText);
      return res.status(400).json({ 
        error: `Failed to fetch sheet: ${response.statusText}`,
        details: `Status: ${response.status}, URL: ${csvUrl}`
      });
    }
    
    const csvText = await response.text();
    console.log('CSV Text Length:', csvText.length);
    console.log('CSV Text Preview:', csvText.substring(0, 500));

    // Use Papa Parse for better CSV parsing
    const Papa = require('papaparse');
    const parseResult = Papa.parse(csvText, {
      header: false,
      skipEmptyLines: true,
      transform: (value: string) => value.trim()
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      console.error('Papa Parse errors:', parseResult.errors);
      return res.status(400).json({ 
        error: 'CSV parsing failed', 
        details: parseResult.errors.map((e: any) => e.message).join(', ') 
      });
    }

    const rows = parseResult.data;
    if (rows.length < 2) {
      return res.status(400).json({ 
        error: 'Sheet appears to be empty or has no data rows',
        details: `Only ${rows.length} rows found`
      });
    }

    const headers = rows[0].map((header: string) => header.toLowerCase().trim());
    console.log('Headers found:', headers);

    // Expected columns for consignments (support both formats)
    const hasClientIdCol = headers.includes('client id') || headers.includes('client_id');
    if (!hasClientIdCol) {
      return res.status(400).json({ 
        error: `Missing required column: 'client id' or 'client_id'`,
        details: `Found columns: ${headers.join(', ')}`
      });
    }

    // Track processing results
    const results = {
      total: rows.length - 1,
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    // Process each data row
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      
      try {
        // Create mapping from headers to values
        const rowData: Record<string, string> = {};
        headers.forEach((header: any, index: number) => {
          rowData[header] = row[index] || '';
        });

        // Validate required fields
        const clientId = rowData['client id'] || rowData.client_id;
        if (!clientId) {
          results.failed++;
          results.errors.push(`Row ${i + 1}: Missing client_id or 'client id'`);
          continue;
        }

        // Prepare consignment data
        const consignmentData: any = {
          client_id: parseInt(clientId),
          specialist_id: rowData.specialist_id ? parseInt(rowData.specialist_id) : null,
          status: rowData.status || 'active',
          is_signed: rowData.is_signed?.toLowerCase() === 'true' || rowData.is_signed === '1',
          signing_date: rowData.signing_date || null,
          online_valuation_reference: rowData.online_valuation_reference || null,
          default_vendor_commission: rowData.default_vendor_commission ? parseFloat(rowData.default_vendor_commission) : null
        };

        // Support id column for updates (like clients and auctions)
        if (rowData.id) {
          const idNum = parseInt(String(rowData.id), 10);
          if (!Number.isNaN(idNum)) {
            consignmentData.id = idNum;
          }
        }

        // Validate client exists
        const { data: client, error: clientError } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', consignmentData.client_id)
          .single();

        if (clientError || !client) {
          results.failed++;
          results.errors.push(`Row ${i + 1}: Client ID ${consignmentData.client_id} not found`);
          continue;
        }

        // Handle upsert (update if ID exists, insert if new)
        let newConsignment;
        let operationError;

        if (consignmentData.id) {
          // Update existing consignment
          const { data, error } = await supabaseAdmin
            .from('consignments')
            .upsert(consignmentData, { onConflict: 'id' })
            .select()
            .single();
          newConsignment = data;
          operationError = error;
        } else {
          // Insert new consignment
          const { data, error } = await supabaseAdmin
            .from('consignments')
            .insert([consignmentData])
            .select()
            .single();
          newConsignment = data;
          operationError = error;
        }

        if (operationError) {
          results.failed++;
          results.errors.push(`Row ${i + 1}: ${operationError.message}`);
          continue;
        }

        results.success++;
        console.log(`Successfully ${consignmentData.id ? 'updated' : 'created'} consignment ${newConsignment.id}`);

      } catch (error: any) {
        results.failed++;
        results.errors.push(`Row ${i + 1}: ${error.message}`);
        console.error(`Error processing row ${i + 1}:`, error);
      }
    }

    res.json({
      success: true,
      message: `Import completed: ${results.success} success, ${results.failed} failed`,
      results
    });

  } catch (error: any) {
    console.error('Error in POST /consignments/sync-google-sheet:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/consignments/:id/add-artworks - Add artworks to consignment
router.post('/:id/add-artworks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: consignmentId } = req.params;
    const { artwork_ids } = req.body;

    if (!artwork_ids || !Array.isArray(artwork_ids)) {
      return res.status(400).json({ error: 'Artwork IDs array is required' });
    }

    // Validate consignment exists
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select('id')
      .eq('id', consignmentId)
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Update artworks to link them to this consignment
    const { error: updateError } = await supabaseAdmin
      .from('items')
      .update({ consignment_id: parseInt(consignmentId) })
      .in('id', artwork_ids);

    if (updateError) {
      console.error('Error linking artworks to consignment:', updateError);
      return res.status(500).json({
        error: 'Failed to link artworks to consignment',
        details: updateError.message
      });
    }

    // Auto-sync to Google Sheets after linking artworks
    autoSyncConsignmentToGoogleSheets(parseInt(consignmentId));

    res.json({
      success: true,
      message: `Successfully linked ${artwork_ids.length} artworks to consignment`,
      consignment_id: consignmentId,
      artwork_count: artwork_ids.length
    });

  } catch (error: any) {
    console.error('Error in POST /consignments/:id/add-artworks:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// DELETE /api/consignments/:id/remove-artworks - Remove artworks from consignment
router.delete('/:id/remove-artworks', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: consignmentId } = req.params;
    const { artwork_ids } = req.body;

    if (!artwork_ids || !Array.isArray(artwork_ids)) {
      return res.status(400).json({ error: 'Artwork IDs array is required' });
    }

    // Update artworks to remove them from this consignment
    const { error: updateError } = await supabaseAdmin
      .from('items')
      .update({ consignment_id: null })
      .in('id', artwork_ids)
      .eq('consignment_id', parseInt(consignmentId));

    if (updateError) {
      console.error('Error removing artworks from consignment:', updateError);
      return res.status(500).json({
        error: 'Failed to remove artworks from consignment',
        details: updateError.message
      });
    }

    res.json({
      success: true,
      message: `Successfully removed ${artwork_ids.length} artworks from consignment`,
      consignment_id: consignmentId,
      artwork_count: artwork_ids.length
    });

  } catch (error: any) {
    console.error('Error in DELETE /consignments/:id/remove-artworks:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Function to auto-sync all consignments to Google Sheets after create/update
async function autoSyncConsignmentToGoogleSheets(consignmentId: number) {
  try {
    console.log(`Starting auto-sync for consignment ${consignmentId}`);
    
    // Get Google Sheets URL from app settings
    const { data: settingData, error: settingError } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'google_sheet_url_consignments')
      .single();

    if (settingError) {
      console.log('Error fetching Google Sheets URL setting:', settingError.message);
      return;
    }

    if (!settingData?.value) {
      console.log('No Google Sheets URL configured for consignments auto-sync (key: google_sheet_url_consignments)');
      return;
    }

    console.log(`Found Google Sheets URL for consignments: ${settingData.value}`);

    // Get ALL consignments data to write the full database to Google Sheets
    const { data: allConsignments, error } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
        clients!left(
          id,
          first_name,
          last_name,
          company_name,
          brand_id,
          brands!left(code, name)
        )
      `)
      .order('id', { ascending: true });

    if (error) {
      console.error('Error fetching all consignments for auto-sync:', error);
      return;
    }

    if (!allConsignments || allConsignments.length === 0) {
      console.log('No consignments found for auto-sync');
      return;
    }

    console.log(`Found ${allConsignments.length} consignments for sync`);

    // Calculate items count for each consignment
    for (const consignment of allConsignments) {
      const { count: itemsCount } = await supabaseAdmin
        .from('items')
        .select('*', { count: 'exact', head: true })
        .eq('consignment_id', consignment.id);
      
      consignment.items_count = itemsCount || 0;
    }

    // Sync ALL consignments to Google Sheets (full database sync)
    console.log('Starting writeConsignmentsToGoogleSheets...');
    const success = await writeConsignmentsToGoogleSheets(settingData.value, allConsignments);
    
    if (success) {
      console.log(`✅ Auto-synced all ${allConsignments.length} consignments to Google Sheets after consignment ${consignmentId} was created/updated`);
    } else {
      console.error(`❌ Failed to auto-sync consignments to Google Sheets after consignment ${consignmentId} was created/updated`);
    }

  } catch (error) {
    console.error('❌ Error in auto-sync consignments to Google Sheets:', error);
  }
}

// POST /consignments/:id/receipt-pdf - Generate Consignment Receipt PDF
router.post('/:id/receipt-pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id: consignmentId } = req.params;

    // Get consignment with client, specialist and items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        ),
        items(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }


    // Add specialist name to consignment object
    if (consignment.specialists && consignment.specialists.first_name) {
      (consignment as any).specialist_name = `${consignment.specialists.first_name} ${consignment.specialists.last_name || ""}`.trim();
    }
    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generateConsignmentReceiptPDF } = await import('../utils/consignment-pdf-generator');
    
    const pdfBuffer = await generateConsignmentReceiptPDF(
      consignment,
      consignment.clients,
      consignment.items || [],
      brand
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="consignment-receipt-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating consignment receipt PDF:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      details: error.message 
    });
  }
});

// POST /consignments/:id/presale-invoice-pdf - Generate Pre-Sale Invoice PDF (Legacy - uses all non-returned items)
router.post('/:id/presale-invoice-pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id: consignmentId } = req.params;
    const { sale_details } = req.body;

    if (!sale_details) {
      return res.status(400).json({ error: 'Sale details are required' });
    }

    // Get consignment with client, specialist and items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        ),
        items(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }


    // Add specialist name to consignment object
    if (consignment.specialists && consignment.specialists.first_name) {
      (consignment as any).specialist_name = `${consignment.specialists.first_name} ${consignment.specialists.last_name || ""}`.trim();
    }

    // Filter items to only include non-returned items for pre-sale invoice
    const nonReturnedItems = (consignment.items || []).filter((item: any) => item.status !== 'passed');
    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generatePreSaleInvoicePDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generatePreSaleInvoicePDF(
      consignment,
      consignment.clients,
      nonReturnedItems,
      sale_details,
      brand
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="presale-invoice-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating pre-sale invoice PDF:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});

// POST /consignments/:id/presale-invoice-pdf/:auctionId - Generate Pre-Sale Invoice PDF for specific auction
router.post('/:id/presale-invoice-pdf/:auctionId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id: consignmentId, auctionId } = req.params;
    const { sale_details } = req.body;

    if (!sale_details) {
      return res.status(400).json({ error: 'Sale details are required' });
    }

    // Get consignment with client and specialist
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        )
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Add specialist name to consignment object
    if (consignment.specialists && consignment.specialists.first_name) {
      (consignment as any).specialist_name = `${consignment.specialists.first_name} ${consignment.specialists.last_name || ""}`.trim();
    }

    // Parse auction ID and validate
    const parsedAuctionId = parseInt(auctionId);
    if (isNaN(parsedAuctionId)) {
      return res.status(400).json({ error: 'Invalid auction ID format. Must be an integer.' });
    }

    console.log(`Looking up auction with ID: ${parsedAuctionId} (original: ${auctionId})`);

    // Get auction details
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select(`
        id,
        short_name,
        long_name,
        settlement_date,
        type,
        subtype,
        catalogue_launch_date,
        brand_id,
        brand:brand_id(id, code, name),
        artwork_ids,
        specialist_id
      `)
      .eq('id', parsedAuctionId)
      .single();

    if (auctionError) {
      console.error('Auction lookup error:', auctionError);
      return res.status(500).json({ error: 'Failed to fetch auction data', details: auctionError.message });
    }

    if (!auction) {
      console.error(`Auction not found with ID: ${parsedAuctionId}`);
      return res.status(404).json({ error: `Auction not found with ID: ${parsedAuctionId}` });
    }

    console.log(`Found auction: ${auction.short_name} (ID: ${auction.id})`);

    // Get items that are in this auction and belong to this consignment
    const { data: auctionItems, error: itemsError } = await supabaseAdmin
      .from('items')
      .select('*')
      .eq('consignment_id', parseInt(consignmentId))
      .in('id', auction.artwork_ids || [])
      .neq('status', 'passed'); // Exclude returned items

    if (itemsError) {
      console.error('Error fetching auction items:', itemsError);
      return res.status(500).json({ error: 'Failed to fetch auction items' });
    }

    if (!auctionItems || auctionItems.length === 0) {
      return res.status(400).json({ error: 'No items found for this auction in the consignment' });
    }

    // Get client's brand data (use auction brand if available, otherwise consignment client brand)
    const brandId = auction.brand_id || consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', brandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generatePreSaleInvoicePDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generatePreSaleInvoicePDF(
      consignment,
      consignment.clients,
      auctionItems,
      sale_details,
      brand
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="presale-invoice-${consignment.id}-auction-${auctionId}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating auction-specific pre-sale invoice PDF:', error);
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error.message
    });
  }
});

// POST /consignments/:id/collection-receipt-pdf - Generate Collection Receipt PDF
router.post('/:id/collection-receipt-pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id: consignmentId } = req.params;
    const { collection_date, collected_by, released_by } = req.body;

    // Get consignment with client, specialist and returned items
    const { data: consignment, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        specialists:profiles!specialist_id(
          id,
          first_name,
          last_name
        ),
        items!left(*)
      `)
      .eq('id', parseInt(consignmentId))
      .single();

    if (consignmentError || !consignment) {
      return res.status(404).json({ error: 'Consignment not found' });
    }

    // Add specialist name to consignment object
    if (consignment.specialists && consignment.specialists.first_name) {
      (consignment as any).specialist_name = `${consignment.specialists.first_name} ${consignment.specialists.last_name || ''}`.trim();
    }

    // Filter items to only include returned items
    const returnedItems = consignment.items.filter((item: any) => item.status === 'passed');

    if (returnedItems.length === 0) {
      return res.status(400).json({ error: 'No returned items found for this consignment' });
    }

    // Get client's brand data
    const clientBrandId = consignment.clients.brand_id;
    let { data: brand, error: brandError } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', clientBrandId)
      .single();

    if (brandError || !brand) {
      console.error('Error fetching client brand:', brandError);
      // Fallback to default MSABER brand
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Import and use the PDF generator
    const { generateCollectionReceiptPDF } = await import('../utils/consignment-pdf-generator');

    const pdfBuffer = await generateCollectionReceiptPDF(
      consignment,
      consignment.clients,
      returnedItems,
      brand,
      collection_date,
      collected_by,
      released_by
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="collection-receipt-${consignment.id}.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating collection receipt PDF:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      details: error.message 
    });
  }
});

// POST /consignments/custom-report-pdf - Generate Custom Consignment Report PDF
router.post('/custom-report-pdf', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { consignments, template = 'summary', customization, userRole } = req.body;

    // Check if user has permission (super admin only for custom templates)
    if (template === 'custom' && userRole !== 'super_admin') {
      return res.status(403).json({
        error: 'Custom PDF templates are only available to super administrators'
      });
    }

    if (!consignments || !Array.isArray(consignments) || consignments.length === 0) {
      return res.status(400).json({ error: 'No consignments provided' });
    }

    // Get detailed consignment data from database
    const consignmentIds = consignments.map((c: any) => c.id).filter(Boolean);

    const { data: detailedConsignments, error: consignmentError } = await supabaseAdmin
      .from('consignments')
      .select(`
        *,
       clients!left(*),
        items(*)
      `)
      .in('id', consignmentIds);

    if (consignmentError) {
      console.error('Error fetching consignment details:', consignmentError);
      return res.status(500).json({
        error: 'Failed to fetch consignment details',
        details: consignmentError.message
      });
    }

    // Get first consignment's client brand (or fallback to MSABER)
    let brand;
    if (detailedConsignments && detailedConsignments.length > 0) {
      const firstConsignment = detailedConsignments[0];
      const clientBrandId = firstConsignment.clients?.brand_id;

      if (clientBrandId) {
        const { data: clientBrand, error: brandError } = await supabaseAdmin
          .from('brands')
          .select('*')
          .eq('id', clientBrandId)
          .single();

        if (clientBrand) {
          brand = clientBrand;
        }
      }
    }

    // Fallback to default MSABER brand if no client brand found
    if (!brand) {
      const { data: defaultBrand, error: defaultBrandError } = await supabaseAdmin
        .from('brands')
        .select('*')
        .eq('code', 'MSABER')
        .single();

      if (defaultBrandError || !defaultBrand) {
        return res.status(500).json({ error: 'Failed to fetch brand data' });
      }
      brand = defaultBrand;
    }

    // Default customization
    const defaultCustomization = {
      includeHeader: true,
      includeFooter: true,
      includeLogo: true,
      includeClientDetails: true,
      includeItemDetails: true,
      includeSpecialistInfo: true,
      includeSignatures: false,
      includeTermsConditions: true,
      headerText: 'Consignment Report',
      footerText: 'Confidential - For Internal Use Only',
      documentTitle: 'Consignment Summary',
      customNotes: '',
      fontSize: 'medium',
      orientation: 'portrait',
      paperSize: 'A4',
      margin: 'medium',
      branding: 'standard'
    };

    const finalCustomization = { ...defaultCustomization, ...customization };

    // Import and use the PDF generator
    const { generateCustomConsignmentReportPDF } = await import('../utils/consignment-pdf-generator');
    
    const pdfBuffer = await generateCustomConsignmentReportPDF(
      detailedConsignments,
      finalCustomization,
      brand,
      template
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="consignment-${template}-report.pdf"`);
    res.send(pdfBuffer);

  } catch (error: any) {
    console.error('Error generating custom consignment report PDF:', error);
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      details: error.message 
    });
  }
});

router.post('/sync-manager/start-polling', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { interval_minutes = 15 } = req.body;
    getGoogleSheetsSyncManager().startPolling(interval_minutes);

    res.json({
      success: true,
      message: `Polling sync started (checks every ${interval_minutes} minutes)`
    });

  } catch (error: any) {
    console.error('Error starting polling sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to start polling sync: ${error.message}`
    });
  }
});


// Enhanced Google Sheets Sync Manager
class GoogleSheetsSyncManager {
  private isPolling = false;
  private lastSyncTimestamps = new Map<string, Date>();
  private syncInProgress = new Set<string>();
  private cronJob: any = null;

  constructor() {
    this.initializeScheduledSync();
  }

  // Initialize scheduled sync jobs
  private initializeScheduledSync() {
    try {
      const cron = require('node-cron');

      // Run every 15 minutes as requested
      this.cronJob = cron.schedule('*/15 * * * *', async () => {
        console.log('⏰ SCHEDULED SYNC: Starting 15-minute interval sync');
        await this.performScheduledSync();
      }, {
        scheduled: false // Don't start automatically
      });

      console.log('✅ Cron job initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize cron job:', error);
      // Set to null so other methods can handle gracefully
      this.cronJob = null as any;
    }
  }

  // Start scheduled sync
  startScheduledSync() {
    if (this.cronJob) {
      this.cronJob.start();
      console.log('✅ SCHEDULED SYNC: Started 15-minute interval sync');
    } else {
      console.log('⚠️ SCHEDULED SYNC: Cron job not available');
    }
  }

  // Stop scheduled sync
  stopScheduledSync() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log('⏹️ SCHEDULED SYNC: Stopped 15-minute interval sync');
    } else {
      console.log('⚠️ SCHEDULED SYNC: Cron job not available');
    }
  }

  // Get sync status
  getSyncStatus() {
    return {
      pollingActive: this.isPolling,
      scheduledActive: this.cronJob ? !this.cronJob.destroyed : false,
      lastSyncTimestamps: Object.fromEntries(this.lastSyncTimestamps),
      syncInProgress: Array.from(this.syncInProgress),
      cronAvailable: !!this.cronJob
    };
  }

  // Perform scheduled sync
  private async performScheduledSync() {
    const configKey = 'google_sheet_url_consignments';
    try {
      if (this.syncInProgress.has(configKey)) {
        console.log('⚠️ SCHEDULED SYNC: Sync already in progress, skipping');
        return;
      }

      this.syncInProgress.add(configKey);
      console.log('🔄 SCHEDULED SYNC: Checking for Google Sheets changes');

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        console.log(`📊 SCHEDULED SYNC: Found ${changes.length} changes, processing...`);
        await this.processGoogleSheetsChanges(changes);
        this.lastSyncTimestamps.set(configKey, new Date());
      } else {
        console.log('📊 SCHEDULED SYNC: No changes detected');
      }
    } catch (error: any) {
      console.error('❌ SCHEDULED SYNC: Error during sync:', error);
    } finally {
      this.syncInProgress.delete(configKey);
    }
  }

  // Poll Google Sheets for changes
  private async pollGoogleSheetsForChanges(): Promise<any[] | null> {
    try {
      const { google } = require('googleapis');

      // Get Google Sheets URL from app settings
      const { data: settingData } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', 'google_sheet_url_consignments')
        .single();

      if (!settingData?.value) {
        console.log('❌ POLLING: No Google Sheets URL configured');
        return null;
      }

      // Extract URL
      let actualSheetUrl = '';
      if (typeof settingData.value === 'string') {
        try {
          const parsed = JSON.parse(settingData.value);
          actualSheetUrl = typeof parsed === 'object' && parsed !== null ? parsed.url : parsed;
        } catch {
          actualSheetUrl = settingData.value;
        }
      } else if (typeof settingData.value === 'object' && settingData.value !== null) {
        actualSheetUrl = settingData.value.url || '';
      }

      if (!actualSheetUrl) {
        console.log('❌ POLLING: Google Sheets URL is empty');
        return null;
      }

      // Extract spreadsheet ID
      const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!sheetIdMatch) {
        console.log('❌ POLLING: Invalid Google Sheets URL format');
        return null;
      }

      const spreadsheetId = sheetIdMatch[1];

      // Initialize Google Sheets API
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
          private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          client_id: process.env.GOOGLE_CLIENT_ID
        } as any,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Get the last modified timestamp from the last sync
      const lastSyncKey = `google_sheet_clients_last_modified`;
      const { data: lastModifiedData } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', lastSyncKey)
        .single();

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1',
      });

      const rows = response.data.values || [];
      if (rows.length < 2) {
        console.log('❌ POLLING: Sheet has no data rows');
        return null;
      }

      const headers = rows[0].map((h: any) => String(h).toLowerCase().trim());
      const dataRows = rows.slice(1);

      // Process rows and detect changes
      const changes: any[] = [];
      for (let i = 0; i < dataRows.length; i++) {
        const values = dataRows[i];
        if (!values || values.length === 0) continue;

        const obj: Record<string, any> = {};
        headers.forEach((header: string, index: number) => {
          obj[header] = values[index] || '';
        });

        changes.push({
          rowIndex: i + 2,
          record: obj,
          changeType: 'update', // just mark everything as "update"
        });
      }

      // Store the current timestamp as last sync time
      await supabaseAdmin
        .from('app_settings')
        .upsert({
          key: lastSyncKey,
          value: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      return changes;

    } catch (error) {
      console.error('❌ POLLING: Error polling Google Sheets:', error);
      return null;
    }
  }

  // Process Google Sheets changes
  private async processGoogleSheetsChanges(changes: any[]) {
    try {
      console.log(`🔄 PROCESSING: Processing ${changes.length} Google Sheets consignment changes`);

      for (const [index, change] of changes.entries()) {
        try {
          console.log(`\n📄 Processing row ${index + 1} from Google Sheets:`, change.record);

          // Transform the Google Sheets row into your DB format
          const transformedRecord = this.transformGoogleSheetsRecord(change.record);
          console.log('🔧 Transformed record for DB:', transformedRecord);

          // Find if consignment already exists
          const matchResult = await findMatchingConsignment(transformedRecord);
          console.log('🔍 Match result:', matchResult);

          if (matchResult.shouldUpdate && matchResult.consignmentId) {
            console.log(`🔄 POLLING: Updating existing consignment ID ${matchResult.consignmentId}`);

            const { data, error } = await supabaseAdmin
              .from('consignments')
              .update(transformedRecord)
              .eq('id', matchResult.consignmentId)
              .select()
              .single();

            if (error) {
              console.error(`❌ POLLING: Error updating consignment ${matchResult.consignmentId}:`, error);
            } else {
              console.log(`✅ POLLING: Successfully updated consignment ID ${matchResult.consignmentId}`, data);
            }
          } else {
            console.log(`➕ POLLING: Creating new consignment from Google Sheets`);

            const { data: newConsignment, error } = await supabaseAdmin
              .from('consignments')
              .insert([transformedRecord])
              .select()
              .single();

            if (error) {
              console.error('❌ POLLING: Error creating new consignment:', error);
            } else {
              console.log(`✅ POLLING: Successfully created new consignment ID ${newConsignment?.id}`, newConsignment);
            }
          }
        } catch (error: any) {
          console.error(`❌ POLLING: Error processing Google Sheets row ${index + 1}:`, error);
        }
      }

      console.log(`✅ POLLING: Completed processing ${changes.length} consignment changes`);
    } catch (error: any) {
      console.error('❌ POLLING: Error processing consignment changes:', error);
    }
  }
  
  private transformGoogleSheetsRecord(record: Record<string, any>): Record<string, any> {
    const transformed: any = {};
    
    // Normalize Google Sheet column names
    const sheet = Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/\s+/g, '_'), value])
    );

    // IDs
    if (sheet.id != null) transformed.id = parseInt(sheet.id);
    if (sheet.client_id != null) transformed.client_id = parseInt(sheet.client_id);
    if (sheet.specialist != null && sheet.specialist !== '') transformed.specialist_id = parseInt(sheet.specialist);
    if (sheet.valuation_day_id != null) transformed.valuation_day_id = parseInt(sheet.valuation_day_id);
    if (sheet.default_sale_id != null) transformed.default_sale_id = parseInt(sheet.default_sale_id);

    // Status / flags
    if (sheet.status) transformed.status = sheet.status;
    if (sheet.signed != null) transformed.is_signed = this.parseBoolean(sheet.signed);

    // Numbers
    if (sheet.items_count != null) transformed.items_count = parseInt(sheet.items_count);
    if (sheet.total_estimated_value != null) transformed.total_estimated_value = parseFloat(sheet.total_estimated_value);
    if (sheet.total_reserve_value != null) transformed.total_reserve_value = parseFloat(sheet.total_reserve_value);

    // Dates
    if (sheet.created_date) transformed.created_at = new Date(sheet.created_date).toISOString();
    if (sheet.updated_at) transformed.updated_at = new Date().toISOString(); // always update timestamp

    // Clean undefined
    Object.keys(transformed).forEach(key => {
      if (transformed[key] === undefined) delete transformed[key];
    });

    console.log('🔧 Transformed record for DB:', transformed);
    return transformed;
  }
  // Helper methods for data transformation
  private normalizeClientType(type: any): 'buyer' | 'vendor' | 'supplier' | 'buyer_vendor' {
    if (!type) return 'buyer';
    const normalized = String(type).toLowerCase();
    if (['buyer', 'vendor', 'supplier', 'buyer_vendor'].includes(normalized)) {
      return normalized as any;
    }
    return 'buyer';
  }

  private normalizePlatform(platform: any): string {
    if (!platform) return 'Private';
    const normalized = String(platform).toLowerCase();
    const platformMap: Record<string, string> = {
      'liveauctioneer': 'Liveauctioneer',
      'the saleroom': 'The saleroom',
      'invaluable': 'Invaluable',
      'easylive auctions': 'Easylive auctions',
      'private': 'Private',
      'others': 'Others'
    };
    return platformMap[normalized] || 'Private';
  }

  private parseBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    const str = String(value).toLowerCase();
    return str === 'true' || str === 'yes' || str === '1';
  }

  private parseFloat(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  private parseInt(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseInt(value);
    return isNaN(parsed) ? null : parsed;
  }

  // Manual trigger for sync
  async triggerManualSync(): Promise<{ success: boolean; message: string; changesProcessed?: number }> {
    try {
      console.log('🔄 MANUAL SYNC: Starting manual Google Sheets sync');

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        await this.processGoogleSheetsChanges(changes);
        console.log(`✅ MANUAL SYNC: Successfully processed ${changes.length} changes`);
        return {
          success: true,
          message: `Successfully synced ${changes.length} changes from Google Sheets`,
          changesProcessed: changes.length
        };
      } else {
        console.log('📊 MANUAL SYNC: No changes detected');
        return {
          success: true,
          message: 'No changes detected in Google Sheets'
        };
      }
    } catch (error) {
      console.error('❌ MANUAL SYNC: Error during manual sync:', error);
      return {
        success: false,
        message: `Manual sync failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // Start polling mode
  startPolling(intervalMinutes: number = 15) {
    if (this.isPolling) {
      console.log('⚠️ POLLING: Already polling, stopping first');
      this.stopPolling();
    }

    this.isPolling = true;
    console.log(`✅ POLLING: Started polling every ${intervalMinutes} minutes`);

    const poll = async () => {
      if (!this.isPolling) return;

      await this.performScheduledSync();

      // Schedule next poll
      setTimeout(poll, intervalMinutes * 60 * 1000);
    };

    // Start first poll immediately
    setTimeout(poll, 1000);
  }

  // Stop polling mode
  stopPolling() {
    this.isPolling = false;
    console.log('⏹️ POLLING: Stopped polling');
  }
}


let googleSheetsSyncManager: GoogleSheetsSyncManager | null = null;

function getGoogleSheetsSyncManager(): GoogleSheetsSyncManager {
  if (!googleSheetsSyncManager) {
    try {
      googleSheetsSyncManager = new GoogleSheetsSyncManager();
      console.log('✅ GoogleSheetsSyncManager initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize GoogleSheetsSyncManager:', error);
      // Return a mock instance that returns safe defaults
      const mockInstance = {
        getSyncStatus: () => ({
          pollingActive: false,
          scheduledActive: false,
          lastSyncTimestamps: {},
          syncInProgress: [],
          cronAvailable: false
        }),
        triggerManualSync: async () => ({
          success: false,
          message: 'Sync manager not available due to initialization error'
        }),
        startScheduledSync: () => console.log('Scheduled sync not available'),
        stopScheduledSync: () => console.log('Scheduled sync not available'),
        startPolling: () => console.log('Polling sync not available'),
        stopPolling: () => console.log('Polling sync not available')
      } as unknown as GoogleSheetsSyncManager;
      googleSheetsSyncManager = mockInstance;
    }
  }
  return googleSheetsSyncManager as GoogleSheetsSyncManager;
}

const findMatchingConsignment = async (record: any): Promise<{ shouldUpdate: boolean; consignmentId: number | null }> => {
  try {
    const originalCsvId = record.ID || record.id;
    if (originalCsvId && !isNaN(parseInt(originalCsvId)) && parseInt(originalCsvId) > 0) {
      const csvId = parseInt(originalCsvId);
      const { data: consignmentById } = await supabaseAdmin
        .from('consignments')
        .select('id')
        .eq('id', csvId)
        .maybeSingle();

      if (consignmentById?.id) {
        console.log(`✅ CSV ID ${csvId} matches existing consignment -> UPDATE`);
        return { shouldUpdate: true, consignmentId: consignmentById.id };
      } else {
        console.log(`❌ CSV ID ${csvId} not found -> CREATE new consignment`);
        return { shouldUpdate: false, consignmentId: null };
      }
    }
    if (record['Client ID']) {
      const clientId = parseInt(record['Client ID']);
      let query = supabaseAdmin
        .from('consignments')
        .select('id')
        .eq('client_id', clientId);
      if (record['Created Date']) {
        const createdDate = new Date(record['Created Date']).toISOString();
        query = query.eq('created_date', createdDate);
      }

      const { data: consignmentByClient } = await query.maybeSingle();
      if (consignmentByClient?.id) {
        console.log(`✅ Matched consignment by Client ID ${clientId}${record['Created Date'] ? ' + Created Date' : ''} -> UPDATE`);
        return { shouldUpdate: true, consignmentId: consignmentByClient.id };
      }
    }
    console.log(`❌ No matching consignment found for Client ID ${record['Client ID'] || 'Unknown'} -> CREATE new consignment`);
    return { shouldUpdate: false, consignmentId: null };
  } catch (error) {
    console.error('❌ Error finding matching consignment:', error);
    return { shouldUpdate: false, consignmentId: null };
  }
};

const sanitizePhoneNumber = (raw: any): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;

  try {
    const rawString = String(raw).trim();

    // Handle formats like: "92 (321)2119000", "1 (917)7210426", "1 2013883534", "1 (832) 438-4118"
    // First, clean the string by removing extra spaces, parentheses, dashes, etc.
    let cleaned = rawString
      .replace(/[()\-\s]/g, '') // Remove parentheses, dashes, and spaces
      .replace(/,/g, '') // Remove commas
      .replace(/\./g, ''); // Remove dots

    // If it's just digits, try to parse it
    if (/^\d+$/.test(cleaned)) {
      // First check for known country codes manually (libphonenumber-js may not recognize some)
      if (cleaned.startsWith('92') && cleaned.length === 12) {
        // Pakistan: 92 + 10 digits
        return `92 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('91') && cleaned.length === 12) {
        // India: 91 + 10 digits
        return `91 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('44') && cleaned.length >= 11) {
        // UK: 44 + remaining digits
        return `44 ${cleaned.substring(2)}`;
      }

      // Try to parse as international number using libphonenumber-js
      try {
        const phoneNumber = parsePhoneNumber(cleaned, 'US'); // Default to US, but it will detect country
        if (phoneNumber && phoneNumber.isValid()) {
          // Format as [Country code] [phone] like "92 3212119000" or "1 8324384118"
          const countryCode = phoneNumber.countryCallingCode;
          const nationalNumber = phoneNumber.nationalNumber;

          // Special handling for specific country codes to ensure proper formatting
          if (countryCode === '1' && nationalNumber.length === 10) {
            // US: 1 + 10 digits
            return `1 ${nationalNumber}`;
          } else {
            // Default formatting for other countries
            return `${countryCode} ${nationalNumber}`;
          }
        }
      } catch (parseError) {
        // If parsing fails, try to manually extract country code and number
      }

      // Manual parsing for cases where libphonenumber-js fails
      if (cleaned.length === 10) {
        // Default to US for 10-digit numbers with no country code
        return `1 ${cleaned}`;
      } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
        // US number: 1 + 10 digits
        return `1 ${cleaned.substring(1)}`;
      } else if (cleaned.length > 10) {
        // Try to extract country code, default to US if no match
        const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
        let foundCode = false;
        for (const code of possibleCountryCodes) {
          if (cleaned.startsWith(code)) {
            const remaining = cleaned.substring(code.length);
            if (remaining.length >= 7 && remaining.length <= 10) {
              return `${code} ${remaining}`;
            }
          }
        }
        // Default to US for unrecognized formats
        return `1 ${cleaned}`;
      }
    }

    // If all parsing fails, return the cleaned digits-only version with US default
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (digitsOnly.length === 10) {
      // Default to US for 10-digit numbers
      return `1 ${digitsOnly}`;
    } else if (digitsOnly.length > 10) {
      // Try to find a known country code, otherwise default to US
      const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
      for (const code of possibleCountryCodes) {
        if (digitsOnly.startsWith(code)) {
          const remaining = digitsOnly.substring(code.length);
          if (remaining.length >= 7 && remaining.length <= 10) {
            return `${code} ${remaining}`;
          }
        }
      }
      // Default to US if no known country code found
      return `1 ${digitsOnly}`;
    }
    return digitsOnly.length > 0 ? digitsOnly : null;
  } catch (error) {
    console.error('Error parsing phone number:', raw, error);
    // Fallback to basic digit extraction with US default
    const digits = String(raw).replace(/\D+/g, '');
    if (digits.length === 10) {
      return `1 ${digits}`;
    } else if (digits.length > 10) {
      // Try to find known country codes, default to US
      const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
      for (const code of possibleCountryCodes) {
        if (digits.startsWith(code)) {
          const remaining = digits.substring(code.length);
          if (remaining.length >= 7 && remaining.length <= 10) {
            return `${code} ${remaining}`;
          }
        }
      }
      return `1 ${digits}`;
    }
    return digits.length > 0 ? digits : null;
  }
};

// POST /clients/sync-manager/stop-polling - Stop polling sync
router.post('/sync-manager/stop-polling', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    getGoogleSheetsSyncManager().stopPolling();
    res.json({
      success: true,
      message: 'Polling sync stopped'
    });

  } catch (error: any) {
    console.error('Error stopping polling sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to stop polling sync: ${error.message}`
    });
  }
});


// GET /clients/sync-manager/status - Get sync status
router.get('/sync-manager/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const status = getGoogleSheetsSyncManager().getSyncStatus();
    res.json({
      success: true,
      status
    });

  } catch (error: any) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      message: `Failed to get sync status: ${error.message}`
    });
  }
});

// POST /clients/sync-manager/stop-scheduled - Stop scheduled sync
router.post('/sync-manager/stop-scheduled', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    getGoogleSheetsSyncManager().stopScheduledSync();
    res.json({
      success: true,
      message: 'Scheduled sync stopped'
    });

  } catch (error: any) {
    console.error('Error stopping scheduled sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to stop scheduled sync: ${error.message}`
    });
  }
});
router.post('/:id/sign', async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Received request:', req.body);
    const { id } = req.params;
    const { consignor_signature, received_by_signature } = req.body;
    
    const { error } = await supabaseAdmin
      .from('consignments')
      .update({ 
        consignor_signature, 
        received_by_signature 
      })
      .eq('id', id);
    
    if (error) throw error;
    
    console.log('Success!');
    
    // Make sure this line exists and sends response
    return res.status(200).json({ success: true, message: 'Signatures saved' });
    
  } catch (error: any) {
    console.error('API error:', error);
    return res.status(500).json({ error: error.message });
  }
});
export default router; 