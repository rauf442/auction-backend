// backend/src/routes/dashboard.ts
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabaseAdmin } from '../utils/supabase';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();

// GET /api/dashboard/stats - Get dashboard statistics
router.get('/stats', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { date_from, date_to, brand_code } = req.query as { date_from?: string; date_to?: string; brand_code?: string };

    // Convert brand_code to brand_id if provided
    let brandId: number | undefined;
    if (brand_code) {
      const { data: brandData } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', brand_code.toUpperCase())
        .single();
      brandId = brandData?.id;
    }

    // Build auctions query with optional brand + date filters
    let auctionsQuery = supabaseAdmin.from('auctions').select('*');
    if (brandId) auctionsQuery = auctionsQuery.eq('brand_id', brandId);
    if (date_from) auctionsQuery = auctionsQuery.gte('settlement_date', date_from);
    if (date_to) auctionsQuery = auctionsQuery.lte('settlement_date', date_to);

    const { data: auctions, error: auctionsError } = await auctionsQuery;
    if (auctionsError) throw auctionsError;

    // Get all clients for statistics
    let clientsQuery = supabaseAdmin.from('clients').select('*');
    if (brandId) clientsQuery = clientsQuery.eq('brand_id', brandId);
    const { data: allClients, error: clientsError } = await clientsQuery;
    if (clientsError) throw clientsError;

    // Get items count first (to avoid 1000 row limit)
    let countQuery = supabaseAdmin.from('items').select('*', { count: 'exact', head: true });
    if (brandId) countQuery = countQuery.eq('brand_id', brandId);
    const { count: totalItemsCount } = await countQuery;

    // Get sold items count
    let soldCountQuery = supabaseAdmin.from('items').select('*', { count: 'exact', head: true }).eq('status', 'sold');
    if (brandId) soldCountQuery = soldCountQuery.eq('brand_id', brandId);
    const { count: soldItemsCount } = await soldCountQuery;

    // Get items for value calculations (with reasonable limit for performance)
    let itemsQuery = supabaseAdmin.from('items').select('*').limit(10000); // Set explicit limit
    if (brandId) itemsQuery = itemsQuery.eq('brand_id', brandId);
    const { data: itemsData, error: itemsError } = await itemsQuery;
    if (itemsError) throw itemsError;
    const items = itemsData || [];

    // Recent auctions already fetched; sort and limit 10
    const recentAuctions = [...(auctions || [])]
      .sort((a: any, b: any) => (new Date(b.settlement_date).getTime()) - (new Date(a.settlement_date).getTime()))
      .slice(0, 10);

    // Top lots by hammer price (filtered by brand if provided)
    let topLotsQuery = supabaseAdmin
      .from('items')
      .select('id,title,hammer_price,buyers_premium')
      .not('hammer_price', 'is', null)
      .order('hammer_price', { ascending: false })
      .limit(5);
    if (brandId) topLotsQuery = topLotsQuery.eq('brand_id', brandId);
    const { data: lotsData } = await topLotsQuery;
    const topLots = lotsData || [];

    // Calculate statistics from the fetched data
    const totalAuctions = auctions?.length || 0;
    const totalLots = totalItemsCount || 0; // Use the actual count instead of limited data
    const totalSold = soldItemsCount || 0;
    const unsold = totalLots - totalSold;
    const soldPercentage = totalLots > 0 ? Math.round((totalSold / totalLots) * 100) : 0;

    // Calculate value statistics
    const totalLowEstimate = items?.reduce((sum: number, item: any) => sum + (item.low_est || 0), 0) || 0;
    const totalHighEstimate = items?.reduce((sum: number, item: any) => sum + (item.high_est || 0), 0) || 0;
    const totalReserve = items?.reduce((sum: number, item: any) => sum + (item.reserve || 0), 0) || 0;
    const soldItemsInData = items?.filter((item: any) => item.status === 'sold') || [];
    const totalHammerPrice = soldItemsInData.reduce((sum: number, item: any) => sum + (item.hammer_price || 0), 0);
    const totalBuyersPremium = soldItemsInData.reduce((sum: number, item: any) => sum + (item.buyers_premium || 0), 0);

    // Calculate buyer statistics
    const uniqueBuyerIds = new Set(soldItemsInData.map((item: any) => item.buyer_id).filter(Boolean));
    const totalBidders = uniqueBuyerIds.size;

    // Calculate vendor statistics
    const vendors = allClients?.filter(c => c.client_type?.includes('vendor')) || [];
    const buyers = allClients?.filter(c => c.client_type?.includes('buyer')) || [];
    const totalVendors = vendors.length;
    const totalBuyers = buyers.length;

    // Calculate top buyers by total spent
    const buyerStats = buyers.map((buyer: any) => {
      const buyerItems = soldItemsInData.filter((item: any) => item.buyer_id === buyer.id);
      const totalSpent = buyerItems.reduce((sum: number, item: any) => sum + (item.hammer_price || 0) + (item.buyers_premium || 0), 0);
      const lotsWon = buyerItems.length;
      return {
        id: buyer.id,
        name: `${buyer.first_name} ${buyer.last_name}`,
        total_spent: totalSpent,
        lots_won: lotsWon
      };
    }).sort((a, b) => b.total_spent - a.total_spent).slice(0, 5);

    // Calculate top vendors by total revenue from their items
    const vendorStats = vendors.map((vendor: any) => {
      const vendorItems = items.filter((item: any) => item.vendor_id === vendor.id);
      const soldVendorItems = vendorItems.filter((item: any) => item.status === 'sold');
      const totalRevenue = soldVendorItems.reduce((sum: number, item: any) => sum + (item.hammer_price || 0), 0);
      const lotsConsigned = vendorItems.length;
      return {
        id: vendor.id,
        name: `${vendor.first_name} ${vendor.last_name}`,
        total_revenue: totalRevenue,
        lots_consigned: lotsConsigned
      };
    }).sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 5);

    const stats = {
      auctions: {
        total: totalAuctions,
        active: auctions?.filter(a => a.status === 'active').length || 0,
        completed: auctions?.filter(a => a.status === 'completed').length || 0,
        upcoming: auctions?.filter(a => a.status === 'upcoming').length || 0
      },
      lots: {
        totalLots,
        totalSold,
        soldInAuction: totalSold, // Simplification for now
        soldAfterwards: 0,
        unsold,
        soldPercentage
      },
      values: {
        totalLowEstimate,
        totalHighEstimate,
        totalReserve,
        totalHammerPrice,
        totalHammerWithCommission: totalHammerPrice + totalBuyersPremium
      },
      buyers: {
        totalBids: totalSold,
        totalBidders,
        totalBuyers
      },
      vendors: {
        totalVendors,
        totalConsignments: items?.filter(item => item.consignment_id).length || 0
      },
      revenue: {
        totalRevenue: totalHammerPrice + totalBuyersPremium,
        buyerPremium: totalBuyersPremium,
        vendorCommission: 0 // Will calculate based on commission rates
      },
      topLots: (topLots || []).map((lot: any) => ({
        id: lot.id,
        title: lot.title,
        auction_name: 'Various Auctions', // Since items can belong to multiple auctions
        lot_number: lot.id,
        hammer_price: lot.hammer_price || 0,
        total_price: (lot.hammer_price || 0) + (lot.buyers_premium || 0)
      })),
      topBuyers: buyerStats,
      topVendors: vendorStats,
      recentAuctions: (recentAuctions || []).map((auction: any) => ({
        id: auction.id,
        short_name: auction.short_name,
        // Provide UI-friendly dates while backend uses settlement_date for scoping
        start_date: auction.catalogue_launch_date || auction.settlement_date,
        end_date: auction.settlement_date,
        status: auction.status,
        total_lots: auction.artwork_ids?.length || 0, // Use existing lots_count from auction
        sold_lots: auction.sold_lots_count || 0 // Use existing sold_lots_count from auction
      }))
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
