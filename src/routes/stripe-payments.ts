// backend/src/routes/stripe-payments.ts
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabaseAdmin } from '../utils/supabase';
import Stripe from 'stripe';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();

// Helper function to get Stripe instance for brand
async function getStripeInstance(brandId: string): Promise<Stripe | null> {
  try {
    const { data: credentials, error } = await supabaseAdmin
      .from('platform_credentials')
      .select('secret_value')
      .eq('brand_id', brandId)
      .eq('platform', 'STRIPE')
      .eq('is_active', true)
      .single();

    if (error || !credentials?.secret_value) {
      return null;
    }

    return new Stripe(credentials.secret_value, {
      apiVersion: '2025-08-27.basil'
    });
  } catch (error) {
    console.error('Error getting Stripe instance:', error);
    return null;
  }
}

// POST /api/stripe-payments/save-credentials - Save Stripe credentials
router.post('/save-credentials', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, publishableKey, secretKey, webhookSecret } = req.body;

    if (!brandId || !publishableKey || !secretKey) {
      return res.status(400).json({ error: 'Missing required fields: brandId, publishableKey, secretKey' });
    }

    // Only super admin can save credentials
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Test the secret key by creating a Stripe instance
    try {
      const stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' });
      await stripe.accounts.retrieve(); // Test API call
    } catch (error) {
      return res.status(400).json({ error: 'Invalid Stripe secret key' });
    }

    // Save/update credentials in platform_credentials table
    const { error: upsertError } = await supabaseAdmin
      .from('platform_credentials')
      .upsert({
        brand_id: brandId,
        platform: 'STRIPE',
        key_id: publishableKey,
        secret_value: secretKey,
        additional: webhookSecret ? { webhook_secret: webhookSecret } : {},
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'brand_id,platform'
      });

    if (upsertError) {
      console.error('Error saving Stripe credentials:', upsertError);
      return res.status(500).json({ error: 'Failed to save credentials' });
    }

    res.json({ success: true, message: 'Stripe credentials saved successfully' });
  } catch (error) {
    console.error('Error in POST /stripe-payments/save-credentials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stripe-payments/credentials/:brandId - Get Stripe credentials (excluding secrets)
router.get('/credentials/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const { data: credentials, error } = await supabaseAdmin
      .from('platform_credentials')
      .select('key_id, additional, is_active, updated_at')
      .eq('brand_id', brandId)
      .eq('platform', 'STRIPE')
      .single();

    if (error || !credentials) {
      return res.json({ configured: false });
    }

    // Return credentials without sensitive data
    res.json({
      configured: true,
      publishableKey: credentials.key_id,
      hasWebhookSecret: !!(credentials.additional?.webhook_secret),
      isActive: credentials.is_active,
      lastUpdated: credentials.updated_at
    });
  } catch (error) {
    console.error('Error getting Stripe credentials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/stripe-payments/test-connection/:brandId - Test Stripe connection
router.post('/test-connection/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const stripe = await getStripeInstance(brandId);
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured for this brand' });
    }

    // Test the connection by retrieving account info
    const account = await stripe.accounts.retrieve();
    
    res.json({ 
      success: true, 
      message: `Connected to Stripe account: ${account.business_profile?.name || account.id}`,
      accountId: account.id
    });
  } catch (error) {
    console.error('Error testing Stripe connection:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Connection test failed' 
    });
  }
});

// POST /api/stripe-payments/create-payment-link - Create a payment link
router.post('/create-payment-link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, amount, title, description } = req.body;

    if (!brandId || !amount || !title) {
      return res.status(400).json({ error: 'Missing required fields: brandId, amount, title' });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const stripe = await getStripeInstance(brandId);
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured for this brand' });
    }

    // Create a product
    const product = await stripe.products.create({
      name: title,
      description: description || undefined
    });

    // Create a price for the product (in pence for GBP)
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(amount * 100), // Convert to pence
      currency: 'gbp'
    });

    // Create a payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: price.id,
          quantity: 1
        }
      ],
      metadata: {
        brand_id: brandId,
      }
    });

    res.json({
      success: true,
      paymentLink: {
        id: paymentLink.id,
        url: paymentLink.url,
        amount: amount,
        title: title,
        description: description,
        status: paymentLink.active ? 'active' : 'inactive',
        created: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error creating Stripe payment link:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

// GET /api/stripe-payments/payment-status/:brandId/:paymentId - Get payment status
router.get('/payment-status/:brandId/:paymentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, paymentId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const stripe = await getStripeInstance(brandId);
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured for this brand' });
    }

    // Get payment link details
    const paymentLink = await stripe.paymentLinks.retrieve(paymentId);

    // Get recent checkout sessions for this payment link
    const sessions = await stripe.checkout.sessions.list({
      payment_link: paymentId,
      limit: 10
    });

    let totalReceived = 0;
    let latestStatus = 'unpaid';

    for (const session of sessions.data) {
      if (session.payment_status === 'paid') {
        totalReceived += session.amount_total || 0;
        latestStatus = 'paid';
      }
    }

    res.json({
      success: true,
      payment: {
        id: paymentLink.id,
        status: latestStatus,
        amount_received: totalReceived / 100, // Convert from pence to pounds
        amount_total: (paymentLink.line_items?.data[0]?.price?.unit_amount || 0) / 100,
        payment_status: latestStatus
      }
    });
  } catch (error) {
    console.error('Error getting Stripe payment status:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

export default router;
