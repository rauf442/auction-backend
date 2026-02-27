// backend/src/routes/auctions.ts
import express, { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import Papa from 'papaparse';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import { isMemberOfBrand } from '../utils/brand';
import { calculateBuyerOrVendorPremium, calculateBuyerPremium, calculateTotalAmount, determineInvoiceStatus } from '../utils/invoice-calculations';
import { prefillLogisticsData } from '../utils/logistics-helper';
import {
  PlatformId,
  generateCSVContent,
  createImagesZip,
  cleanupTempFiles,
  getItemImageUrls,
  IMAGE_NAMING_CONFIGS
} from '../utils/export-formats';
import { XMLParser } from 'fast-xml-parser';
import axios from 'axios';
// Extend Request interface to include user property
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Apply auth middleware to all routes
router.use(authMiddleware);

// Auction interface matching the database schema
interface Auction {
  id?: number;
  type: 'timed' | 'live' | 'sealed_bid';
  subtype?: 'actual' | 'post_sale_platform' | 'post_sale_private' | 'free_timed';
  short_name: string;
  long_name: string;
  target_reserve?: number;
  specialist_id?: number | null;
  charges?: any;
  description?: string;
  important_notice?: string;
  title_image_url?: string;
  catalogue_launch_date?: string;
  aftersale_deadline?: string;
  shipping_date?: string;
  settlement_date: string;
  auction_days: any[];
  sale_events?: any[];
  auctioneer_declaration?: string;
  bid_value_increments?: string;
  sorting_mode?: 'standard' | 'automatic' | 'manual';
  estimates_visibility?: 'use_global' | 'show_always' | 'do_not_show';
  time_zone?: string;
  platform?: string;
  upload_status?: string;

  // Platform URLs
  liveauctioneers_url?: string;
  easy_live_url?: string;
  invaluable_url?: string;
  the_saleroom_url?: string;

  total_estimate_low?: number;
  total_estimate_high?: number;
  total_sold_value?: number;
  sold_lots_count?: number;
  status?: 'planned' | 'in_progress' | 'ended' | 'aftersale' | 'archived';
  brand_id?: number;
  brand_code?: string; // For frontend compatibility
  artwork_ids?: number[]; // Array of artwork/item IDs
}

// GET /api/auctions - Get all auctions with optional filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      status,
      type,
      brand_id,
      search,
      page = 1,
      limit = 25,
      sort_field = 'id',
      sort_direction = 'asc'
    } = req.query;

    let query = supabaseAdmin
      .from('auctions')
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `);
    // Apply brand filtering
    if (brand_id) {
      query = query.eq('brand_id', brand_id);
    }

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (type && type !== 'all') {
      query = query.eq('type', type);
    }

    if (search) {
      query = query.or(
        `short_name.ilike.%${search}%,long_name.ilike.%${search}%,description.ilike.%${search}%`
      );
    }

    // Apply sorting with validation
    const validSortFields = ['id', 'short_name', 'long_name', 'status', 'type', 'settlement_date', 'created_at', 'updated_at'];
    const sortField = validSortFields.includes(sort_field as string) ? sort_field as string : 'id';

    query = query.order(sortField, {
      ascending: sort_direction === 'asc'
    });

    // Apply pagination
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    // Get total count first for pagination
    const { count: totalCount } = await supabaseAdmin
      .from('auctions')
      .select('*', { count: 'exact', head: true });

    query = query.range(offset, offset + limitNum - 1);

    const { data: auctions, error } = await query;

    if (error) {
      console.error('Error fetching auctions:', error);
      return res.status(500).json({
        error: 'Failed to fetch auctions',
        details: error.message
      });
    }

    const total = totalCount || 0;
    const totalPages = Math.ceil(total / limitNum);

    res.json({
      auctions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: totalPages
      }
    });
  } catch (error) {
    console.error('Error in GET /auctions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auctions/counts/status - Get auction status counts
router.get('/counts/status', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id } = req.query;

    // Get all auctions with necessary fields for status calculation
    let query = supabaseAdmin
      .from('auctions')
      .select('catalogue_launch_date, settlement_date');

    // Apply brand filtering
    if (brand_id) {
      query = query.eq('brand_id', brand_id);
    }

    const { data: auctions, error } = await query;

    if (error) {
      console.error('Error fetching auctions for status counts:', error);
      return res.status(500).json({
        error: 'Failed to fetch auctions for status counts',
        details: error.message
      });
    }

    // Calculate status counts
    const counts = {
      future: 0,
      present: 0,
      past: 0
    };

    const today = new Date();

    auctions?.forEach(auction => {
      const catalogueLaunchDate = auction.catalogue_launch_date ? new Date(auction.catalogue_launch_date) : null;
      const settlementDate = new Date(auction.settlement_date);

      if (today > settlementDate) {
        counts.past++;
      } else if (catalogueLaunchDate && today >= catalogueLaunchDate && today <= settlementDate) {
        counts.present++;
      } else {
        counts.future++;
      }
    });

    res.json({
      success: true,
      counts
    });
  } catch (error: any) {
    console.error('Error in GET /auctions/counts/status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auctions/counts/brands - Get auction counts for multiple brands
router.get('/counts/brands', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_ids } = req.query;

    if (!brand_ids) {
      return res.status(400).json({ error: 'brand_ids parameter is required' });
    }

    // Parse brand_ids (can be comma-separated string or array)
    let brandIdArray: number[];
    if (Array.isArray(brand_ids)) {
      brandIdArray = brand_ids.map(id => parseInt(String(id)));
    } else {
      brandIdArray = String(brand_ids).split(',').map(id => parseInt(id.trim()));
    }

    // Validate brand IDs
    const validBrandIds = brandIdArray.filter(id => !isNaN(id) && id > 0);

    if (validBrandIds.length === 0) {
      return res.status(400).json({ error: 'No valid brand IDs provided' });
    }

    const counts: { [brandId: number]: number } = {};

    // Get counts for each brand efficiently
    for (const brandId of validBrandIds) {
      try {
        const { count, error } = await supabaseAdmin
          .from('auctions')
          .select('*', { count: 'exact', head: true })
          .eq('brand_id', brandId);

        if (error) {
          console.error(`Error fetching auction count for brand ${brandId}:`, error);
          counts[brandId] = 0;
        } else {
          counts[brandId] = count || 0;
        }
      } catch (error) {
        console.error(`Error fetching auction count for brand ${brandId}:`, error);
        counts[brandId] = 0;
      }
    }

    res.json({
      success: true,
      counts
    });
  } catch (error: any) {
    console.error('Error in GET /auctions/counts/brands:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/auctions/unsold-counts - Get unsold item counts for auctions
router.get('/unsold-counts', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { auction_ids } = req.query;

    if (!auction_ids) {
      return res.status(400).json({ error: 'auction_ids parameter is required' });
    }

    let auctionIds: number[];
    if (typeof auction_ids === 'string') {
      auctionIds = auction_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    } else if (Array.isArray(auction_ids)) {
      auctionIds = auction_ids.map(id => parseInt(id.toString())).filter(id => !isNaN(id));
    } else {
      return res.status(400).json({ error: 'auction_ids must be a comma-separated string or array of numbers' });
    }

    if (auctionIds.length === 0) {
      return res.status(400).json({ error: 'No valid auction IDs provided' });
    }

    // Get auctions to collect all artwork IDs
    const { data: auctions, error: auctionsError } = await supabaseAdmin
      .from('auctions')
      .select('id, artwork_ids')
      .in('id', auctionIds);

    if (auctionsError || !auctions) {
      return res.status(500).json({ error: 'Failed to fetch auctions' });
    }

    // Collect all artwork IDs from all auctions
    const allArtworkIds = auctions.flatMap(auction => auction.artwork_ids || []);

    if (allArtworkIds.length === 0) {
      // Return zero counts for all auctions
      const counts = auctionIds.reduce((acc, auctionId) => {
        acc[auctionId] = 0;
        return acc;
      }, {} as Record<number, number>);
      return res.json({ success: true, counts, total: 0 });
    }

    // Get unsold items (items that are not sold or returned)
    const { data: unsoldItems, error: itemsError } = await supabaseAdmin
      .from('items')
  .select('id')
  .in('id', allArtworkIds)
  .not('status', 'in', '("sold","returned")');

    if (itemsError) {
      console.error('Error fetching unsold items:', itemsError);
      return res.status(500).json({ error: 'Failed to fetch unsold items' });
    }

    // Count unsold items per auction
    const counts: Record<number, number> = {};

    // Initialize all auctions with 0 count
    auctionIds.forEach(auctionId => {
      counts[auctionId] = 0;
    });

    // Count unsold items for each auction
    if (unsoldItems) {
      // Group unsold items by their auction_id
      const unsoldByAuction = unsoldItems.reduce((acc, item) => {
        // Find which auction this item belongs to
        const auction = auctions.find(a => (a.artwork_ids || []).includes(item.id));
        if (auction) {
          acc[auction.id] = (acc[auction.id] || 0) + 1;
        }
        return acc;
      }, {} as Record<number, number>);

      // Update counts
      Object.entries(unsoldByAuction).forEach(([auctionId, count]) => {
        counts[parseInt(auctionId)] = count;
      });
    }

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    res.json({
      success: true,
      counts,
      total
    });

  } catch (error) {
    console.error('Error in GET /auctions/unsold-counts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/auctions/:id - Get single auction
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: auction, error } = await supabaseAdmin
      .from('auctions')
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching auction:', error);
      return res.status(404).json({ error: 'Auction not found' });
    }

    res.json(auction);
  } catch (error) {
    console.error('Error in GET /auctions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions - Create new auction
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const auctionData: Auction = {
      ...req.body,
    };

    // Brand handling disabled for now

    // Validate required fields
    if (!auctionData.short_name || !auctionData.long_name || !auctionData.settlement_date) {
      return res.status(400).json({
        error: 'Missing required fields: short_name, long_name, settlement_date'
      });
    }

    // Convert empty strings to undefined for optional timestamp fields
    if (auctionData.catalogue_launch_date === '') {
      auctionData.catalogue_launch_date = undefined;
    }
    if (auctionData.aftersale_deadline === '') {
      auctionData.aftersale_deadline = undefined;
    }
    if (auctionData.shipping_date === '') {
      auctionData.shipping_date = undefined;
    }

    // Ensure auction_days is an array
    if (!auctionData.auction_days || !Array.isArray(auctionData.auction_days)) {
      auctionData.auction_days = [];
    }

    // Ensure artwork_ids is an array
    if (!auctionData.artwork_ids || !Array.isArray(auctionData.artwork_ids)) {
      auctionData.artwork_ids = [];
    }

    // Handle specialist_id - convert 0 or empty string to null
    if (auctionData.specialist_id === 0 || auctionData.specialist_id === null || auctionData.specialist_id === undefined) {
      auctionData.specialist_id = null;
    }

    console.log('Creating auction:', auctionData);

    const { data: auction, error } = await supabaseAdmin
      .from('auctions')
      .insert([auctionData])
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `)
      .single();

    if (error) {
      console.error('Error creating auction:', error);
      return res.status(500).json({
        error: 'Failed to create auction',
        details: error.message
      });
    }

    // Auto-sync to Google Sheets if configured
    if (auction?.id) {
      autoSyncAuctionToGoogleSheets(auction.id);
    }

    res.status(201).json({
      success: true,
      data: auction
    });
  } catch (error) {
    console.error('Error in POST /auctions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auctions/:id - Update auction
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    let auctionData: Partial<Auction> = { ...req.body };

    // Remove fields that shouldn't be updated
    delete auctionData.id;
    // Brand code handling disabled for now

    // Convert empty string -> null for timestamp fields
    const nullableTimestamps = [
      "catalogue_launch_date",
      "aftersale_deadline",
      "shipping_date"
    ];

    for (const field of nullableTimestamps) {
      if (auctionData[field as keyof Auction] === "") {
        auctionData[field as keyof Auction] = null as any;
      }
    }

    const { data: auction, error } = await supabaseAdmin
      .from('auctions')
      .update(auctionData)
      .eq('id', id)
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `)
      .single();

    if (error) {
      console.error('Error updating auction:', error);
      return res.status(500).json({
        error: 'Failed to update auction',
        details: error.message
      });
    }

    if (auction?.id) {
      autoSyncAuctionToGoogleSheets(auction.id);
    }

    res.json(auction);
  } catch (error) {
    console.error('Error in PUT /auctions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// DELETE /api/auctions/:id - Delete auction
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('auctions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting auction:', error);
      return res.status(500).json({
        error: 'Failed to delete auction',
        details: error.message
      });
    }

    res.json({ message: 'Auction deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /auctions/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions/bulk-action - Bulk operations
router.post('/bulk-action', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { auction_ids, action } = req.body;

    if (!auction_ids || !Array.isArray(auction_ids) || auction_ids.length === 0) {
      return res.status(400).json({ error: 'Invalid auction IDs provided' });
    }

    let result;
    switch (action) {
      case 'delete':
        result = await supabaseAdmin
          .from('auctions')
          .delete()
          .in('id', auction_ids);
        break;

      case 'archive':
        result = await supabaseAdmin
          .from('auctions')
          .update({ status: 'archived', })
          .in('id', auction_ids);
        break;

      case 'activate':
        result = await supabaseAdmin
          .from('auctions')
          .update({ status: 'planned', })
          .in('id', auction_ids);
        break;

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    if (result.error) {
      console.error('Error in bulk action:', result.error);
      return res.status(500).json({
        error: 'Failed to perform bulk action',
        details: result.error.message
      });
    }

    res.json({ message: `Bulk ${action} completed successfully` });
  } catch (error) {
    console.error('Error in POST /auctions/bulk-action:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auctions/:id/artworks - Get artworks for a specific auction
router.get('/:id/artworks', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: auctionId } = req.params;

    if (!auctionId) {
      return res.status(400).json({ error: 'Auction ID is required' });
    }

    // First get the auction with its artwork_ids
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, artwork_ids')
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    // Get artworks based on the artwork_ids array in the auction
    let artworks: any[] = [];
    let artworksError = null;

    if (auction.artwork_ids && Array.isArray(auction.artwork_ids) && auction.artwork_ids.length > 0) {
      const { data: fetchedArtworks, error: fetchError } = await supabaseAdmin
        .from('items')
        .select('*')
        .in('id', auction.artwork_ids)
        .order('id', { ascending: true });

      artworks = fetchedArtworks || [];
      artworksError = fetchError;
    }

    if (artworksError) {
      console.error('Error fetching auction artworks:', artworksError);
      return res.status(500).json({ error: 'Failed to fetch auction artworks' });
    }

    res.json({
      success: true,
      auction: auction,
      artworks: artworks || []
    });
  } catch (error) {
    console.error('Error in GET /auctions/:id/artworks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions/by-items - Return mapping of item_id -> auctions containing that item
router.post('/by-items', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }

    const { item_ids } = req.body as { item_ids?: (number | string)[] };
    if (!item_ids || !Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'item_ids array is required' });
    }

    // Normalize ids to numbers and dedupe
    const ids = Array.from(new Set(
      item_ids
        .map(v => parseInt(String(v), 10))
        .filter(v => !Number.isNaN(v) && v > 0)
    ));

    if (ids.length === 0) {
      return res.json({ success: true, mapping: {} });
    }

    // Fetch all auctions that include ANY of the provided item ids
    const { data: auctions, error } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, settlement_date, artwork_ids')
      .overlaps('artwork_ids', ids);

    if (error) {
      console.error('Error fetching auctions by items:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch auctions', details: error.message });
    }

    const mapping: Record<string, { id: number; short_name: string; long_name: string; settlement_date: string | null }[]> = {};

    (auctions || []).forEach(auction => {
      const a = auction as any;
      const artworkIds: number[] = Array.isArray(a.artwork_ids) ? a.artwork_ids : [];
      artworkIds.forEach((artId: number) => {
        if (!ids.includes(artId)) return;
        const key = String(artId);
        if (!mapping[key]) mapping[key] = [];
        mapping[key].push({
          id: a.id,
          short_name: a.short_name,
          long_name: a.long_name,
          settlement_date: a.settlement_date || null
        });
      });
    });

    // Optional: sort auctions per item by most recent settlement_date desc
    Object.values(mapping).forEach(arr => {
      arr.sort((x, y) => {
        const dx = x.settlement_date ? new Date(x.settlement_date).getTime() : 0;
        const dy = y.settlement_date ? new Date(y.settlement_date).getTime() : 0;
        return dy - dx;
      });
    });

    return res.json({ success: true, mapping });
  } catch (e: any) {
    console.error('Error in POST /auctions/by-items:', e);
    return res.status(500).json({ success: false, error: 'Internal server error', details: e.message });
  }
});

// GET /api/auctions/export/csv - Export auctions to CSV
router.get('/export/csv', async (req: AuthRequest, res: Response) => {
  try {
    const { status, type } = req.query;

    let query = supabaseAdmin
      .from('auctions')
      .select(`
        *,
        specialist_id(first_name, last_name, email)
      `);

    // Apply filters
    // Note: status filtering disabled until status column is added to database
    // if (status && status !== 'all') {
    //   query = query.eq('status', status);
    // }

    if (type && type !== 'all') {
      query = query.eq('type', type);
    }

    const { data: auctions, error } = await query;

    if (error) {
      console.error('Error fetching auctions for export:', error);
      return res.status(500).json({ error: 'Failed to fetch auctions for export' });
    }

    // CSV headers
    const headers = [
      'ID', 'Type', 'Short Name', 'Long Name', 'Target Reserve', 'Specialist',
      'Status', 'Inventory Numbers', 'Settlement Date', 'Created Date'
    ];

    // Convert auctions to CSV format with inventory numbers
    const csvData = auctions.map(auction => {
      // Use lots_count from auction instead of fetching items
      const inventoryNumbersStr = '[]'; // Temporarily empty until many-to-many relationship is implemented

      return [
        auction.id,
        auction.type,
        auction.short_name,
        auction.long_name,
        auction.target_reserve || 0,
        auction.specialist ? `${auction.specialist.first_name} ${auction.specialist.last_name}` : '',
        'N/A', // Status not available in database yet
        inventoryNumbersStr,
        auction.settlement_date,
        auction.created_at
      ];
    });

    // Create CSV content
    const csvContent = [headers, ...csvData]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=auctions.csv');
    res.send(csvContent);
  } catch (error) {
    console.error('Error in GET /auctions/export/csv:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auctions/:id/export/:platform - Export auction with items to platform-specific format
router.get('/:id/export/:platform', async (req: AuthRequest, res: Response) => {
  try {
    const { id, platform } = req.params;
    const { include_images = 'false', item_ids } = req.query;

    // Validate platform
    const validPlatforms: PlatformId[] = ['liveauctioneers', 'easy_live', 'invaluable', 'the_saleroom'];
    if (!validPlatforms.includes(platform as PlatformId)) {
      return res.status(400).json({
        error: `Invalid platform. Supported platforms: ${validPlatforms.join(', ')}`
      });
    }

    const platformId = platform as PlatformId;

    // Get auction with artworks
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, artwork_ids, settlement_date')
      .eq('id', id)
      .single();

    if (auctionError || !auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    // Get items/artworks for this auction
    let items: any[] = [];
    if (auction.artwork_ids && Array.isArray(auction.artwork_ids) && auction.artwork_ids.length > 0) {
      let query = supabaseAdmin
        .from('items')
        .select('*')
        .in('id', auction.artwork_ids)
        .order('id', { ascending: true });

      // If item_ids are specified, filter by them
      if (item_ids) {
        const requestedItemIds = String(item_ids).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (requestedItemIds.length > 0) {
          query = query.in('id', requestedItemIds);
        }
      }

      const { data: fetchedItems, error: itemsError } = await query;

      if (itemsError) {
        console.error('Error fetching items for export:', itemsError);
        return res.status(500).json({ error: 'Failed to fetch auction items' });
      }

      items = fetchedItems || [];
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'No items found in this auction' });
    }

    // Generate CSV content
    const csvContent = generateCSVContent(platformId, items);

    // Set CSV headers and send
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${auction.short_name}_${platform}_export.csv`);
    res.send(csvContent);

  } catch (error) {
    console.error('Error in GET /auctions/:id/export/:platform:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions/:id/export-images/:platform - Export auction images as ZIP
router.post('/:id/export-images/:platform', async (req: AuthRequest, res: Response) => {
  try {
    const { id, platform } = req.params;
    const { item_ids } = req.query;

    // Validate platform
    const validPlatforms: PlatformId[] = ['liveauctioneers', 'easy_live', 'invaluable', 'the_saleroom', 'database'];
    if (!validPlatforms.includes(platform as PlatformId)) {
      return res.status(400).json({
        error: `Invalid platform. Supported platforms: ${validPlatforms.join(', ')}`
      });
    }

    const platformId = platform as PlatformId;

    // Get auction with artworks
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, artwork_ids')
      .eq('id', id)
      .single();

    if (auctionError || !auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    // Get items/artworks for this auction
    let items: any[] = [];
    if (auction.artwork_ids && Array.isArray(auction.artwork_ids) && auction.artwork_ids.length > 0) {
      let query = supabaseAdmin
        .from('items')
        .select('*')
        .in('id', auction.artwork_ids)
        .order('id', { ascending: true });

      // If item_ids are specified, filter by them
      if (item_ids) {
        const requestedItemIds = String(item_ids).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (requestedItemIds.length > 0) {
          query = query.in('id', requestedItemIds);
        }
      }

      const { data: fetchedItems, error: itemsError } = await query;

      if (itemsError) {
        console.error('Error fetching items for image export:', itemsError);
        return res.status(500).json({ error: 'Failed to fetch auction items' });
      }

      items = fetchedItems || [];
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'No items found in this auction' });
    }

    // Check if any items have images
    const hasImages = items.some(item => getItemImageUrls(item).length > 0);
    if (!hasImages) {
      return res.status(400).json({ error: 'No images found for items in this auction' });
    }

    try {
      // Create images ZIP file
      const zipPath = await createImagesZip(platformId, items);

      // Send ZIP file
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${auction.short_name}_images_${platform}.zip`);

      const fs = require('fs');
      const fileStream = fs.createReadStream(zipPath);
      fileStream.pipe(res);

      // Clean up after sending
      fileStream.on('end', async () => {
        try {
          await cleanupTempFiles();
        } catch (cleanupError) {
          console.error('Error cleaning up temp files:', cleanupError);
        }
      });

    } catch (zipError) {
      console.error('Error creating ZIP file:', zipError);
      return res.status(500).json({ error: 'Failed to create images ZIP file' });
    }

  } catch (error) {
    console.error('Error in POST /auctions/:id/export-images/:platform:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions/upload/csv - Import auctions from CSV
router.post('/upload/csv', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { csv_data } = req.body;

    if (!csv_data || !Array.isArray(csv_data)) {
      return res.status(400).json({ error: 'Invalid CSV data provided' });
    }

    const upserts: any[] = [];
    const errors: string[] = [];

    for (let i = 0; i < csv_data.length; i++) {
      const row = csv_data[i];
      try {
        const record: any = {
          type: (row.type || 'timed') as Auction['type'],
          short_name: row.short_name,
          long_name: row.long_name,
          target_reserve: row.target_reserve ? parseFloat(String(row.target_reserve)) : null,
          settlement_date: row.settlement_date,
          description: row.description || '',
          auction_days: [],
          status: row.status || 'planned'
        };

        // Validate required fields
        if (!record.short_name || !record.long_name || !record.settlement_date) {
          errors.push(`Row ${i + 2}: Missing required fields (short_name, long_name, settlement_date)`);
          continue;
        }

        // Support id column for updates
        if (row.id) {
          const idNum = parseInt(String(row.id), 10);
          if (!Number.isNaN(idNum)) {
            record.id = idNum;
          }
        }

        upserts.push(record);
      } catch (e: any) {
        errors.push(`Row ${i + 2}: ${e.message || 'Error processing row'}`);
      }
    }

    let inserted = 0;
    let updated = 0;
    const batchSize = 100;

    for (let i = 0; i < upserts.length; i += batchSize) {
      const batch = upserts.slice(i, i + batchSize);
      const updates = batch.filter(r => r.id);
      const inserts = batch.filter(r => !r.id);

      // Handle updates with upsert
      if (updates.length > 0) {
        const { data, error } = await supabaseAdmin
          .from('auctions')
          .upsert(updates, { onConflict: 'id' })
          .select('id');
        if (error) {
          errors.push(`Update batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
        } else {
          updated += data?.length || 0;
        }
      }

      // Handle new inserts
      if (inserts.length > 0) {
        const { data, error } = await supabaseAdmin
          .from('auctions')
          .insert(inserts)
          .select('id');
        if (error) {
          errors.push(`Insert batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
        } else {
          inserted += data?.length || 0;
        }
      }
    }

    res.json({
      success: inserted + updated,
      failed: errors.length,
      inserted,
      updated,
      processed: upserts.length,
      errors: errors.slice(0, 100)
    });
  } catch (error) {
    console.error('Error in POST /auctions/upload/csv:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to write auction data to Google Sheets
async function writeAuctionsToGoogleSheets(sheetUrl: string | { url: string }, auctions: any[]): Promise<boolean> {
  try {
    const { google } = require('googleapis');

    // Handle both string and object formats for sheetUrl
    const actualSheetUrl = typeof sheetUrl === 'string' ? sheetUrl : sheetUrl.url;
    console.log('sheeturl', actualSheetUrl);

    // Extract sheet ID from URL
    const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      throw new Error('Invalid Google Sheets URL format');
    }

    const spreadsheetId = sheetIdMatch[1];

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

    // Prepare data for Google Sheets
    const headers = [
      'ID', 'Type', 'Short Name', 'Long Name', 'Target Reserve', 'Specialist',
      'Status', 'Settlement Date', 'Created Date', 'Lots Count', 'Total Estimate Low', 'Total Estimate High'
    ];

    const data = [
      headers,
      ...auctions.map(auction => [
        auction.id,
        auction.type,
        auction.short_name,
        auction.long_name,
        auction.target_reserve || 0,
        auction.specialist ? `${auction.specialist.first_name} ${auction.specialist.last_name}` : '',
        'N/A', // Status not available in database yet
        auction.settlement_date,
        auction.created_at,
        (auction.artwork_ids?.length || 0),
        auction.total_estimate_low || 0,
        auction.total_estimate_high || 0
      ])
    ];

    // Clear existing data first
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Sheet1',
    });

    // Write new data
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: data,
      },
    });

    console.log('Successfully wrote auctions to Google Sheets:', result.data.updatedCells);
    return true;

  } catch (error: any) {
    console.error('Error writing auctions to Google Sheets:', error.message);
    return false;
  }
}

// POST /api/auctions/sync-to-google-sheet - Sync auctions to Google Sheets
router.post('/sync-to-google-sheet', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sheet_url, auction_ids } = req.body;

    if (!sheet_url) {
      return res.status(400).json({ error: 'Google Sheets URL is required' });
    }

    // Get auctions data
    let query = supabaseAdmin
      .from('auctions')
      .select(`
        *,
        specialist_id(id, first_name, last_name, email)
      `);

    // Filter by specific auction IDs if provided
    if (auction_ids && Array.isArray(auction_ids) && auction_ids.length > 0) {
      query = query.in('id', auction_ids);
    }

    const { data: auctions, error } = await query;

    if (error) {
      console.error('Error fetching auctions for sync:', error);
      return res.status(500).json({ error: 'Failed to fetch auctions' });
    }

    // Write to Google Sheets
    const success = await writeAuctionsToGoogleSheets(sheet_url, auctions || []);

    if (success) {
      res.json({
        success: true,
        message: `Successfully synced ${(auctions || []).length} auctions to Google Sheets`,
        count: (auctions || []).length
      });
    } else {
      res.status(500).json({
        error: 'Failed to sync auctions to Google Sheets. Please check your Google Sheets configuration.'
      });
    }

  } catch (error: any) {
    console.error('Error in POST /auctions/sync-to-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/sync-google-sheet', async (req: AuthRequest, res: Response) => {
  try {
    console.log('🔔 /sync-google-sheet called');

    if (!req.user) {
      console.log('❌ User not authenticated');
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sheet_url } = req.body as { sheet_url?: string };
    if (!sheet_url) {
      console.log('❌ Missing sheet_url in request body');
      return res.status(400).json({ error: 'sheet_url is required' });
    }

    // Convert Google Sheet URL to CSV export URL
    const convertToGoogleSheetsCSVUrl = (url: string): string => {
      if (url.includes('/export?format=csv') || url.includes('&format=csv')) return url;
      const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      const sheetId = match?.[1];
      console.log(`🔍 Extracted sheetId: ${sheetId}`);
      return sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv` : url;
    };

    const csvUrl = convertToGoogleSheetsCSVUrl(sheet_url);
    console.log('🌐 CSV URL to fetch:', csvUrl);

    const response = await fetch(csvUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) {
      console.log(`❌ Failed to fetch sheet: ${response.status} ${response.statusText}`);
      return res.status(400).json({ error: `Failed to fetch sheet: ${response.statusText}` });
    }

    const csvText = await response.text();
    console.log('📄 CSV content length:', csvText.length);

    const parseResult = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transform: (value: string) => (typeof value === 'string' ? value.trim() : value),
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      console.log('❌ CSV parsing errors:', parseResult.errors);
      return res.status(400).json({
        error: 'CSV parsing failed',
        details: parseResult.errors.map((e: any) => e.message).join(', '),
      });
    }

    const rows: any[] = parseResult.data || [];
    console.log(`✅ Parsed ${rows.length} rows from CSV`);

    if (rows.length === 0) {
      return res.json({ success: true, upserted: 0, processed: 0, errors: [] });
    }

    const upserts: any[] = [];
    const errors: string[] = [];

    const normalizeKeys = (row: Record<string, any>) => {
      const normalized: Record<string, any> = {};
      Object.entries(row).forEach(([k, v]) => {
        const key = k.toLowerCase().trim().replace(/\s+/g, '_');
        normalized[key] = v;
      });
      return normalized;
    };

    // Prepare upserts with only the desired fields
    for (let i = 0; i < rows.length; i++) {
      try {
        const r = normalizeKeys(rows[i]);
        console.log(`📝 Processing row ${i + 2}:`, r);

        if (!r.id || isNaN(Number(r.id))) {
          const msg = `Row ${i + 2}: Missing or invalid id`;
          console.log('⚠️', msg);
          errors.push(msg);
          continue;
        }

        const record: any = { id: Number(r.id) };

        if (r.type && r.type.trim() !== '') record.type = r.type.trim();
        if (r.short_name && r.short_name.trim() !== '') record.short_name = r.short_name.trim();
        if (r.long_name && r.long_name.trim() !== '') record.long_name = r.long_name.trim();
        if (r.settlement_date && r.settlement_date.trim() !== '') {
          record.settlement_date = new Date(r.settlement_date).toISOString();
        }
        if (r.created_date && r.created_date.trim() !== '') {
          record.created_at = new Date(r.created_date).toISOString();
        }

        upserts.push(record);
      } catch (err: any) {
        const msg = `Row ${i + 2}: ${err.message || 'Error processing row'}`;
        console.log('❌', msg);
        errors.push(msg);
      }
    }

    console.log(`🚀 Prepared ${upserts.length} records for upsert`);
    console.log(`⚠️ Encountered ${errors.length} errors`);

    // Upsert in batches
    let upserted = 0;
    const batchSize = 100;

    for (let i = 0; i < upserts.length; i += batchSize) {
      const batch = upserts.slice(i, i + batchSize);
      const { data, error } = await supabaseAdmin
        .from('auctions')
        .upsert(batch, { onConflict: 'id' })
        .select('id');

      if (error) {
        console.log(`❌ Upsert batch ${Math.floor(i / batchSize) + 1} error:`, error.message);
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
      } else {
        upserted += data?.length || 0;
        console.log(`✅ Upserted ${data?.length || 0} records`);
      }
    }

    console.log('🎉 Sync completed:', { processed: upserts.length, upserted, errorsCount: errors.length });

    res.json({ success: true, processed: upserts.length, upserted, errors: errors.slice(0, 100) });
  } catch (error: any) {
    console.error('🔥 Error in POST /sync-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});


// Function to auto-sync auction to Google Sheets after create/update
async function autoSyncAuctionToGoogleSheets(auctionId: string) {
  try {
    // Get Google Sheets URL from app settings
    const { data: settingData } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'google_sheet_url_auctions')
      .single();

    if (!settingData?.value) {
      console.log('No Google Sheets URL configured for auctions auto-sync');
      return;
    }

    // Get the auction data
    const { data: auction, error } = await supabaseAdmin
      .from('auctions')
      .select(`
        *,
        specialist_id(id, first_name, last_name, email)
      `)
      .eq('id', auctionId)
      .single();

    if (error || !auction) {
      console.error('Error fetching auction for auto-sync:', error);
      return;
    }

    // Sync to Google Sheets
    const success = await writeAuctionsToGoogleSheets(settingData.value, [auction]);

    if (success) {
      console.log(`Auto-synced auction ${auctionId} to Google Sheets`);
    } else {
      console.error(`Failed to auto-sync auction ${auctionId} to Google Sheets`);
    }

  } catch (error) {
    console.error('Error in auto-sync auction to Google Sheets:', error);
  }
}

// POST /api/auctions/:id/assign-artworks - Assign artworks to auction
router.post('/:id/assign-artworks', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: auctionId } = req.params;
    const { artwork_ids } = req.body;

    if (!artwork_ids || !Array.isArray(artwork_ids)) {
      return res.status(400).json({ error: 'Artwork IDs array is required' });
    }

    // Verify auction exists and get current artwork_ids
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, artwork_ids')
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    // Merge new artwork_ids with existing ones, avoiding duplicates
    const currentArtworkIds = auction.artwork_ids || [];
    const newArtworkIds = [...new Set([...currentArtworkIds, ...artwork_ids])];

    // Update auction with the new artwork_ids array
    const { error: updateError } = await supabaseAdmin
      .from('auctions')
      .update({ artwork_ids: newArtworkIds })
      .eq('id', auctionId);

    if (updateError) {
      console.error('Error assigning artworks to auction:', updateError);
      return res.status(500).json({
        error: 'Failed to assign artworks to auction',
        details: updateError.message
      });
    }

    res.json({
      success: true,
      message: `Successfully assigned ${artwork_ids.length} artworks to auction`,
      auction_id: auctionId,
      artwork_count: newArtworkIds.length,
      newly_added: artwork_ids.length
    });

  } catch (error: any) {
    console.error('Error in POST /auctions/:id/assign-artworks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auctions/:id/remove-artworks - Remove artworks from auction
router.delete('/:id/remove-artworks', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: auctionId } = req.params;
    const { artwork_ids } = req.body;

    if (!artwork_ids || !Array.isArray(artwork_ids)) {
      return res.status(400).json({ error: 'Artwork IDs array is required' });
    }

    // Verify auction exists and get current artwork_ids
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, artwork_ids')
      .eq('id', auctionId)
      .single();

    if (auctionError || !auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    // Remove specified artwork_ids from the array
    const currentArtworkIds = auction.artwork_ids || [];
    const updatedArtworkIds = currentArtworkIds.filter((id: number) => !artwork_ids.includes(id));

    // Update auction with the filtered artwork_ids array
    const { error: updateError } = await supabaseAdmin
      .from('auctions')
      .update({ artwork_ids: updatedArtworkIds })
      .eq('id', auctionId);

    if (updateError) {
      console.error('Error removing artworks from auction:', updateError);
      return res.status(500).json({
        error: 'Failed to remove artworks from auction',
        details: updateError.message
      });
    }

    res.json({
      success: true,
      message: `Successfully removed ${artwork_ids.length} artworks from auction`,
      auction_id: auctionId,
      artwork_count: updatedArtworkIds.length,
      removed_count: artwork_ids.length
    });

  } catch (error: any) {
    console.error('Error in DELETE /auctions/:id/remove-artworks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Import EOA data
router.post('/import-eoa', upload.single('csv_file'), async (req: AuthRequest, res: Response) => {
  try {
    const { auction_id, platform, brand_id, import_type, sheets_url } = req.body

    if (!auction_id || !platform || !brand_id) {
      return res.status(400).json({ success: false, message: 'Missing required fields: auction_id, platform, brand_id' })
    }

    let csvData: any[] = []

    if (import_type === 'csv' && req.file) {
      // Parse CSV file using Papa Parse
      const csvText = fs.readFileSync(req.file.path, 'utf8');

      const parseResult = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false, // Keep as strings for now since we're doing custom parsing
        transform: (value: string) => (typeof value === 'string' ? value.trim() : value)
      });

      if (parseResult.errors && parseResult.errors.length > 0) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          success: false,
          message: 'CSV parsing failed',
          details: parseResult.errors.map((e: any) => e.message).join(', ')
        });
      }

      csvData = parseResult.data || [];

      // Clean up uploaded file
      fs.unlinkSync(req.file.path);

    } else if (import_type === 'sheets' && sheets_url) {
      // Implement Google Sheets import using Papa Parse
      try {
        // Convert Google Sheets URL to CSV export URL if needed
        const convertToGoogleSheetsCSVUrl = (url: string): string => {
          if (url.includes('/export?format=csv') || url.includes('&format=csv')) return url;
          const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
          const sheetId = match?.[1];
          return sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv` : url;
        };

        const csvUrl = convertToGoogleSheetsCSVUrl(sheets_url);

        const response = await fetch(csvUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0'
          }
        });

        if (!response.ok) {
          return res.status(400).json({
            success: false,
            message: `Failed to fetch sheet: ${response.statusText}`
          });
        }

        const csvText = await response.text();

        const parseResult = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: false,
          transform: (value: string) => (typeof value === 'string' ? value.trim() : value)
        });

        if (parseResult.errors && parseResult.errors.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'CSV parsing failed',
            details: parseResult.errors.map((e: any) => e.message).join(', ')
          });
        }

        csvData = parseResult.data || [];

      } catch (error: any) {
        return res.status(500).json({
          success: false,
          message: 'Failed to fetch Google Sheets data',
          error: error.message
        });
      }
    } else {
      return res.status(400).json({ success: false, message: 'Invalid import type or missing file/URL' })
    }

    if (csvData.length === 0) {
      return res.status(400).json({ success: false, message: 'No data found in the uploaded file' })
    }

    // Get auction data to access artwork_ids for lot number linking
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('artwork_ids')
      .eq('id', auction_id)
      .single()

    if (auctionError) {
      return res.status(404).json({ success: false, message: 'Auction not found' })
    }

    // Get all clients to match by name, email, or phone
    const { data: clients } = await supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name, email, phone_number, buyer_premium, vendor_premium, brand_id')

    // Helper function to find or create client
    const findOrCreateClient = async (rowData: any, brandId: number): Promise<number | null> => {
      const firstName = rowData['First Name']?.trim()
      const lastName = rowData['Last Name']?.trim()
      const email = rowData['Email']?.trim()
      const phone = rowData['Account phone']?.trim()

      if (!firstName || !lastName) {
        return null
      }

      // Try to find existing client by matching criteria
      let matchingClient = clients?.find(client => {
        const emailMatch = email && client.email?.toLowerCase() === email.toLowerCase()
        const phoneMatch = phone && client.phone_number && 
          client.phone_number.replace(/\D/g, '') === phone.replace(/\D/g, '')
        const nameMatch = 
          client.first_name?.toLowerCase() === firstName.toLowerCase() &&
          client.last_name?.toLowerCase() === lastName.toLowerCase()

        // Match if email OR phone OR (first name AND last name) match
        return emailMatch || phoneMatch || nameMatch
      })

      if (matchingClient) {
        console.log(`Found existing client: ${matchingClient.id} - ${matchingClient.first_name} ${matchingClient.last_name}`)
        return matchingClient.id
      }

      // Client doesn't exist, create new one
      console.log(`Creating new client: ${firstName} ${lastName} (${email})`)
      
      const formatPhoneNumber = (phone: string): string => {
        if (!phone) return ''
        const num = parseFloat(phone)
        if (!isNaN(num)) return num.toString()
        return phone
      }

      const newClientData = {
        first_name: firstName,
        last_name: lastName,
        email: email || undefined,
        phone_number: formatPhoneNumber(phone) || undefined,
        brand_id: brandId,
        client_type: 'buyer',
        billing_address1: rowData['Address']?.trim() || undefined,
        billing_city: rowData['City']?.trim() || undefined,
        billing_country: rowData['Country']?.trim() || undefined,
        billing_post_code: rowData['Postal Code']?.trim() || undefined
      }

      try {
        const { data: newClient, error: createError } = await supabaseAdmin
          .from('clients')
          .insert([newClientData])
          .select('id, first_name, last_name, email, phone_number, buyer_premium, vendor_premium, brand_id')
          .single()

        if (createError) {
          console.error('Error creating client:', createError)
          return null
        }

        // Add to clients array for future lookups
        if (newClient && clients) {
          clients.push(newClient)
        }

        console.log(`Created new client: ${newClient.id}`)
        return newClient.id
      } catch (error) {
        console.error('Failed to create client:', error)
        return null
      }
    }

    // Group CSV data by buyer for buyer invoices
    const buyerGroups = new Map<string, any[]>()

    csvData.forEach((row) => {
      const firstName = row['First Name']?.trim()
      const lastName = row['Last Name']?.trim()
      const email = row['Email']?.trim()

      // Create a unique key for each buyer
      const buyerKey = `${firstName}-${lastName}-${email}`.toLowerCase()

      if (!buyerGroups.has(buyerKey)) {
        buyerGroups.set(buyerKey, [])
      }
      buyerGroups.get(buyerKey)!.push(row)
    })

    // Group CSV data by vendor_id derived from item_ids for vendor invoices
    const vendorGroups = new Map<number, any[]>()

    // First, collect all item_ids from the CSV data
    const allItemIds: number[] = []
    csvData.forEach((row) => {
      const lotNumber = row['Lot Number']
      if (lotNumber && auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
        const lotIndex = parseInt(lotNumber) - 1 // Lot number is 1-based, array is 0-based
        if (lotIndex >= 0 && lotIndex < auction.artwork_ids.length) {
          const itemId = auction.artwork_ids[lotIndex]
          if (!allItemIds.includes(itemId)) {
            allItemIds.push(itemId)
          }
        }
      }
    })

    // Get all items to find vendor information
    let itemsMap = new Map<number, any>()
    if (allItemIds.length > 0) {
      const { data: itemsData } = await supabaseAdmin
        .from('items')
        .select('id, vendor_id, title, description, artist_maker')
        .in('id', allItemIds)

      if (itemsData) {
        itemsData.forEach(item => {
          itemsMap.set(item.id, item)
        })
      }
    }

    // Now group by vendor_id from the items
    csvData.forEach((row) => {
      const lotNumber = row['Lot Number']
      if (lotNumber && auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
        const lotIndex = parseInt(lotNumber) - 1
        if (lotIndex >= 0 && lotIndex < auction.artwork_ids.length) {
          const itemId = auction.artwork_ids[lotIndex]
          const item = itemsMap.get(itemId)

          if (item?.vendor_id) {
            if (!vendorGroups.has(item.vendor_id)) {
              vendorGroups.set(item.vendor_id, [])
            }
            vendorGroups.get(item.vendor_id)!.push(row)
          }
        }
      }
    })

    // Transform grouped data into invoices
    const invoices: any[] = []

    // Create buyer invoices with auto client creation
    for (const [buyerKey, rows] of buyerGroups.entries()) {
      const firstRow = rows[0] // Use first row for buyer info

      // Find or create client
      const client_id = await findOrCreateClient(firstRow, Number(brand_id))
      
      // Get client data for premium rate
      const matchingClient = clients?.find(c => c.id === client_id)

      // Process all lots for this buyer
      const item_ids: number[] = []
      const lot_ids: string[] = []
      const sale_prices: number[] = []
      const buyer_premium_prices: number[] = []

      // Get buyer premium rate from client, default to 0 if not found
      const buyerPremiumRate = matchingClient?.buyer_premium || 0

      rows.forEach((row) => {
        // Collect lot information
        lot_ids.push(row['Lot Number'])

        // Link lot number to item_id using auction.artwork_ids
        const lotNumber = row['Lot Number']
        if (lotNumber && auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
          const lotIndex = parseInt(lotNumber) - 1 // Lot number is 1-based, array is 0-based
          if (lotIndex >= 0 && lotIndex < auction.artwork_ids.length) {
            item_ids.push(auction.artwork_ids[lotIndex])
          }
        }

        // Collect individual prices for arrays
        const salePrice = parseCurrencyString(row['Sale Price'])
        // Calculate buyer premium from sale price and client's buyer_premium rate
        const buyerPremium = salePrice * (buyerPremiumRate / 100)
        sale_prices.push(salePrice)
        buyer_premium_prices.push(buyerPremium)
      })

      // Format phone numbers properly (remove scientific notation)
      const formatPhoneNumber = (phone: string): string => {
        if (!phone) return ''
        // Convert scientific notation back to full number
        const num = parseFloat(phone)
        if (!isNaN(num)) {
          return num.toString()
        }
        return phone
      }



      // Pre-fill logistics data
      const logisticsData = await prefillLogisticsData(
        item_ids,
        lot_ids,
        {
          country: firstRow['Country'],
          postal_code: firstRow['Postal Code']
        }
      )

      // Create buyer invoice
      const buyerInvoice = {
        auction_id: Number(auction_id),
        brand_id: Number(brand_id),
        platform,
        lot_ids, // Array of lot numbers
        item_ids, // Array of linked item IDs
        sale_prices, // Array of individual sale prices
        buyer_premium_prices, // Array of individual buyer premium prices (calculated from client rate)
        buyer_first_name: firstRow['First Name'],
        buyer_last_name: firstRow['Last Name'],
        buyer_username: firstRow['Username'],
        buyer_email: firstRow['Email'],
        buyer_phone: formatPhoneNumber(firstRow['Account phone']),
        shipping_method: firstRow['Shipping Method'],
        shipping_status: firstRow['Shipping Status'],
        ship_to_phone: formatPhoneNumber(firstRow['Ship to, Phone']),
        ship_to_first_name: firstRow['Ship to, Name'],
        ship_to_last_name: firstRow['Ship to, Surname'],
        ship_to_company: firstRow['Company'],
        ship_to_address: firstRow['Address'],
        ship_to_city: firstRow['City'],
        ship_to_state: firstRow['State'],
        ship_to_country: firstRow['Country'],
        ship_to_postal_code: firstRow['Postal Code'],
        paddle_number: firstRow['Paddle Number'],
        premium_bidder: firstRow['Premium Bidder']?.toLowerCase() === 'yes',
        status: (firstRow['Paid']?.toLowerCase() === 'yes' || firstRow['Paid']?.toLowerCase() === 'true') ? 'paid' : 'unpaid',
        eoa_import_date: new Date().toISOString(),
        client_id, // Linked client ID
        type: 'buyer', // EOA imports are always buyer type
        paid_amount: 0, // Initialize paid amount to 0
        invoice_number: `INV-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // Temporary, will be updated after insert
        // Logistics fields
        l_method: logisticsData.l_method,
        l_status: logisticsData.l_status,
        l_postal_code: logisticsData.l_postal_code,
        l_destination: logisticsData.l_destination,
        l_country: logisticsData.l_country,
        items_info: logisticsData.items_info
      }

      // Add buyer invoice to the list
      invoices.push(buyerInvoice)
    }

    // Helper function to check and create auctions if needed
    const ensureauctionsForVendor = async (vendorId: number, itemIds: number[]): Promise<number | null> => {
      // Check if any of the items already have a auctions
      const { data: existingauctions } = await supabaseAdmin
        .from('auctions')
        .select('id, item_ids')
        .eq('client_id', vendorId)
        .contains('item_ids', itemIds)
        .single()

      if (existingauctions) {
        console.log(`auctions already exists for vendor ${vendorId}:`, existingauctions.id)
        return existingauctions.id
      }

      // No auctions exists, create new one
      console.log(`Creating new auctions for vendor ${vendorId} with items:`, itemIds)
      
      try {
        const { data: newauctions, error: auctionsError } = await supabaseAdmin
          .from('auctions')
          .insert([{
            client_id: vendorId,
            status: 'active',
            created_at: new Date().toISOString()
          }])
          .select('id')
          .single()

        if (auctionsError) {
          console.error('Error creating auctions:', auctionsError)
          return null
        }

        console.log(`Created auctions: ${newauctions.id}`)

        // Link items to the new auctions
        const { error: updateError } = await supabaseAdmin
          .from('items')
          .update({ auctions_id: newauctions.id })
          .in('id', itemIds)

        if (updateError) {
          console.error('Error linking items to auctions:', updateError)
          // Don't return null here as the auctions was created successfully
        }

        return newauctions.id
      } catch (error) {
        console.error('Failed to create auctions:', error)
        return null
      }
    }

    // Create vendor invoices grouped by vendor_id from items
    for (const [vendorId, rows] of vendorGroups.entries()) {
      // Get vendor details from clients table
      const vendor = clients?.find(c => c.id === vendorId)
      if (!vendor) continue

      // Process all lots for this vendor
      const item_ids: number[] = []
      const lot_ids: string[] = []
      const sale_prices: number[] = []
      const buyer_premium_prices: number[] = []

      // Get vendor premium rate from client, default to 0 if not found
      const vendorPremiumRate = vendor?.vendor_premium || 0

      rows.forEach((row) => {
        // Collect lot information
        lot_ids.push(row['Lot Number'])

        // Link lot number to item_id using auction.artwork_ids
        const lotNumber = row['Lot Number']
        if (lotNumber && auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
          const lotIndex = parseInt(lotNumber) - 1 // Lot number is 1-based, array is 0-based
          if (lotIndex >= 0 && lotIndex < auction.artwork_ids.length) {
            item_ids.push(auction.artwork_ids[lotIndex])
          }
        }

        // Collect individual sale prices for arrays
        const salePrice = parseCurrencyString(row['Sale Price'])
        // Calculate vendor premium from sale price and client's vendor_premium rate
        const vendorPremium = salePrice * (vendorPremiumRate / 100)
        sale_prices.push(salePrice)
        buyer_premium_prices.push(vendorPremium) // Store vendor premium in buyer_premium_prices array
      })

      // Ensure auctions exists for these items
      if (item_ids.length > 0) {
        await ensureauctionsForVendor(vendorId, item_ids)
      }

      // Format phone numbers properly (remove scientific notation)
      const formatPhoneNumber = (phone: string): string => {
        if (!phone) return ''
        // Convert scientific notation back to full number
        const num = parseFloat(phone)
        if (!isNaN(num)) {
          return num.toString()
        }
        return phone
      }

      const firstRow = rows[0] // Use first row for any additional info needed

      // Create vendor invoice using vendor client data
      const vendorInvoice = {
        auction_id: Number(auction_id),
        brand_id: Number(brand_id),
        platform,
        lot_ids, // Array of lot numbers
        item_ids, // Array of linked item IDs
        sale_prices, // Array of individual sale prices
        buyer_premium_prices, // Array of vendor premium prices (calculated from client rate)
        buyer_first_name: vendor.first_name || '', // Vendor's first name
        buyer_last_name: vendor.last_name || '', // Vendor's last name
        buyer_username: '', // Not relevant for vendor invoices
        buyer_email: vendor.email || '', // Vendor's email
        buyer_phone: vendor.phone_number || '', // Vendor's phone
        shipping_method: '', // Not relevant for vendor invoices
        shipping_status: '', // Not relevant for vendor invoices
        ship_to_phone: '', // Not relevant for vendor invoices
        ship_to_first_name: '', // Not relevant for vendor invoices
        ship_to_last_name: '', // Not relevant for vendor invoices
        ship_to_company: '', // Not relevant for vendor invoices
        ship_to_address: '', // Not relevant for vendor invoices
        ship_to_city: '', // Not relevant for vendor invoices
        ship_to_state: '', // Not relevant for vendor invoices
        ship_to_country: '', // Not relevant for vendor invoices
        ship_to_postal_code: '', // Not relevant for vendor invoices
        paddle_number: '', // Not relevant for vendor invoices
        premium_bidder: false, // Not relevant for vendor invoices
        status: 'unpaid', // Vendor invoices start as unpaid
        eoa_import_date: new Date().toISOString(),
        client_id: vendorId, // Linked vendor client ID
        type: 'vendor', // Vendor type invoice
        paid_amount: 0, // Initialize paid amount to 0
        invoice_number: `CN-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // Temporary, will be updated after insert
      }

      // Add vendor invoice to the list
      invoices.push(vendorInvoice)
    }

    // Check for existing invoices for this auction and update/insert accordingly
    let insertedInvoices: any[] = []
    let updatedCount = 0
    let insertedCount = 0

    for (const invoice of invoices) {
      console.log(invoice)
      let existingInvoice = null

      if (invoice.type === 'vendor' && invoice.client_id) {
        // For vendor invoices, check by auction_id, client_id, and type
        const { data: existing } = await supabaseAdmin
          .from('invoices')
          .select('id')
          .eq('auction_id', invoice.auction_id)
          .eq('client_id', invoice.client_id)
          .eq('type', 'vendor')
          .single()
        existingInvoice = existing
      } else if (invoice.type === 'buyer') {
        // For buyer invoices, check by auction_id, buyer_email, and type
        const { data: existing } = await supabaseAdmin
          .from('invoices')
          .select('id')
          .eq('auction_id', invoice.auction_id)
          .eq('buyer_email', invoice.buyer_email)
          .eq('type', 'buyer')
          .single()
        existingInvoice = existing
      }

      if (existingInvoice) {
        // Update existing invoice
        const { data: updatedInvoice, error: updateError } = await supabaseAdmin
          .from('invoices')
          .update(invoice)
          .eq('id', existingInvoice.id)
          .select()
          .single()

        if (updateError) {
          console.error('Error updating invoice:', updateError)
          continue
        }

        // Update invoice_number with proper format using the invoice ID
        // Update invoice_number with brand-specific format (only if not already set correctly)
        if (!updatedInvoice.invoice_number || updatedInvoice.invoice_number.startsWith('temp')) {
          // Get brand code for invoice numbering
          const { data: brand } = await supabaseAdmin
            .from('brands')
            .select('code')
            .eq('id', brand_id)
            .single()

          const brandCode = brand?.code?.toUpperCase() || 'UNKNOWN'
          const prefix = invoice.type === 'vendor' ? 'CN' : 'INV'

          // Get the count of existing invoices for this brand and type to generate sequential number
          const { count } = await supabaseAdmin
            .from('invoices')
            .select('*', { count: 'exact', head: true })
            .eq('brand_id', brand_id)
            .eq('type', invoice.type)

          const sequentialNumber = (count || 0) + 1
          const finalInvoiceNumber = `${brandCode}-${prefix}-${sequentialNumber}`

          const { error: updateInvoiceNumberError } = await supabaseAdmin
            .from('invoices')
            .update({ invoice_number: finalInvoiceNumber })
            .eq('id', updatedInvoice.id)

          if (updateInvoiceNumberError) {
            console.error('Error updating invoice number:', updateInvoiceNumberError)
          } else {
            updatedInvoice.invoice_number = finalInvoiceNumber
          }
        }

        insertedInvoices.push(updatedInvoice)
        updatedCount++
      } else {
        // Insert new invoice
        const { data: newInvoice, error: insertError } = await supabaseAdmin
          .from('invoices')
          .insert([invoice])
          .select()
          .single()

        if (insertError) {
          console.error('Error inserting invoice:', insertError)
          continue
        }

        // Update invoice_number with brand-specific format
        // Get brand code for invoice numbering
        const { data: brand } = await supabaseAdmin
          .from('brands')
          .select('code')
          .eq('id', brand_id)
          .single()

        // first 3 digits of the brand code
        const brandCode = brand?.code?.toUpperCase().substring(0, 3) || ''
        const prefix = invoice.type === 'vendor' ? 'CN' : 'INV'

        // Get the count of existing invoices for this brand and type to generate sequential number
        const { count } = await supabaseAdmin
          .from('invoices')
          .select('*', { count: 'exact', head: true })
          .eq('brand_id', brand_id)
          .eq('type', invoice.type)

        const sequentialNumber = (count || 0) + 1
        const finalInvoiceNumber = `${brandCode}-${prefix}-${sequentialNumber}`

        const { error: updateInvoiceNumberError } = await supabaseAdmin
          .from('invoices')
          .update({ invoice_number: finalInvoiceNumber })
          .eq('id', newInvoice.id)

        if (updateInvoiceNumberError) {
          console.error('Error updating invoice number:', updateInvoiceNumberError)
        } else {
          newInvoice.invoice_number = finalInvoiceNumber
        }

        insertedInvoices.push(newInvoice)
        insertedCount++
      }
    }

    // Count buyer and vendor invoices separately for better reporting
    const buyerInvoices = insertedInvoices.filter(inv => inv.type === 'buyer')
    const vendorInvoices = insertedInvoices.filter(inv => inv.type === 'vendor')

    // Update item statuses and sale prices for all sold items from CSV data
    let soldItemsCount = 0
    let passedItemsCount = 0
    try {
      // Collect all items with sale prices from the CSV data
      const itemsToUpdate: { id: number; sale_price: number }[] = []

      csvData.forEach((row) => {
        const lotNumber = row['Lot Number']
        const salePrice = parseCurrencyString(row['Sale Price'])

        // Only update items that have a valid sale price
        if (lotNumber && salePrice > 0 && auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
          const lotIndex = parseInt(lotNumber) - 1 // Lot number is 1-based, array is 0-based
          if (lotIndex >= 0 && lotIndex < auction.artwork_ids.length) {
            const itemId = auction.artwork_ids[lotIndex]
            itemsToUpdate.push({
              id: itemId,
              sale_price: salePrice
            })
          }
        }
      })

      // Remove duplicates (in case same lot appears multiple times)
      const uniqueItemsToUpdate = itemsToUpdate.filter((item, index, self) =>
        index === self.findIndex(i => i.id === item.id)
      )

      if (uniqueItemsToUpdate.length > 0) {
        // Update item statuses to 'sold', set sale_price, and associate with brand for all sold items
        for (const item of uniqueItemsToUpdate) {
          const { error: updateItemError } = await supabaseAdmin
            .from('items')
            .update({
              status: 'sold',
              sale_price: item.sale_price,
              brand_id: Number(brand_id)
            })
            .eq('id', item.id)

          if (updateItemError) {
            console.error(`Error updating item ${item.id}:`, updateItemError)
          } else {
            soldItemsCount++
          }
        }

        console.log(`Updated ${soldItemsCount} items to 'sold' status with sale prices`)
      }

      // Update unsold items to 'passed' status and associate with brand
      if (auction?.artwork_ids && Array.isArray(auction.artwork_ids)) {
        // Get all item IDs that were sold
        const soldItemIds = uniqueItemsToUpdate.map(item => item.id)

        // Find item IDs that are in the auction but not sold
        const unsoldItemIds = auction.artwork_ids.filter(itemId => !soldItemIds.includes(itemId))

        if (unsoldItemIds.length > 0) {
          for (const itemId of unsoldItemIds) {
            const { error: updateUnsoldItemError } = await supabaseAdmin
              .from('items')
              .update({
                status: 'passed',
                brand_id: Number(brand_id)
              })
              .eq('id', itemId)

            if (updateUnsoldItemError) {
              console.error(`Error updating unsold item ${itemId} to 'passed':`, updateUnsoldItemError)
            } else {
              passedItemsCount++
            }
          }

          console.log(`Updated ${passedItemsCount} items to 'passed' status`)
        }
      }
    } catch (error: any) {
      console.error('Error updating item statuses and sale prices:', error)
      // Don't fail the entire import, just log the error
    }

    res.json({
      success: true,
      message: `EOA data imported successfully. ${insertedCount} new, ${updatedCount} updated. (${buyerInvoices.length} buyer, ${vendorInvoices.length} vendor invoices). ${soldItemsCount} items marked as sold, ${passedItemsCount} items marked as passed.`,
      data: {
        imported_count: insertedInvoices.length,
        inserted_count: insertedCount,
        updated_count: updatedCount,
        buyer_invoices_count: buyerInvoices.length,
        vendor_invoices_count: vendorInvoices.length,
        sold_items_count: soldItemsCount,
        passed_items_count: passedItemsCount,
        invoices: insertedInvoices
      }
    })
  } catch (error: any) {
    console.error('Error in POST /auctions/import-eoa:', error)
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message })
  }
})

// Get invoices by auction ID
router.get('/:auctionId/invoices', async (req: AuthRequest, res: Response) => {
  try {
    const { auctionId } = req.params
    const { page = 1, limit = 50, type, brand_id } = req.query

    const offset = (Number(page) - 1) * Number(limit)

    let query = supabaseAdmin
      .from('invoices')
      .select(`
        *,
        client:clients(id, first_name, last_name, company_name, email, phone_number),
        auction:auctions(id, short_name, long_name, settlement_date),
        brand:brands(id, name, code, brand_address, contact_email, contact_phone, business_whatsapp_number, bank_accounts, logo_url, company_registration, vat_number, eori_number, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions)
      `, { count: 'exact' })
      .eq('auction_id', auctionId)

    // Apply type filter if provided
    if (type && type !== 'all') {
      query = query.eq('type', type)
    }

    // Apply brand filter if provided
    if (brand_id && brand_id !== 'all') {
      query = query.eq('brand_id', brand_id)
    }

    const { data: invoices, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (error) {
      console.error('Error fetching invoices:', error)
      return res.status(500).json({ success: false, message: 'Failed to fetch invoices', error: error.message })
    }

    const invoicesWithCalculations = (invoices || []).map(invoice => {
      invoice.buyers_premium = calculateBuyerOrVendorPremium(invoice, invoice.brand)
      invoice.total_amount = calculateTotalAmount(invoice, 'final', invoice.brand)

      return invoice
    })

    res.json({
      success: true,
      message: 'Invoices fetched successfully',
      data: {
        invoices: invoicesWithCalculations || [],
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: count || 0,
          pages: Math.ceil((count || 0) / Number(limit))
        }
      }
    })
  } catch (error: any) {
    console.error('Error in GET /auctions/:auctionId/invoices:', error)
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message })
  }
})

// Helper function to parse currency strings like "£3,000.00" to numbers
function parseCurrencyString(value: string): number {
  if (!value || typeof value !== 'string') return 0

  // Remove currency symbols and commas, then parse
  const cleaned = value.replace(/[£$€,]/g, '')
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? 0 : parsed
}

// POST /api/auctions/:id/generate-passed - Generate passed auction with unsold items
router.post('/:id/generate-passed', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { subtype, short_name, long_name } = req.body;

    // Validate subtype
    const validSubtypes = ['actual', 'post_sale_platform', 'post_sale_private', 'free_timed'];
    if (!subtype || !validSubtypes.includes(subtype)) {
      return res.status(400).json({
        error: 'Invalid subtype. Must be one of: ' + validSubtypes.join(', ')
      });
    }

    // Get the original auction
    const { data: originalAuction, error: fetchError } = await supabaseAdmin
      .from('auctions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !originalAuction) {
      return res.status(404).json({ error: 'Original auction not found' });
    }

    // Get unsold items (items that are not sold or returned)
    const { data: unsoldItems, error: itemsError } = await supabaseAdmin
      .from('items')
      .select('*')
      .in('id', originalAuction.artwork_ids || [])
      .not('status', 'in', '("sold","returned")'); // Items not sold or returned

    if (itemsError) {
      console.error('Error fetching unsold items:', itemsError);
      return res.status(500).json({ error: 'Failed to fetch unsold items' });
    }

    if (!unsoldItems || unsoldItems.length === 0) {
      return res.status(400).json({ error: 'No unsold items found in this auction. Items must not be marked as sold or returned.' });
    }

    // Create new auction with unsold items - exclude id, created_at, updated_at fields
    const {
      id: originalId,
      created_at: originalCreatedAt,
      updated_at: originalUpdatedAt,
      ...originalAuctionFields
    } = originalAuction;

    const passedAuctionData = {
      ...originalAuctionFields,
      short_name: short_name || `${originalAuction.short_name} - Passed`,
      long_name: long_name || `${originalAuction.long_name} - Passed`,
      type: originalAuction.type as 'timed' | 'live' | 'sealed_bid',
      subtype: subtype,
      artwork_ids: unsoldItems.map(item => item.id),
      sold_lots_count: 0,
      total_estimate_low: unsoldItems.reduce((sum, item) => sum + (item.low_est || 0), 0),
      total_estimate_high: unsoldItems.reduce((sum, item) => sum + (item.high_est || 0), 0),
      total_sold_value: 0
    };

    const { data: newAuction, error: createError } = await supabaseAdmin
      .from('auctions')
      .insert([passedAuctionData])
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `)
      .single();

    if (createError) {
      console.error('Error creating passed auction:', createError);
      return res.status(500).json({
        error: 'Failed to create passed auction',
        details: createError.message
      });
    }

    // Auto-sync to Google Sheets if configured
    if (newAuction?.id) {
      autoSyncAuctionToGoogleSheets(newAuction.id);
    }

    res.status(201).json({
      success: true,
      data: newAuction,
      message: `Created passed auction with ${unsoldItems.length} unsold items`
    });

  } catch (error) {
    console.error('Error in POST /auctions/:id/generate-passed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auctions/generate-passed-bulk - Generate passed auction from multiple auctions with unsold items
router.post('/generate-passed-bulk', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { auction_ids, subtype, short_name, long_name, catalogue_launch_date, settlement_date } = req.body;

    // Validate required fields
    if (!auction_ids || !Array.isArray(auction_ids) || auction_ids.length === 0) {
      return res.status(400).json({ error: 'auction_ids must be a non-empty array' });
    }

    // Validate subtype
    const validSubtypes = ['actual', 'post_sale_platform', 'post_sale_private', 'free_timed'];
    if (!subtype || !validSubtypes.includes(subtype)) {
      return res.status(400).json({
        error: 'Invalid subtype. Must be one of: ' + validSubtypes.join(', ')
      });
    }

    // Validate dates
    if (!catalogue_launch_date || !settlement_date) {
      return res.status(400).json({ error: 'catalogue_launch_date and settlement_date are required' });
    }

    // Get all original auctions
    const { data: originalAuctions, error: fetchError } = await supabaseAdmin
      .from('auctions')
      .select('*')
      .in('id', auction_ids);

    if (fetchError || !originalAuctions || originalAuctions.length === 0) {
      return res.status(404).json({ error: 'One or more auctions not found' });
    }

    // Validate all auctions are from the same brand
    const brandIds = [...new Set(originalAuctions.map(a => a.brand_id).filter(Boolean))];
    if (brandIds.length > 1) {
      return res.status(400).json({ 
        error: 'All selected auctions must be from the same brand' 
      });
    }

    const brandId = brandIds[0] || null;

    // Collect all artwork IDs from all auctions
    const allArtworkIds = originalAuctions.flatMap(auction => auction.artwork_ids || []);

    if (allArtworkIds.length === 0) {
      return res.status(400).json({ error: 'No items found in selected auctions' });
    }

    // Get unsold items (items that are not sold or returned) from all auctions
    const { data: unsoldItems, error: itemsError } = await supabaseAdmin
      .from('items')
      .select('*')
      .in('id', allArtworkIds)
      .not('status', 'in', '("sold","returned")'); // Items not sold or returned

    if (itemsError) {
      console.error('Error fetching unsold items:', itemsError);
      return res.status(500).json({ error: 'Failed to fetch unsold items' });
    }

    if (!unsoldItems || unsoldItems.length === 0) {
      return res.status(400).json({ 
        error: 'No unsold items found in selected auctions. Items must not be marked as sold or returned.' 
      });
    }

    // Use the first auction as a template, but update with provided dates and names
    const templateAuction = originalAuctions[0];
    const {
      id: originalId,
      created_at: originalCreatedAt,
      updated_at: originalUpdatedAt,
      ...originalAuctionFields
    } = templateAuction;

    // Format dates for database (ISO format)
    const formatDateForDB = (dateString: string): string => {
      const date = new Date(dateString);
      return date.toISOString();
    };

    const passedAuctionData = {
      ...originalAuctionFields,
      short_name: short_name || `${templateAuction.short_name} - Passed`,
      long_name: long_name || `${templateAuction.long_name} - Passed`,
      type: templateAuction.type as 'timed' | 'live' | 'sealed_bid',
      subtype: subtype,
      catalogue_launch_date: formatDateForDB(catalogue_launch_date),
      settlement_date: formatDateForDB(settlement_date),
      artwork_ids: unsoldItems.map(item => item.id),
      sold_lots_count: 0,
      total_estimate_low: unsoldItems.reduce((sum, item) => sum + (item.low_est || 0), 0),
      total_estimate_high: unsoldItems.reduce((sum, item) => sum + (item.high_est || 0), 0),
      total_sold_value: 0,
      brand_id: brandId
    };

    const { data: newAuction, error: createError } = await supabaseAdmin
      .from('auctions')
      .insert([passedAuctionData])
      .select(`
        *,
        specialist_id(id, first_name, last_name, email),
        brand:brand_id(id, code, name)
      `)
      .single();

    if (createError) {
      console.error('Error creating passed auction:', createError);
      return res.status(500).json({
        error: 'Failed to create passed auction',
        details: createError.message
      });
    }

    // Auto-sync to Google Sheets if configured
    if (newAuction?.id) {
      autoSyncAuctionToGoogleSheets(newAuction.id);
    }

    res.status(201).json({
      success: true,
      data: newAuction,
      message: `Created passed auction with ${unsoldItems.length} unsold items from ${originalAuctions.length} auction(s)`
    });

  } catch (error) {
    console.error('Error in POST /auctions/generate-passed-bulk:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/auctions/unsold-counts - Get unsold item counts for auctions
router.get('/unsold-counts', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { auction_ids } = req.query;

    if (!auction_ids) {
      return res.status(400).json({ error: 'auction_ids parameter is required' });
    }

    let auctionIds: number[];
    if (typeof auction_ids === 'string') {
      auctionIds = auction_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    } else if (Array.isArray(auction_ids)) {
      auctionIds = auction_ids.map(id => parseInt(id.toString())).filter(id => !isNaN(id));
    } else {
      return res.status(400).json({ error: 'auction_ids must be a comma-separated string or array of numbers' });
    }

    if (auctionIds.length === 0) {
      return res.status(400).json({ error: 'No valid auction IDs provided' });
    }

    // Get auctions to collect all artwork IDs
    const { data: auctions, error: auctionsError } = await supabaseAdmin
      .from('auctions')
      .select('id, artwork_ids')
      .in('id', auctionIds);

    if (auctionsError || !auctions) {
      return res.status(500).json({ error: 'Failed to fetch auctions' });
    }

    // Collect all artwork IDs from all auctions
    const allArtworkIds = auctions.flatMap(auction => auction.artwork_ids || []);

    if (allArtworkIds.length === 0) {
      // Return zero counts for all auctions
      const counts = auctionIds.reduce((acc, auctionId) => {
        acc[auctionId] = 0;
        return acc;
      }, {} as Record<number, number>);
      return res.json({ success: true, counts, total: 0 });
    }

    // Get unsold items (items that are not sold or returned)
    const { data: unsoldItems, error: itemsError } = await supabaseAdmin
      .from('items')
      .select('id, auction_id')
      .in('id', allArtworkIds)
      .or('status.neq.sold,status.neq.returned');

    if (itemsError) {
      console.error('Error fetching unsold items:', itemsError);
      return res.status(500).json({ error: 'Failed to fetch unsold items' });
    }

    // Count unsold items per auction
    const counts: Record<number, number> = {};

    // Initialize all auctions with 0 count
    auctionIds.forEach(auctionId => {
      counts[auctionId] = 0;
    });

    // Count unsold items for each auction
    if (unsoldItems) {
      // Group unsold items by their auction_id
      const unsoldByAuction = unsoldItems.reduce((acc, item) => {
        // Find which auction this item belongs to
        const auction = auctions.find(a => (a.artwork_ids || []).includes(item.id));
        if (auction) {
          acc[auction.id] = (acc[auction.id] || 0) + 1;
        }
        return acc;
      }, {} as Record<number, number>);

      // Update counts
      Object.entries(unsoldByAuction).forEach(([auctionId, count]) => {
        counts[parseInt(auctionId)] = count;
      });
    }

    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    res.json({
      success: true,
      counts,
      total
    });

  } catch (error) {
    console.error('Error in GET /auctions/unsold-counts:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}


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
    const configKey = 'google_sheet_url_auctions';
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
        .eq('key', 'google_sheet_url_auctions')
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
      console.log(`🔄 PROCESSING: Processing ${changes.length} Google Sheets auctions changes`);

      for (const [index, change] of changes.entries()) {
        try {
          console.log(`\n📄 Processing row ${index + 1} from Google Sheets:`, change.record);

          // Transform the Google Sheets row into your DB format
          const transformedRecord = this.transformGoogleSheetsRecord(change.record);
          console.log('🔧 Transformed record for DB:', transformedRecord);

          // Find if auctions already exists
          const matchResult = await findMatchingAuction(transformedRecord);
          console.log('🔍 Match result:', matchResult);

          if (matchResult.shouldUpdate && matchResult.auctionId) {
            console.log(`🔄 POLLING: Updating existing auctions ID ${matchResult.auctionId}`);

            const { data, error } = await supabaseAdmin
              .from('auctions')
              .update(transformedRecord)
              .eq('id', matchResult.auctionId)
              .select()
              .single();

            if (error) {
              console.error(`❌ POLLING: Error updating auctions ${matchResult.auctionId}:`, error);
            } else {
              console.log(`✅ POLLING: Successfully updated auctions ID ${matchResult.auctionId}`, data);
            }
          } else {
            console.log(`➕ POLLING: Creating new auctions from Google Sheets`);

            const { data: newauctions, error } = await supabaseAdmin
              .from('auctions')
              .insert([transformedRecord])
              .select()
              .single();

            if (error) {
              console.error('❌ POLLING: Error creating new auctions:', error);
            } else {
              console.log(`✅ POLLING: Successfully created new auctions ID ${newauctions?.id}`, newauctions);
            }
          }
        } catch (error: any) {
          console.error(`❌ POLLING: Error processing Google Sheets row ${index + 1}:`, error);
        }
      }

      console.log(`✅ POLLING: Completed processing ${changes.length} auctions changes`);
    } catch (error: any) {
      console.error('❌ POLLING: Error processing auctions changes:', error);
    }
  }
  private transformGoogleSheetsRecord(record: Record<string, any>): Record<string, any> {
    // Helpers
    const toInt = (val: any): number | undefined => {
      if (val === undefined || val === null || val === '') return undefined;
      const parsed = parseInt(String(val), 10);
      return isNaN(parsed) ? undefined : parsed;
    };

    const toFloat = (val: any): number | undefined => {
      if (val === undefined || val === null || val === '') return undefined;
      const parsed = parseFloat(String(val));
      return isNaN(parsed) ? undefined : parsed;
    };

    const toISOString = (val: any): string | undefined => {
      if (!val) return undefined;
      const date = new Date(val);
      return isNaN(date.getTime()) ? undefined : date.toISOString();
    };

    const parseJsonIfString = (val: any) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    };

    // Normalize keys
    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().trim().replace(/\s+/g, '_');
      normalized[normalizedKey] = value;
    }

    // Transform only DB-compatible fields
    const transformed: Record<string, any> = {
      id: toInt(normalized.id),
      specialist_id: normalized.specialist_id !== undefined ? toInt(normalized.specialist_id) : undefined,
      brand_id: normalized.brand_id !== undefined ? toInt(normalized.brand_id) : undefined,
      type: normalized.type ? String(normalized.type).trim() : undefined,
      short_name: normalized.short_name ? String(normalized.short_name).trim() : undefined,
      long_name: normalized.long_name ? String(normalized.long_name).trim() : undefined,
      charges: normalized.charges ? String(normalized.charges).trim() : undefined,
      description: normalized.description ? String(normalized.description).trim() : undefined,
      important_notice: normalized.important_notice ? String(normalized.important_notice).trim() : undefined,
      title_image_url: normalized.title_image_url ? String(normalized.title_image_url).trim() : undefined,
      sorting_mode: normalized.sorting_mode ? String(normalized.sorting_mode).trim() : undefined,
      estimates_visibility: normalized.estimates_visibility ? String(normalized.estimates_visibility).trim() : undefined,
      time_zone: normalized.time_zone ? String(normalized.time_zone).trim() : undefined,
      platform: normalized.platform ? String(normalized.platform).trim() : undefined,
      subtype: normalized.subtype ? String(normalized.subtype).trim() : undefined,
      upload_status: normalized.upload_status ? String(normalized.upload_status).trim() : undefined,
      target_reserve: normalized.target_reserve !== undefined ? toFloat(normalized.target_reserve) : undefined,
      total_estimate_low: normalized.total_estimate_low !== undefined ? toFloat(normalized.total_estimate_low) : undefined,
      total_estimate_high: normalized.total_estimate_high !== undefined ? toFloat(normalized.total_estimate_high) : undefined,
      total_sold_value: normalized.total_sold_value !== undefined ? toFloat(normalized.total_sold_value) : undefined,
      sold_lots_count: normalized.sold_lots_count !== undefined ? toInt(normalized.sold_lots_count) : undefined,
      settlement_date: normalized.settlement_date ? toISOString(normalized.settlement_date) : undefined,
      catalogue_launch_date: normalized.catalogue_launch_date ? toISOString(normalized.catalogue_launch_date) : undefined,
      aftersale_deadline: normalized.aftersale_deadline ? toISOString(normalized.aftersale_deadline) : undefined,
      shipping_date: normalized.shipping_date ? toISOString(normalized.shipping_date) : undefined,
      auction_days: normalized.auction_days ? parseJsonIfString(normalized.auction_days) : undefined,
      sale_events: normalized.sale_events ? parseJsonIfString(normalized.sale_events) : undefined,
      auctioneer_declaration: normalized.auctioneer_declaration ? parseJsonIfString(normalized.auctioneer_declaration) : undefined,
      bid_value_increments: normalized.bid_value_increments ? parseJsonIfString(normalized.bid_value_increments) : undefined,
      artwork_ids: normalized.artwork_ids ? parseJsonIfString(normalized.artwork_ids) : undefined,
      liveauctioneers_url: normalized.liveauctioneers_url ? String(normalized.liveauctioneers_url).trim() : undefined,
      easy_live_url: normalized.easy_live_url ? String(normalized.easy_live_url).trim() : undefined,
      invaluable_url: normalized.invaluable_url ? String(normalized.invaluable_url).trim() : undefined,
      the_saleroom_url: normalized.the_saleroom_url ? String(normalized.the_saleroom_url).trim() : undefined,
      updated_at: new Date().toISOString()
    };

    // Remove undefined/null fields
    Object.keys(transformed).forEach(key => {
      if (transformed[key] === undefined || transformed[key] === null) {
        delete transformed[key];
      }
    });

    console.log('🔧 Transformed auction record:', transformed);
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
  const findMatchingAuction = async (record: any): Promise<{ shouldUpdate: boolean; auctionId: number | null }> => {
    try {
      const csvId = parseInt(record.ID || record.id);
      
      // Only process valid numeric IDs
      if (!csvId || csvId <= 0) {
        console.log(`❌ Invalid CSV ID "${record.ID}" -> CREATE new auctions`);
        return { shouldUpdate: false, auctionId: null };
      }

      // Query Supabase for existing auctions with this ID
      const { data: auctions } = await supabaseAdmin
        .from('auctions')
        .select('id')
        .eq('id', csvId)
        .maybeSingle();

      if (auctions?.id) {
        console.log(`✅ CSV ID ${csvId} matches existing auctions -> UPDATE`);
        return { shouldUpdate: true, auctionId: auctions.id };
      } else {
        console.log(`❌ CSV ID ${csvId} not found -> CREATE new auctions`);
        return { shouldUpdate: false, auctionId: null };
      }
    } catch (error) {
      console.error('❌ Error finding matching auctions:', error);
      return { shouldUpdate: false, auctionId: null };
    }
  };

  function normalizeTitle(title: string) {
    return title
      .normalize('NFKD')                  // fix encoding
      .replace(/&#8211;|–|—/g, '-')       // normalize dashes
      .replace(/[^\w\s-]/g, '')           // remove punctuation
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }
 
  router.post('/sync-eoa', async (req: AuthRequest, res: Response) => {
    try {
      const response = await axios.get('YOUR_LIVEAUCTIONEERS_XML_URL');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        cdataPropName: 'value'
      });

      const json = parser.parse(response.data);

      const items = json.amapi.response.eoa.item;

      if (!items) {
        return res.json({ success: true, message: 'No sold items found' });
      }

      // 1️⃣ Fetch all artworks once
      const { data: artworks, error } = await supabaseAdmin
        .from('artworks')
        .select('*');

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // 2️⃣ Build normalized lookup map
      const artworkMap = new Map();

      artworks?.forEach((art: any) => {
        artworkMap.set(normalizeTitle(art.title), art);
      });

      let updated = 0;
      let notMatched: string[] = [];

      const itemArray = Array.isArray(items) ? items : [items];

      for (const item of itemArray) {
        const title = item.details.title?.value;
        if (!title) continue;

        const normalized = normalizeTitle(title);
        const matchedArtwork = artworkMap.get(normalized);

        if (!matchedArtwork) {
          notMatched.push(title);
          continue;
        }

        const updateData = {
          lot_number: item.details.lotNumber,
          hammer_price: parseFloat(item.sale.hammer),
          buyers_premium: parseFloat(item.sale.buyersPrem),
          total_price:
            parseFloat(item.sale.hammer) +
            parseFloat(item.sale.buyersPrem),
          invoice_id: item.sale.invoiceID,
          external_sale_id: item.id,
          sold_at: new Date().toISOString(),
          status: 'sold',

          // buyer details
          buyer_name:
            item.buyer.buyer_first_name?.value +
            ' ' +
            item.buyer.buyer_last_name?.value,
          buyer_email: item.buyer.email?.value,
          buyer_phone: item.buyer.buyer_phone?.value,
          buyer_country: item.buyer.buyer_country?.value,
        };

        await supabaseAdmin
          .from('artworks')
          .update(updateData)
          .eq('id', matchedArtwork.id);

        updated++;
      }

      return res.json({
        success: true,
        updated,
        notMatched
      });

    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Sync failed' });
    }
  });

  const toNumber = (value: any): number | null => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return isNaN(n) ? null : n;
  };

  const toString = (value: any): string | null => {
    if (value === undefined || value === null) return null;
    return String(value).trim();
  };

  const parsePrice = (value: any): number | null => {
    if (!value) return null;
    let str = String(value).replace(/&pound;|£/gi, '').replace(/,/g, '').trim();
    const n = Number(str);
    return isNaN(n) ? null : n;
  };


  router.get('/updateinventory-live/:auctionId', async (req: AuthRequest, res: Response) => {
    try {
      const auctionId = Number(req.params.auctionId);
      if (isNaN(auctionId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid auction ID'
        });
      }
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
      const houseId = 10020;
      const response = await fetch(
        `https://classic.liveauctioneers.com/auctioneers/${catalogIdWithString}.html?img=n&sort=la&order=&r=500&n=100&filter=none&displaytype=xmlexport`,
        {
          method: "GET",
          "headers": {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "priority": "u=0, i",
            "sec-ch-ua": "\"Not:A-Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            "cookie": "visid_incap_3258120=2izfDQuyRcqV3Xl+IEo6TuRrOWkAAAAAQUIPAAAAAADKKZdDiJhDZpBj+wwAs5q1; visid_incap_3258118=JisN+RYmQcuK2wskiYCjB5ZsOWkAAAAAQUIPAAAAAADeZhuJIJeWpHPdC+LeYwpC; _gcl_au=1.1.1871660951.1765370856.1417926464.1765370857.1765371041; AMP_MKTG_7e0d4639e8=JTdCJTdE; visid_incap_3258119=qJtF4qh8RpGiSQeECDIpO4Lnl2kAAAAAQUIPAAAAAACMhpGnH3WRqZVfGZav3tGn; la_id_y=3405089968; optimizelyEndUserId=oeu1771568162310r0.21203127424895785; __qca=P1-bbdd2eae-fba4-410f-ab45-7ec3778588f8; __smVID=f04b27d77ab8220cfc13b113568f0c25066f9f087dfbca24db163538964d7495; _ga=GA1.2.1865892381.1771568162; ajs_user_id=m-saber; ajs_anonymous_id=6c26bef8-b182-4236-b781-20e2bc4bfad0; aJS=no; JS=no; __utmz=118153238.1771819959.4.3.utmcsr=partners.liveauctioneers.com|utmccn=(referral)|utmcmd=referral|utmcct=/; CT=Y54; PHPSESSID=a66m1s4ab0uqtqdbnhdvg5mibc; __utmc=118153238; join-modal-last-seen=2026-03-03; _clck=fkmyy7%5E2%5Eg3u%5E0%5E2170; _session_id=33ab5eb7-e100-44be-ac54-f1245de2f370; nlbi_3258119=CQ+wZ8/dfTO1tWaMBHoOdwAAAACrtTawC+sq4QiDUHkz5Bxb; incap_ses_932_3258119=BU6LWTxK80OAZluJKSHvDNNRnWkAAAAAWGqwodi9DEDiUJyeOcMHpw==; AMP_9fea6c3284=JTdCJTIyZGV2aWNlSWQlMjIlM0ElMjJjNTcxYjE1Ny1iNzYwLTQ4NGEtYmZmOS02NDRlNjNiNGE4M2ElMjIlMkMlMjJ1c2VySWQlMjIlM0ElMjIxNjY3OCUyMiUyQyUyMnNlc3Npb25JZCUyMiUzQTE3NzE5MTc3ODM3NDglMkMlMjJvcHRPdXQlMjIlM0FmYWxzZSUyQyUyMmxhc3RFdmVudFRpbWUlMjIlM0ExNzcxOTE3Nzg1NDMwJTJDJTIybGFzdEV2ZW50SWQlMjIlM0ExMzUlMkMlMjJwYWdlQ291bnRlciUyMiUzQTIlN0Q=; AMP_7e0d4639e8=JTdCJTIyZGV2aWNlSWQlMjIlM0ElMjJiNjVjOGNiNy0zZTU4LTQ0YWQtYjQ5Ny03YTMyYzg4MTFiMzclMjIlMkMlMjJ1c2VySWQlMjIlM0FudWxsJTJDJTIyc2Vzc2lvbklkJTIyJTNBMTc3MTkxNzc4OTQ5NiUyQyUyMm9wdE91dCUyMiUzQWZhbHNlJTJDJTIybGFzdEV2ZW50VGltZSUyMiUzQTE3NzE5MTc3ODk1MDAlMkMlMjJsYXN0RXZlbnRJZCUyMiUzQTAlMkMlMjJwYWdlQ291bnRlciUyMiUzQTElN0Q=; la_ah_867=da7fbab5288efe3a80a444d9bbaf7769; auctioneer-auth=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3NzE5MTc4NzgsImV4cCI6MTc3MzEyNzQ3OCwiaXNzIjoiY2xhc3NpYy5saXZlYXVjdGlvbmVlcnMuY29tIiwic3ViIjoiMTY2NzgiLCJ0eXBlIjoiYXVjdGlvbmVlciIsImhvdXNlX2lkIjoiMTAwMjAiLCJob3VzZV9uYW1lIjoiQXVydW0gQXVjdGlvbnMgIn0.lEMIAAc9xFMExN1ICEPBEJZOMPfN0fUFCXz5gNRIQX0; _clsk=1d4fb7c%5E1771918468816%5E3%5E0%5El.clarity.ms%2Fcollect; incap_ses_198_3258120=tJcUbfvpxCzd//UVFHC/Am9VnWkAAAAALo5tx9Z9PgSRrwZOyBasvQ==; nlbi_3258120=2oNfRa2T8x1JjZtm1hDWlQAAAABPlBsRh9uHZ3rtrwGgM3MG; incap_ses_932_3258120=irzJEKixbBKkroGJKSHvDI1inWkAAAAA3GgxYGUU7ZeQvkc9XhH1KQ==; __utma=118153238.1865892381.1771568162.1771926241.1771928683.9; LOTSPG=C382422InR1000N1000Ola_C382454InR20N20Ola_C378785InR500N100Ola_C382424InR20N20Ola_; __utmt=1; __utmb=118153238.5.10.1771928683; __utmli=elgen-2",
            "Referer": "https://classic.liveauctioneers.com/auctioneers/CL378785.html?filter=&sort=&order=&show=&rows=500"
          },

        }
      );       
      console.log ("URl - " , `https://classic.liveauctioneers.com/auctioneers/${catalogIdWithString}.html?img=n&sort=la&order=&r=20&n=20&filter=none&displaytype=xmlexport&hce=|`);
      let xml = await response.text();
      xml = xml.replace(/<Description>[\s\S]*?<\/Description>/gi, '');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        parseTagValue: true,
      });


      const parsed = parser.parse(xml);
      const rows = parsed.catalog?.row;
      const itemList = rows
        ? Array.isArray(rows)
          ? rows
          : [rows]
        : [];

      console.log(`Found ${itemList.length} items in catalog`);

      const updatePromises: Promise<any>[] = [];
      for (const item of itemList) {  // <-- use itemList
        const artwork = {
          lot: toNumber(item.Lot),
          lotId: toNumber(item.LotID),
          title: toString(item.Title),
          low_estimate: parsePrice(item.LowEst),
          high_estimate: parsePrice(item.HighEst),
          start_price: parsePrice(item.StartPrice),
          reserve_price: parsePrice(item.ReservePrice),
        };

        // Push promise instead of awaiting immediately
        updatePromises.push(updateItemPricesForAllMatches(artwork.title!, {
          low_est: artwork.low_estimate,
          high_est: artwork.high_estimate,
          start_price: artwork.start_price,
          reserve: artwork.reserve_price,
        }));
      }

      // Run all updates in parallel in batches to avoid memory spike
      const BATCH_SIZE = 20;
      for (let i = 0; i < updatePromises.length; i += BATCH_SIZE) {
        await Promise.all(updatePromises.slice(i, i + BATCH_SIZE));
      }

      res.json({
        success: true,
        message: 'Auction sync completed'
      });
    } catch (error: any) {
        console.error('Error fetching catalog:', error);
        res.status(500).json({ success: false, message: error.message });
      }
  });

  async function updateItemPricesForAllMatches(title: string, updates: {
    low_est?: number | null,
    high_est?: number | null,
    start_price?: number | null,
    reserve?: number | null
  }) {
    let artworks = await getArtworkByFullTitle(title);
    if (!artworks.length) artworks = await getArtworkBySmartTitle(title);
    if (!artworks.length) return { success: false, title, message: 'No matches found' };

    const results = await Promise.all(
      artworks.map(async item => {
        const { data: updatedItem, error } = await supabaseAdmin
          .from('items')
          .update({
            low_est: updates.low_est ?? item.low_est,
            high_est: updates.high_est ?? item.high_est,
            start_price: updates.start_price ?? item.start_price,
            reserve: updates.reserve ?? item.reserve,
          })
          .eq('id', item.id)
          .select()
          .single();

        if (error) return { success: false, itemId: item.id, message: error.message };
        return { success: true, itemId: item.id, data: updatedItem };
      })
    );

    return results;
  }

  function normalizeTitleArtwork(title: any): string {
    if (!title) return '';

    if (typeof title === "object" && "#text" in title) {
      title = title["#text"];
    }

    const str = String(title);

    return str
      .replace(/&#\d+;/g, '')
      .replace(/&[a-z]+;/gi, '')
      .replace(/â|–/g, '-')
      .replace(/[|"'`]/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  async function getArtworkByFullTitle(title: string) {
    const cleanTitle = normalizeTitleArtwork(title);
    const { data, error } = await supabaseAdmin
      .from('items')
      .select('*')
      .ilike('title', cleanTitle); // exact match (case-insensitive)
  
    if (!error && data?.length > 0) return data;
    return [];
  }

  async function getArtworkBySmartTitle(rawTitle: string) {
    if (!rawTitle) return [];
  
    const cleanTitle = normalizeTitleArtwork(rawTitle);
  
    const { data: exactMatches, error: exactError } = await supabaseAdmin
      .from('items')
      .select('*')
      .ilike('title', `%${cleanTitle}%`);
  
    if (!exactError && exactMatches?.length > 0) return exactMatches;

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
   // routes/auctions.ts (or wherever your routes are)
  router.get('/liveauctioneer-get/:auctionId', async (req: Request, res: Response) => {
    try {
      const auctionId = Number(req.params.auctionId);
      if (isNaN(auctionId)) {
        return res.status(400).json({ success: false, message: 'Invalid auction ID' });
      }

      const { data: auction, error } = await supabaseAdmin
        .from('auctions')
        .select('auction_liveauctioneers_id')
        .eq('id', auctionId)
        .single();

      if (error || !auction) {
        return res.status(404).json({ success: false, message: 'Auction not found' });
      }

      res.json({
        success: true,
        auctionId,
        liveAuctioneerId: auction.auction_liveauctioneers_id
      });
    } catch (err: any) {
      console.error('Error fetching Live Auctioneer ID:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  router.post('/liveauctioneer-update/:auctionId', async (req: AuthRequest, res: Response) => {
    try {
      const auctionId = Number(req.params.auctionId);
      if (isNaN(auctionId)) {
        return res.status(400).json({ success: false, message: 'Invalid auction ID' });
      }

      const { liveAuctioneerId } = req.body;
      if (!liveAuctioneerId || typeof liveAuctioneerId !== 'string') {
        return res.status(400).json({ success: false, message: 'Live Auctioneer ID is required' });
      }

      const { data, error } = await supabaseAdmin
        .from('auctions')
        .update({ auction_liveauctioneers_id: liveAuctioneerId })
        .eq('id', auctionId)
        .select()
        .single();

      if (error || !data) {
        return res.status(500).json({ success: false, message: 'Failed to update Live Auctioneer ID' });
      }

      res.json({ success: true, liveAuctioneerId: data.auction_liveauctioneers_id });
    } catch (err: any) {
      console.error('Error updating Live Auctioneer ID:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });
   
export default router; 