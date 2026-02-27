// backend/src/routes/refunds.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();
router.use(authMiddleware);

interface Refund {
  id?: string;
  brand_id?: string;
  refund_number?: string;
  type: 'refund_of_artwork' | 'refund_of_courier_difference';
  reason: string;
  amount: number;
  // Invoice linkage (primary)
  invoice_id?: string;
  // Optional legacy linkage
  item_id?: string;
  client_id?: string;
  auction_id?: string;
  original_payment_reference?: string;
  refund_method?: 'bank_transfer' | 'credit_card' | 'cheque' | 'cash' | 'store_credit';
  bank_account_details?: any;
  refund_date?: string;
  status?: 'pending' | 'approved' | 'processing' | 'completed' | 'cancelled' | 'failed';
  approval_required?: boolean;
  approved_by?: string;
  approved_at?: string;
  processed_by?: string;
  processed_at?: string;
  internal_notes?: string;
  client_notes?: string;
  attachment_urls?: string[];
  // Type-specific fields
  hammer_price?: number;
  buyers_premium?: number;
  international_shipping_cost?: number;
  local_shipping_cost?: number;
  handling_insurance_cost?: number;
  shipping_difference?: number;
  created_by?: string;
  updated_by?: string;
}

// GET /api/refunds - Get all refunds with filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      status, 
      type,
      client_id,
      auction_id,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'created_at',
      sort_direction = 'desc',
      brand_code
    } = req.query;

    let query = supabaseAdmin
      .from('refunds_with_details')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (type && type !== 'all') {
      query = query.eq('type', type);
    }

    if (client_id) {
      query = query.eq('client_id', client_id);
    }

    if (auction_id) {
      query = query.eq('auction_id', auction_id);
    }

    // Visibility enforcement
    const { data: vis } = await supabaseAdmin
      .from('global_module_visibility')
      .select('is_public')
      .eq('module', 'refunds')
      .single();
    const isPublic = !!vis?.is_public;
    // Apply brand filtering if specified
    if (brand_code && brand_code !== 'all') {
      const { data: b } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', (brand_code as string).toUpperCase())
        .single();
      if (b?.id) {
        query = query.eq('brand_id', b.id as any);
      }
    }

    if (search) {
      query = query.or(
        `refund_number.ilike.%${search}%,reason.ilike.%${search}%,client_name.ilike.%${search}%,original_payment_reference.ilike.%${search}%`
      );
    }

    // Apply sorting
    query = query.order(sort_field as string, { 
      ascending: sort_direction === 'asc' 
    });

    // Apply pagination
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;
    
    query = query.range(offset, offset + limitNum - 1);

    const { data: refunds, error, count } = await query;

    if (error) {
      console.error('Error fetching refunds:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch refunds',
        details: error.message 
      });
    }

    res.json({
      refunds,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error in GET /refunds:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/refunds/:id - Get single refund
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: refund, error } = await supabaseAdmin
      .from('refunds_with_details')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching refund:', error);
      return res.status(404).json({ error: 'Refund not found' });
    }

    res.json(refund);
  } catch (error) {
    console.error('Error in GET /refunds/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/refunds - Create new refund
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const refundData: Refund = {
      ...req.body,
      created_by: req.user.id,
      updated_by: req.user.id
    };

    const providedBrandCode = (req.body?.brand_code as string | undefined)?.toUpperCase();
    if (providedBrandCode) {
      const { data: brand, error: brandErr } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', providedBrandCode)
        .single();
      if (!brand || brandErr) {
        return res.status(400).json({ error: 'Invalid brand_code' });
      }
      refundData.brand_id = brand.id as any;
    } else {
      const { data: defaultBrand } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', 'MSABER')
        .single();
      if (defaultBrand) {
        refundData.brand_id = defaultBrand.id as any;
      }
    }

    // Validate required fields and invoice linkage
    if (!refundData.reason || typeof refundData.amount !== 'number' || !refundData.type) {
      return res.status(400).json({ error: 'Missing required fields: reason, amount, type' });
    }
    if (!refundData.invoice_id) {
      return res.status(400).json({ error: 'Refund must be linked to an invoice (invoice_id required)' });
    }

    // Auto-calc amount based on type when not trusted from client
    if (refundData.type === 'refund_of_artwork') {
      const hammer = Number(refundData.hammer_price || 0);
      const premium = Number(refundData.buyers_premium || 0);
      refundData.amount = hammer + premium;
    } else if (refundData.type === 'refund_of_courier_difference') {
      const intl = Number(refundData.international_shipping_cost || 0);
      const local = Number(refundData.local_shipping_cost || 0);
      const handIns = Number(refundData.handling_insurance_cost || 0);
      refundData.shipping_difference = intl - local + handIns;
      refundData.amount = Math.max(0, refundData.shipping_difference);
    }

    // Clean up UUID fields
    if (refundData.item_id === '') refundData.item_id = undefined;
    if (refundData.client_id === '') refundData.client_id = undefined;
    if (refundData.auction_id === '') refundData.auction_id = undefined;
    if (refundData.approved_by === '') refundData.approved_by = undefined;
    if (refundData.processed_by === '') refundData.processed_by = undefined;

    const { data: refund, error } = await supabaseAdmin
      .from('refunds')
      .insert([refundData])
      .select()
      .single();

    if (error) {
      console.error('Error creating refund:', error);
      return res.status(500).json({ 
        error: 'Failed to create refund',
        details: error.message 
      });
    }

    res.status(201).json(refund);
  } catch (error) {
    console.error('Error in POST /refunds:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/refunds/:id - Update refund
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const refundData: Partial<Refund> = {
      ...req.body,
      updated_by: req.user.id
    };

    // Remove fields that shouldn't be updated
    delete refundData.id;
    delete refundData.created_by;
    delete refundData.refund_number;

    // Clean up UUID fields
    if (refundData.item_id === '') refundData.item_id = undefined;
    if (refundData.client_id === '') refundData.client_id = undefined;
    if (refundData.auction_id === '') refundData.auction_id = undefined;
    if (refundData.approved_by === '') refundData.approved_by = undefined;
    if (refundData.processed_by === '') refundData.processed_by = undefined;

    const { data: refund, error } = await supabaseAdmin
      .from('refunds')
      .update(refundData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating refund:', error);
      return res.status(500).json({ 
        error: 'Failed to update refund',
        details: error.message 
      });
    }

    res.json(refund);
  } catch (error) {
    console.error('Error in PUT /refunds/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/refunds/:id/approve - Approve refund
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { comments } = req.body;

    const updateData = {
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date().toISOString(),
      internal_notes: comments || null,
      updated_by: req.user.id
    };

    const { data: refund, error } = await supabaseAdmin
      .from('refunds')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error approving refund:', error);
      return res.status(500).json({ 
        error: 'Failed to approve refund',
        details: error.message 
      });
    }

    res.json(refund);
  } catch (error) {
    console.error('Error in PUT /refunds/:id/approve:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/refunds/:id/process - Process refund (mark as processing/completed)
router.put('/:id/process', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { status, refund_date, payment_reference } = req.body;

    if (!['processing', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be processing or completed' });
    }

    const updateData: any = {
      status,
      processed_by: req.user.id,
      processed_at: new Date().toISOString(),
      updated_by: req.user.id
    };

    if (refund_date) {
      updateData.refund_date = refund_date;
    }

    if (payment_reference) {
      updateData.original_payment_reference = payment_reference;
    }

    const { data: refund, error } = await supabaseAdmin
      .from('refunds')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error processing refund:', error);
      return res.status(500).json({ 
        error: 'Failed to process refund',
        details: error.message 
      });
    }

    res.json(refund);
  } catch (error) {
    console.error('Error in PUT /refunds/:id/process:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/refunds/:id - Delete refund
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('refunds')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting refund:', error);
      return res.status(500).json({ 
        error: 'Failed to delete refund',
        details: error.message 
      });
    }

    res.json({ message: 'Refund deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /refunds/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/refunds/stats - Get refund statistics
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('refunds')
      .select('status, type, amount');

    if (error) {
      console.error('Error fetching refund stats:', error);
      return res.status(500).json({ error: 'Failed to fetch refund statistics' });
    }

    const stats = {
      total_refunds: data.length,
      total_amount: data.reduce((sum, r) => sum + (r.amount || 0), 0),
      by_status: data.reduce((acc: any, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {}),
      by_type: data.reduce((acc: any, r) => {
        acc[r.type] = (acc[r.type] || 0) + 1;
        return acc;
      }, {}),
      pending_amount: data
        .filter(r => r.status === 'pending')
        .reduce((sum, r) => sum + (r.amount || 0), 0)
    };

    res.json(stats);
  } catch (error) {
    console.error('Error in GET /refunds/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 