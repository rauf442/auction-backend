// backend/src/routes/platform-credentials.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

const router = express.Router();
router.use(authMiddleware);

// List credentials with optional brand/platform filters
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_code, platform } = req.query as { brand_code?: string; platform?: string };
    let brandId: string | undefined;
    if (brand_code) {
      const { data: b, error: be } = await supabaseAdmin
        .from('brands')
        .select('id, code, name')
        .eq('code', (brand_code as string).toUpperCase())
        .single();
      if (be || !b) return res.status(404).json({ error: 'Brand not found' });
      brandId = b.id as any;
    }

    let query = supabaseAdmin.from('platform_credentials').select('*');
    if (brandId) query = query.eq('brand_id', brandId);
    if (platform) query = query.eq('platform', platform as string);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch credentials', details: error.message });
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Upsert credentials per brand/platform
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_code, platform, key_id, secret_value, additional, is_active } = req.body as {
      brand_code: string; platform: string; key_id?: string; secret_value?: string; additional?: any; is_active?: boolean;
    };

    if (!brand_code || !platform) {
      return res.status(400).json({ error: 'brand_code and platform are required' });
    }

    const { data: brand, error: brandErr } = await supabaseAdmin
      .from('brands')
      .select('id')
      .eq('code', brand_code.toUpperCase())
      .single();
    if (brandErr || !brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const payload = {
      brand_id: brand.id,
      platform,
      key_id: key_id || null,
      secret_value: secret_value || null,
      additional: additional || null,
      is_active: typeof is_active === 'boolean' ? is_active : true
    };

    const { data, error } = await supabaseAdmin
      .from('platform_credentials')
      .upsert(payload, { onConflict: 'brand_id,platform' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to save credentials', details: error.message });
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Test SMTP/Instagram connectivity using saved credentials
router.post('/test', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_code, platform } = req.body as { brand_code: string; platform: 'email_smtp' | 'instagram' };
    if (!brand_code || !platform) return res.status(400).json({ error: 'brand_code and platform required' });
    const { data: brand, error: brandErr } = await supabaseAdmin
      .from('brands')
      .select('id')
      .eq('code', brand_code.toUpperCase())
      .single();
    if (brandErr || !brand) return res.status(404).json({ error: 'Brand not found' });

    const { data: cred, error: credErr } = await supabaseAdmin
      .from('platform_credentials')
      .select('*')
      .eq('brand_id', brand.id as any)
      .eq('platform', platform)
      .single();
    if (credErr || !cred) return res.status(404).json({ error: 'Credentials not found' });

    if (platform === 'email_smtp') {
      let nodemailer: any
      try { nodemailer = require('nodemailer') } catch {}
      if (!nodemailer) return res.status(500).json({ error: 'Nodemailer not available on server' });
      const smtpCfg = cred.additional || {}
      const transporter = nodemailer.createTransport({
        host: smtpCfg.host,
        port: smtpCfg.port || 587,
        secure: !!smtpCfg.secure,
        auth: { user: cred.key_id, pass: cred.secret_value }
      })
      try {
        await transporter.verify();
        return res.json({ success: true, message: 'SMTP connection verified' })
      } catch (e: any) {
        return res.status(400).json({ error: 'SMTP verification failed', details: e.message })
      }
    }

    if (platform === 'instagram') {
      const igUserId = cred.key_id
      const accessToken = cred.secret_value
      const resp = await fetch(`https://graph.facebook.com/v19.0/${igUserId}?fields=id,username&access_token=${encodeURIComponent(accessToken)}`)
      const json = await resp.json()
      if (!resp.ok) return res.status(400).json({ error: 'Instagram test failed', details: json })
      return res.json({ success: true, data: json })
    }

    return res.status(400).json({ error: 'Unsupported platform' })
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Get credentials for brand/platform
router.get('/:brand_code/:platform', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_code, platform } = req.params;
    const { data: b, error: be } = await supabaseAdmin
      .from('brands')
      .select('id, code, name')
      .eq('code', brand_code.toUpperCase())
      .single();
    if (be || !b) return res.status(404).json({ error: 'Brand not found' });

    const { data, error } = await supabaseAdmin
      .from('platform_credentials')
      .select('*')
      .eq('brand_id', b.id as any)
      .eq('platform', platform)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Credentials not found' });
    res.json({ success: true, data, brand: { code: b.code, name: b.name } });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

export default router;


