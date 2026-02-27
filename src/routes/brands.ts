// backend/src/routes/brands.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import { EmailService } from '../utils/email-service';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();

router.use(authMiddleware);

// GET /api/brands - list active brands
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch brands', details: error.message });
    }

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/brands/by-code/:code - get brand by code
router.get('/by-code/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('code', code.toUpperCase())
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/brands/:id - get brand by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// PUT /api/brands/:id - Update basic brand information (name, code, is_active)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    console.log('🔧 Brand update request:', {
      id: req.params.id,
      body: req.body,
      user: req.user
    });

    if (!req.user || req.user.role !== 'super_admin') {
      console.log('❌ Forbidden: User role check failed', { user: req.user });
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id } = req.params;
    const { name, code, is_active } = req.body;

    // Validate required fields
    if (!name || !code) {
      console.log('❌ Validation failed: Missing required fields', { name, code });
      return res.status(400).json({ error: 'name and code are required' });
    }

    console.log('🔄 Updating brand in database:', { id, name, code: code.toUpperCase(), is_active });

    const { data, error } = await supabaseAdmin
      .from('brands')
      .update({
        name,
        code: code.toUpperCase(),
        is_active,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.log('❌ Database error:', error);
      return res.status(500).json({
        error: 'Failed to update brand',
        details: error.message
      });
    }

    console.log('✅ Brand updated successfully:', data);
    res.json({
      success: true,
      message: 'Brand updated successfully',
      data
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// PUT /api/brands/:id/compliance - Update brand compliance settings
router.put('/:id/compliance', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      brand_address,
      contact_email,
      contact_phone,
      business_whatsapp_number,
      website_url,
      privacy_policy,
      terms_and_conditions,
      buyer_terms_and_conditions,
      vendor_terms_and_conditions,
      company_registration,
      vat_number,
      eori_number,
      business_license,
      compliance_notes,
      bank_accounts,
      winning_bid_email_subject,
      winning_bid_email_body,
      payment_confirmation_email_subject,
      payment_confirmation_email_body,
      shipping_confirmation_email_subject,
      shipping_confirmation_email_body,
      vendor_paid_acknowledgement_email_subject,
      vendor_paid_acknowledgement_email_body,
      vendor_post_sale_invoice_email_subject,
      vendor_post_sale_invoice_email_body
    } = req.body;

    const { data, error } = await supabaseAdmin
      .from('brands')
      .update({
        brand_address,
        contact_email,
        contact_phone,
        business_whatsapp_number,
        website_url,
        privacy_policy,
        terms_and_conditions,
        buyer_terms_and_conditions,
        vendor_terms_and_conditions,
        company_registration,
        vat_number,
        eori_number,
        business_license,
        compliance_notes,
        bank_accounts,
        winning_bid_email_subject,
        winning_bid_email_body,
        payment_confirmation_email_subject,
        payment_confirmation_email_body,
        shipping_confirmation_email_subject,
        shipping_confirmation_email_body,
        vendor_paid_acknowledgement_email_subject,
        vendor_paid_acknowledgement_email_body,
        vendor_post_sale_invoice_email_subject,
        vendor_post_sale_invoice_email_body,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: 'Failed to update brand compliance settings',
        details: error.message
      });
    }

    res.json({
      success: true,
      message: 'Brand compliance settings updated successfully',
      data
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/brands/:id/compliance - Get brand compliance settings
router.get('/:id/compliance', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    console.log('🔧 Fetching brand compliance data for ID:', id);

    const { data, error } = await supabaseAdmin
      .from('brands')
      .select(`
        id, code, name,
        brand_address, contact_email, contact_phone, business_whatsapp_number, website_url,
        privacy_policy, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions,
        company_registration, vat_number, eori_number, business_license, compliance_notes,
        bank_accounts, logo_url, logo_file_name, logo_uploaded_at,
        winning_bid_email_subject, winning_bid_email_body,
        payment_confirmation_email_subject, payment_confirmation_email_body,
        shipping_confirmation_email_subject, shipping_confirmation_email_body,
        vendor_paid_acknowledgement_email_subject, vendor_paid_acknowledgement_email_body,
        vendor_post_sale_invoice_email_subject, vendor_post_sale_invoice_email_body
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('❌ Database error fetching brand compliance:', error);
      return res.status(500).json({
        error: 'Failed to fetch brand compliance data',
        details: error.message
      });
    }

    if (!data) {
      console.log('⚠️ Brand not found:', id);
      return res.status(404).json({ error: 'Brand not found' });
    }

    console.log('✅ Brand compliance data fetched successfully');
    res.json({ success: true, data });
  } catch (err: any) {
    console.error('❌ Error in compliance endpoint:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});


// Admin endpoints for super-admin to manage brands and visibility
router.post('/', async (req: any, res: any) => {
  try {
    if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    const { code, name, is_active = true } = req.body as { code: string; name: string; is_active?: boolean };
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const { data, error } = await supabaseAdmin.from('brands').insert([{ code: code.toUpperCase(), name, is_active }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

router.post('/visibility', async (req: any, res: any) => {
  try {
    if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
    const { module, is_public } = req.body as { module: string; is_public: boolean };
    if (!module) return res.status(400).json({ error: 'module required' });
    const { data, error } = await supabaseAdmin.from('global_module_visibility').upsert({ module, is_public }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

router.get('/visibility/:module', async (req: any, res: any) => {
  try {
    const { module } = req.params;
    const { data, error } = await supabaseAdmin.from('global_module_visibility').select('*').eq('module', module).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// POST /api/brands/:id/email-preview - Preview email template with variables
router.post('/:id/email-preview', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type, variables } = req.body;

    console.log('📧 Email preview request:', { brandId: id, type, variables });

    if (!type || !variables) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'Both type and variables are required'
      });
    }

    // Validate brand exists
    const brandCheck = await supabaseAdmin
      .from('brands')
      .select('id, name')
      .eq('id', id)
      .single();

    if (!brandCheck.data) {
      return res.status(404).json({
        error: 'Brand not found',
        details: `No brand found with ID ${id}`
      });
    }

    const preview = await EmailService.previewEmailTemplate(parseInt(id), type, variables);

    if (!preview) {
      return res.status(500).json({
        error: 'Preview generation failed',
        details: 'Unable to generate email preview with provided templates and variables'
      });
    }

    console.log('✅ Email preview generated successfully');
    res.json({
      success: true,
      subject: preview.subject,
      body: preview.body
    });
  } catch (error: any) {
    console.error('❌ Email preview error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

export default router;

