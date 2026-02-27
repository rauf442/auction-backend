// backend/src/routes/public-brands.ts
// Purpose: Public, unauthenticated read-only endpoints for brand information

import express from 'express';
import { supabaseAdmin } from '../utils/supabase';

const router = express.Router();

// GET /api/public/brands/by-code/:code - get public brand info by code
router.get('/by-code/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select(`
        id, code, name, is_active,
        brand_address, contact_email, contact_phone, business_whatsapp_number, website_url,
        privacy_policy, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions,
        logo_url, logo_file_name
      `)
      .eq('code', code.toUpperCase())
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ success: true, brand: data });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// GET /api/public/brands/:id - get public brand info by id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select(`
        id, code, name, is_active,
        brand_address, contact_email, contact_phone, business_whatsapp_number, website_url,
        privacy_policy, terms_and_conditions, buyer_terms_and_conditions, vendor_terms_and_conditions,
        logo_url, logo_file_name
      `)
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    return res.json({ success: true, brand: data });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

export default router;
