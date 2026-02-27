// backend/src/routes/public-auctions.ts
// Purpose: Public, unauthenticated read-only endpoints for auctions listing and details

import express from 'express';
import { supabaseAdmin } from '../utils/supabase';

const router = express.Router();

// Helper function to determine auction status based on dates
function getAuctionStatus(auction: any): string {
  const now = new Date();
  const settlementDate = new Date(auction.settlement_date);
  const catalogueLaunchDate = auction.catalogue_launch_date ? new Date(auction.catalogue_launch_date) : null;

  if (settlementDate < now) {
    return 'ended';
  } else if (catalogueLaunchDate && catalogueLaunchDate <= now) {
    return 'in_progress';
  } else {
    return 'planned';
  }
}

// GET /api/public/auctions
router.get('/', async (req, res) => {
  try {
    const {
      status,
      type,
      brand_id,
      search,
      page = '1',
      limit = '24',
      sort_field = 'settlement_date',
      sort_direction = 'asc'
    } = req.query as Record<string, string>;

    let query = supabaseAdmin
      .from('auctions')
      .select(`
        id, type, subtype, short_name, long_name, description, title_image_url,
        catalogue_launch_date, settlement_date,
        liveauctioneers_url, easy_live_url, invaluable_url, the_saleroom_url,
        brand:brand_id(id, code, name)
      `, { count: 'exact' });

    if (brand_id) query = query.eq('brand_id', Number(brand_id));
    if (type && type !== 'all') query = query.eq('type', type);
    if (search) query = query.or(`short_name.ilike.%${search}%,long_name.ilike.%${search}%,description.ilike.%${search}%`);

    const validSortFields = ['id', 'short_name', 'long_name', 'type', 'settlement_date', 'catalogue_launch_date', 'created_at', 'updated_at'];
    const sortField = validSortFields.includes(sort_field) ? sort_field : 'settlement_date';
    query = query.order(sortField, { ascending: sort_direction === 'asc' });

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 100);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    const { data, error, count } = await query.range(from, to);
    if (error) {
      return res.status(500).json({ error: 'Failed to fetch auctions', details: error.message });
    }

    // Filter by computed status if status parameter is provided
    let filteredData = data || [];
    if (status && status !== 'all') {
      filteredData = filteredData.filter(auction => getAuctionStatus(auction) === status);
    }

    // Add computed status to each auction
    const auctionsWithStatus = filteredData.map(auction => ({
      ...auction,
      status: getAuctionStatus(auction)
    }));

    return res.json({
      success: true,
      auctions: auctionsWithStatus,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        pages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// GET /api/public/auctions/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('auctions')
      .select(`
        *, brand:brand_id(id, code, name)
      `)
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Auction not found' });
    }

    return res.json({ success: true, auction: data });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

export default router;




