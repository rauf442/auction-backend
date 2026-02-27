// backend/src/routes/reimbursements.ts
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

interface Reimbursement {
  id?: string;
  brand_id?: string;
  reimbursement_number?: string;
  title: string;
  description: string;
  category: 'food' | 'fuel' | 'internal_logistics' | 'international_logistics' | 'stationary' | 'travel' | 'accommodation' | 'other';
  total_amount: number;
  currency?: string;
  payment_method: 'cash' | 'card' | 'bank_transfer' | 'other';
  payment_date: string;
  vendor_name?: string;
  vendor_details?: string;
  receipt_urls?: string[];
  receipt_numbers?: string;
  has_receipts?: boolean;
  requested_by: string;
  department?: string;
  purpose: string;
  status?: 'pending' | 'director1_approved' | 'director2_approved' | 'accountant_approved' | 'completed' | 'rejected' | 'cancelled';
  director1_approval_status?: 'pending' | 'approved' | 'rejected';
  director1_approved_by?: string;
  director1_approved_at?: string;
  director1_comments?: string;
  director2_approval_status?: 'pending' | 'approved' | 'rejected';
  director2_approved_by?: string;
  director2_approved_at?: string;
  director2_comments?: string;
  accountant_approval_status?: 'pending' | 'approved' | 'rejected';
  accountant_approved_by?: string;
  accountant_approved_at?: string;
  accountant_comments?: string;
  processed_by?: string;
  processed_at?: string;
  payment_reference?: string;
  payment_completed_at?: string;
  rejection_reason?: string;
  rejected_by?: string;
  rejected_at?: string;
  project_code?: string;
  cost_center?: string;
  tax_amount?: number;
  tax_rate?: number;
  net_amount?: number;
  internal_notes?: string;
  accounting_notes?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  expected_payment_date?: string;
  created_by?: string;
  updated_by?: string;
}

// GET /api/reimbursements - Get all reimbursements with filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      status, 
      category,
      priority,
      requested_by,
      approval_stage,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'created_at',
      sort_direction = 'desc',
      date_from,
      date_to,
      brand_code
    } = req.query;

    let query = supabaseAdmin
      .from('reimbursements_with_details')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    if (priority && priority !== 'all') {
      query = query.eq('priority', priority);
    }

    if (requested_by) {
      query = query.eq('requested_by', requested_by);
    }

    // Visibility enforcement similar to auctions/items
    const { data: vis } = await supabaseAdmin
      .from('global_module_visibility')
      .select('is_public')
      .eq('module', 'reimbursements')
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

    if (approval_stage) {
      switch (approval_stage) {
        case 'director1_pending':
          query = query.eq('director1_approval_status', 'pending');
          break;
        case 'director2_pending':
          query = query.eq('director2_approval_status', 'pending').eq('director1_approval_status', 'approved');
          break;
        case 'accountant_pending':
          query = query.eq('accountant_approval_status', 'pending').eq('director1_approval_status', 'approved').eq('director2_approval_status', 'approved');
          break;
      }
    }

    if (date_from) {
      query = query.gte('payment_date', date_from);
    }

    if (date_to) {
      query = query.lte('payment_date', date_to);
    }

    if (search) {
      query = query.or(
        `reimbursement_number.ilike.%${search}%,title.ilike.%${search}%,description.ilike.%${search}%,vendor_name.ilike.%${search}%`
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

    const { data: reimbursements, error, count } = await query;

    if (error) {
      console.error('Error fetching reimbursements:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch reimbursements',
        details: error.message 
      });
    }

    res.json({
      reimbursements,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error in GET /reimbursements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reimbursements/pending-approvals - Get pending approvals for current user
router.get('/pending-approvals', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { data, error } = await supabaseAdmin
      .rpc('get_pending_approvals_for_user', { user_id: req.user.id });

    if (error) {
      console.error('Error fetching pending approvals:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch pending approvals',
        details: error.message 
      });
    }

    res.json(data);
  } catch (error) {
    console.error('Error in GET /reimbursements/pending-approvals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reimbursements/:id - Get single reimbursement
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements_with_details')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching reimbursement:', error);
      return res.status(404).json({ error: 'Reimbursement not found' });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in GET /reimbursements/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/reimbursements - Create new reimbursement
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userIdInt = parseInt(String(req.user.id), 10);
    const reimbursementData: Reimbursement = {
      ...req.body,
      requested_by: String(userIdInt) as any,
      created_by: String(userIdInt) as any,
      updated_by: String(userIdInt) as any
    };

    // If client provided brand_code, resolve to brand_id; default to MSABER if not set
    const providedBrandCode = (req.body?.brand_code as string | undefined)?.toUpperCase();
    if (providedBrandCode) {
      const { data: brand, error: brandErr } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', providedBrandCode)
        .single();
      if (brand && !brandErr) {
        reimbursementData.brand_id = brand.id as any;
      } else {
        // Fallback to MSABER instead of erroring
        const { data: defaultBrand } = await supabaseAdmin
          .from('brands')
          .select('id')
          .eq('code', 'MSABER')
          .single();
        if (defaultBrand) reimbursementData.brand_id = defaultBrand.id as any;
      }
    } else {
      const { data: defaultBrand } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', 'MSABER')
        .single();
      if (defaultBrand) {
        reimbursementData.brand_id = defaultBrand.id as any;
      }
    }

    // Validate required fields
    if (!reimbursementData.title || !reimbursementData.description || !reimbursementData.total_amount || 
        !reimbursementData.category || !reimbursementData.payment_method || !reimbursementData.payment_date ||
        !reimbursementData.purpose) {
      return res.status(400).json({ 
        error: 'Missing required fields: title, description, total_amount, category, payment_method, payment_date, purpose' 
      });
    }

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .insert([reimbursementData])
      .select()
      .single();

    if (error) {
      console.error('Error creating reimbursement:', error);
      return res.status(500).json({ 
        error: 'Failed to create reimbursement',
        details: error.message 
      });
    }

    res.status(201).json(reimbursement);
  } catch (error) {
    console.error('Error in POST /reimbursements:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reimbursements/:id - Update reimbursement
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const reimbursementData: Partial<Reimbursement> = {
      ...req.body,
      updated_by: req.user.id
    };

    // Remove fields that shouldn't be updated
    delete reimbursementData.id;
    delete reimbursementData.created_by;
    delete reimbursementData.reimbursement_number;

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .update(reimbursementData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating reimbursement:', error);
      return res.status(500).json({ 
        error: 'Failed to update reimbursement',
        details: error.message 
      });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in PUT /reimbursements/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reimbursements/:id/approve-director1 - Director 1 approval
router.put('/:id/approve-director1', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { approved, comments } = req.body;

    const updateData: any = {
      director1_approval_status: approved ? 'approved' : 'rejected',
      director1_approved_by: req.user.id,
      director1_approved_at: new Date().toISOString(),
      director1_comments: comments || null,
      updated_by: req.user.id
    };

    if (!approved) {
      updateData.rejection_reason = comments;
      updateData.rejected_by = req.user.id;
      updateData.rejected_at = new Date().toISOString();
    }

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error processing director1 approval:', error);
      return res.status(500).json({ 
        error: 'Failed to process director1 approval',
        details: error.message 
      });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in PUT /reimbursements/:id/approve-director1:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reimbursements/:id/approve-director2 - Director 2 approval
router.put('/:id/approve-director2', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { approved, comments } = req.body;

    const updateData: any = {
      director2_approval_status: approved ? 'approved' : 'rejected',
      director2_approved_by: req.user.id,
      director2_approved_at: new Date().toISOString(),
      director2_comments: comments || null,
      updated_by: req.user.id
    };

    if (!approved) {
      updateData.rejection_reason = comments;
      updateData.rejected_by = req.user.id;
      updateData.rejected_at = new Date().toISOString();
    }

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error processing director2 approval:', error);
      return res.status(500).json({ 
        error: 'Failed to process director2 approval',
        details: error.message 
      });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in PUT /reimbursements/:id/approve-director2:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reimbursements/:id/approve-accountant - Accountant approval
router.put('/:id/approve-accountant', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { approved, comments, payment_reference } = req.body;

    const updateData: any = {
      accountant_approval_status: approved ? 'approved' : 'rejected',
      accountant_approved_by: req.user.id,
      accountant_approved_at: new Date().toISOString(),
      accountant_comments: comments || null,
      updated_by: req.user.id
    };

    if (approved && payment_reference) {
      updateData.payment_reference = payment_reference;
    }

    if (!approved) {
      updateData.rejection_reason = comments;
      updateData.rejected_by = req.user.id;
      updateData.rejected_at = new Date().toISOString();
    }

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error processing accountant approval:', error);
      return res.status(500).json({ 
        error: 'Failed to process accountant approval',
        details: error.message 
      });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in PUT /reimbursements/:id/approve-accountant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/reimbursements/:id/complete-payment - Complete payment
router.put('/:id/complete-payment', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { payment_reference } = req.body;

    const updateData = {
      status: 'completed',
      payment_completed_at: new Date().toISOString(),
      processed_by: req.user.id,
      processed_at: new Date().toISOString(),
      payment_reference: payment_reference || null,
      updated_by: req.user.id
    };

    const { data: reimbursement, error } = await supabaseAdmin
      .from('reimbursements')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error completing payment:', error);
      return res.status(500).json({ 
        error: 'Failed to complete payment',
        details: error.message 
      });
    }

    res.json(reimbursement);
  } catch (error) {
    console.error('Error in PUT /reimbursements/:id/complete-payment:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reimbursements/:id - Delete reimbursement
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('reimbursements')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting reimbursement:', error);
      return res.status(500).json({ 
        error: 'Failed to delete reimbursement',
        details: error.message 
      });
    }

    res.json({ message: 'Reimbursement deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /reimbursements/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reimbursements/stats - Get reimbursement statistics
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const { category, date_from, date_to } = req.query;

    let query = supabaseAdmin
      .from('reimbursements')
      .select('status, category, total_amount, priority, director1_approval_status, director2_approval_status, accountant_approval_status');

    if (category) {
      query = query.eq('category', category);
    }

    if (date_from) {
      query = query.gte('payment_date', date_from);
    }

    if (date_to) {
      query = query.lte('payment_date', date_to);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching reimbursement stats:', error);
      return res.status(500).json({ error: 'Failed to fetch reimbursement statistics' });
    }

    const stats = {
      total_reimbursements: data.length,
      total_amount: data.reduce((sum, r) => sum + (r.total_amount || 0), 0),
      by_status: data.reduce((acc: any, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {}),
      by_category: data.reduce((acc: any, r) => {
        acc[r.category] = (acc[r.category] || 0) + 1;
        return acc;
      }, {}),
      by_priority: data.reduce((acc: any, r) => {
        acc[r.priority] = (acc[r.priority] || 0) + 1;
        return acc;
      }, {}),
      pending_director1: data.filter(r => r.director1_approval_status === 'pending').length,
      pending_director2: data.filter(r => r.director2_approval_status === 'pending' && r.director1_approval_status === 'approved').length,
      pending_accountant: data.filter(r => r.accountant_approval_status === 'pending' && r.director1_approval_status === 'approved' && r.director2_approval_status === 'approved').length,
      approved_amount: data
        .filter(r => r.status === 'completed')
        .reduce((sum, r) => sum + (r.total_amount || 0), 0)
    };

    res.json(stats);
  } catch (error) {
    console.error('Error in GET /reimbursements/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 