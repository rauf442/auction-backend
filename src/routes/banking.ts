// backend/src/routes/banking.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import { StandardResponse } from '../utils/apiResponse';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();
router.use(authMiddleware);

interface BankingTransaction {
  id?: string;
  brand_id?: string;
  transaction_number?: string;
  type: 'deposit' | 'withdrawal' | 'transfer' | 'payment' | 'refund' | 'fee' | 'commission';
  category?: string;
  description: string;
  amount: number;
  bank_account?: string;
  reference_number?: string;
  payment_method?: 'bank_transfer' | 'credit_card' | 'debit_card' | 'cheque' | 'cash' | 'paypal' | 'stripe';
  transaction_date?: string;
  value_date?: string;
  currency?: string;
  exchange_rate?: number;
  client_id?: string;
  auction_id?: string;
  item_id?: string;
  refund_id?: string;
  status?: 'pending' | 'cleared' | 'failed' | 'cancelled' | 'reconciled';
  is_reconciled?: boolean;
  reconciled_date?: string;
  reconciled_by?: string;
  running_balance?: number;
  account_balance_before?: number;
  account_balance_after?: number;
  external_transaction_id?: string;
  external_batch_id?: string;
  bank_fees?: number;
  processing_fees?: number;
  net_amount?: number;
  internal_notes?: string;
  external_notes?: string;
  attachment_urls?: string[];
  metadata?: any;
}

// GET /api/banking - Get all banking transactions with filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      status, 
      type,
      bank_account,
      client_id,
      auction_id,
      is_reconciled,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'transaction_date',
      sort_direction = 'desc',
      brand_code,
      date_from,
      date_to
    } = req.query;

    let query = supabaseAdmin
      .from('banking_transactions_with_details')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (type && type !== 'all') {
      query = query.eq('type', type);
    }

    if (bank_account) {
      query = query.eq('bank_account', bank_account);
    }

    if (client_id) {
      query = query.eq('client_id', client_id);
    }

    if (auction_id) {
      query = query.eq('auction_id', auction_id);
    }

    if (is_reconciled !== undefined) {
      query = query.eq('is_reconciled', is_reconciled === 'true');
    }

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

    if (date_from) {
      query = query.gte('transaction_date', date_from);
    }

    if (date_to) {
      query = query.lte('transaction_date', date_to);
    }

    if (search) {
      query = query.or(
        `transaction_number.ilike.%${search}%,description.ilike.%${search}%,reference_number.ilike.%${search}%,external_transaction_id.ilike.%${search}%`
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

    const { data: transactions, error, count } = await query;

    if (error) {
      console.error('Error fetching banking transactions:', error);
      return StandardResponse.internalError(res, 'Failed to fetch banking transactions', error.message);
    }

    return StandardResponse.success(res, transactions, 'Banking transactions fetched successfully', {
      page: pageNum,
      limit: limitNum,
      total: count,
      pages: Math.ceil((count || 0) / limitNum)
    });
  } catch (error: any) {
    console.error('Error in GET /banking:', error);
    return StandardResponse.internalError(res, 'Internal server error', error.message);
  }
});

// GET /api/banking/:id - Get single banking transaction
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: transaction, error } = await supabaseAdmin
      .from('banking_transactions_with_details')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching banking transaction:', error);
      return res.status(404).json({ error: 'Banking transaction not found' });
    }

    res.json(transaction);
  } catch (error) {
    console.error('Error in GET /banking/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/banking - Create new banking transaction
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const transactionData: BankingTransaction = {
      ...req.body,
    };

    // Resolve brand_code to brand_id or default MSABER
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
      (transactionData as any).brand_id = brand.id;
    } else {
      const { data: defaultBrand } = await supabaseAdmin
        .from('brands')
        .select('id')
        .eq('code', 'MSABER')
        .single();
      if (defaultBrand) {
        (transactionData as any).brand_id = defaultBrand.id;
      }
    }

    // Validate required fields
    if (!transactionData.description || !transactionData.amount || !transactionData.type) {
      return res.status(400).json({ 
        error: 'Missing required fields: description, amount, type' 
      });
    }

    // Clean up UUID fields
    if (transactionData.client_id === '') transactionData.client_id = undefined;
    if (transactionData.auction_id === '') transactionData.auction_id = undefined;
    if (transactionData.item_id === '') transactionData.item_id = undefined;
    if (transactionData.refund_id === '') transactionData.refund_id = undefined;
    if (transactionData.reconciled_by === '') transactionData.reconciled_by = undefined;

    const { data: transaction, error } = await supabaseAdmin
      .from('banking_transactions')
      .insert([transactionData])
      .select()
      .single();

    if (error) {
      console.error('Error creating banking transaction:', error);
      return res.status(500).json({ 
        error: 'Failed to create banking transaction',
        details: error.message 
      });
    }

    res.status(201).json(transaction);
  } catch (error) {
    console.error('Error in POST /banking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/banking/:id - Update banking transaction
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const transactionData: Partial<BankingTransaction> = {
      ...req.body,
    };

    // Remove fields that shouldn't be updated
    delete transactionData.id;
    delete transactionData.transaction_number;

    // Clean up UUID fields
    if (transactionData.client_id === '') transactionData.client_id = undefined;
    if (transactionData.auction_id === '') transactionData.auction_id = undefined;
    if (transactionData.item_id === '') transactionData.item_id = undefined;
    if (transactionData.refund_id === '') transactionData.refund_id = undefined;
    if (transactionData.reconciled_by === '') transactionData.reconciled_by = undefined;

    const { data: transaction, error } = await supabaseAdmin
      .from('banking_transactions')
      .update(transactionData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating banking transaction:', error);
      return res.status(500).json({ 
        error: 'Failed to update banking transaction',
        details: error.message 
      });
    }

    res.json(transaction);
  } catch (error) {
    console.error('Error in PUT /banking/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/banking/:id/reconcile - Reconcile banking transaction
router.put('/:id/reconcile', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { reconciled_balance, notes } = req.body;

    const updateData: any = {
      is_reconciled: true,
      reconciled_date: new Date().toISOString(),
      reconciled_by: req.user.id,
      status: 'reconciled',
      internal_notes: notes || null,
    };

    if (reconciled_balance !== undefined) {
      updateData.running_balance = reconciled_balance;
    }

    const { data: transaction, error } = await supabaseAdmin
      .from('banking_transactions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error reconciling banking transaction:', error);
      return res.status(500).json({ 
        error: 'Failed to reconcile banking transaction',
        details: error.message 
      });
    }

    res.json(transaction);
  } catch (error) {
    console.error('Error in PUT /banking/:id/reconcile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/banking/:id - Delete banking transaction
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('banking_transactions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting banking transaction:', error);
      return res.status(500).json({ 
        error: 'Failed to delete banking transaction',
        details: error.message 
      });
    }

    res.json({ message: 'Banking transaction deleted successfully' });
  } catch (error) {
    console.error('Error in DELETE /banking/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/banking/stats - Get banking statistics
router.get('/api/stats', async (req: AuthRequest, res: Response) => {
  try {
    const { bank_account, date_from, date_to } = req.query;

    let query = supabaseAdmin
      .from('banking_transactions')
      .select('type, amount, status, currency, transaction_date, is_reconciled');

    if (bank_account) {
      query = query.eq('bank_account', bank_account);
    }

    if (date_from) {
      query = query.gte('transaction_date', date_from);
    }

    if (date_to) {
      query = query.lte('transaction_date', date_to);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching banking stats:', error);
      return res.status(500).json({ error: 'Failed to fetch banking statistics' });
    }

    const stats = {
      total_transactions: data.length,
      total_credits: data
        .filter(t => ['deposit', 'payment'].includes(t.type))
        .reduce((sum, t) => sum + (t.amount || 0), 0),
      total_debits: data
        .filter(t => ['withdrawal', 'refund', 'fee'].includes(t.type))
        .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0),
      by_status: data.reduce((acc: any, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      }, {}),
      by_type: data.reduce((acc: any, t) => {
        acc[t.type] = (acc[t.type] || 0) + 1;
        return acc;
      }, {}),
      reconciled_count: data.filter(t => t.is_reconciled).length,
      unreconciled_count: data.filter(t => !t.is_reconciled).length,
      pending_amount: data
        .filter(t => t.status === 'pending')
        .reduce((sum, t) => sum + (t.amount || 0), 0)
    };

    res.json(stats);
  } catch (error) {
    console.error('Error in GET /banking/stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/banking/accounts - Get list of bank accounts
router.get('/api/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('banking_transactions')
      .select('bank_account')
      .not('bank_account', 'is', null);

    if (error) {
      console.error('Error fetching bank accounts:', error);
      return res.status(500).json({ error: 'Failed to fetch bank accounts' });
    }

    const uniqueAccounts = [...new Set(data.map(t => t.bank_account))].filter(Boolean);
    res.json(uniqueAccounts);
  } catch (error) {
    console.error('Error in GET /banking/accounts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 