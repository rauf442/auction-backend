// backend/src/routes/xero-payments.ts
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { XeroService } from '../utils/xero-client';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();

// GET /api/xero-payments/auth-url/:brandId - Get Xero authorization URL
router.get('/auth-url/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const redirectUri = XeroService.getRedirectUri();
    const authUrl = await XeroService.getAuthorizationUrl(brandId);
    
    if (!authUrl) {
      return res.status(400).json({ 
        error: 'Could not generate Xero authorization URL. Please check Xero credentials.',
        redirectUri: redirectUri,
        instructions: `Make sure this redirect URI is configured in your Xero app: ${redirectUri}`,
        xeroPortalUrl: 'https://developer.xero.com/app/my-apps'
      });
    }

    res.json({ authUrl, redirectUri });
  } catch (error) {
    console.error('Error generating Xero auth URL:', error);
    const redirectUri = XeroService.getRedirectUri();
    res.status(500).json({ 
      error: 'Internal server error',
      redirectUri: redirectUri,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/xero-payments/callback - Handle Xero OAuth callback
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    // Log all query parameters for debugging
    const codeStr = Array.isArray(code) ? code[0] : (typeof code === 'string' ? code : '');
    const stateStr = Array.isArray(state) ? state[0] : (typeof state === 'string' ? state : '');
    const errorStr = Array.isArray(error) ? error[0] : (typeof error === 'string' ? error : '');
    
    console.log('[CALLBACK] Received callback with query params:', {
      code: codeStr && typeof codeStr === 'string' ? `${codeStr.substring(0, 20)}...` : 'missing',
      state: stateStr || 'missing',
      error: errorStr || 'none',
      allParams: Object.keys(req.query)
    });

    // Return HTML page that closes popup and notifies parent window
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    // Use '*' for origin to allow any origin (parent window will verify)
    const postMessageTarget = '*';
    
    if (error) {
      console.error('[CALLBACK] OAuth error received:', error);
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Xero Connection</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'xero_oauth_error', error: '${error}' }, '${postMessageTarget}');
              setTimeout(() => window.close(), 100);
            } else {
              window.location.href = '${frontendUrl}/settings/platforms?xero_error=${error}';
            }
          </script>
          <p>Redirecting...</p>
        </body>
        </html>
      `;
      return res.send(html);
    }

    // Extract and validate parameters
    const authCodeRaw = Array.isArray(code) ? code[0] : code;
    const brandIdRaw = Array.isArray(state) ? state[0] : state;
    const authCode = typeof authCodeRaw === 'string' ? authCodeRaw : '';
    const brandId = typeof brandIdRaw === 'string' ? brandIdRaw : '';
    
    if (!authCode || !brandId) {
      console.error('[CALLBACK] Missing required parameters:', {
        hasCode: !!authCode,
        hasState: !!brandId,
        codeType: typeof code,
        stateType: typeof state,
        queryKeys: Object.keys(req.query)
      });
      
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Xero Connection</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'xero_oauth_error', error: 'missing_params', details: { hasCode: ${!!authCode}, hasState: ${!!brandId} } }, '${postMessageTarget}');
              setTimeout(() => window.close(), 100);
            } else {
              window.location.href = '${frontendUrl}/settings/platforms?xero_error=missing_params';
            }
          </script>
          <p>Redirecting...</p>
        </body>
        </html>
      `;
      return res.send(html);
    }
    
    console.log('[CALLBACK] Processing callback for brand:', brandId);
    console.log('[CALLBACK] Auth code received:', authCode.substring(0, 20) + '...');
    
    // Build the full callback URL with query parameters for apiCallback
    // apiCallback expects the full URL with query string, not just the code
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const callbackUrl = `${baseUrl}${req.originalUrl}`;
    console.log('[CALLBACK] Full callback URL:', callbackUrl.substring(0, 200) + '...');

    const success = await XeroService.handleCallback(brandId, callbackUrl);

    if (success) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Xero Connection</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'xero_oauth_success', brandId: '${brandId}' }, '${postMessageTarget}');
              setTimeout(() => window.close(), 100);
            } else {
              window.location.href = '${frontendUrl}/settings/platforms?xero_success=true';
            }
          </script>
          <p>Connection successful! Closing window...</p>
        </body>
        </html>
      `;
      return res.send(html);
    } else {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Xero Connection</title>
        </head>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'xero_oauth_error', error: 'callback_failed' }, '${postMessageTarget}');
              setTimeout(() => window.close(), 100);
            } else {
              window.location.href = '${frontendUrl}/settings/platforms?xero_error=callback_failed';
            }
          </script>
          <p>Redirecting...</p>
        </body>
        </html>
      `;
      return res.send(html);
    }
  } catch (error) {
    console.error('Error handling Xero callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const postMessageTarget = '*';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Xero Connection</title>
      </head>
      <body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'xero_oauth_error', error: 'server_error' }, '${postMessageTarget}');
            setTimeout(() => window.close(), 100);
          } else {
            window.location.href = '${frontendUrl}/settings/platforms?xero_error=server_error';
          }
        </script>
        <p>Redirecting...</p>
      </body>
      </html>
    `;
    return res.send(html);
  }
});

// POST /api/xero-payments/create-payment-link - Create a payment link
router.post('/create-payment-link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, amount, description, customerEmail } = req.body;

    if (!brandId || !amount || !description) {
      return res.status(400).json({ error: 'Missing required fields: brandId, amount, description' });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const paymentLink = await XeroService.createPaymentLink(
      brandId,
      parseFloat(amount),
      description,
      customerEmail
    );

    res.json({
      success: true,
      paymentLink
    });
  } catch (error) {
    console.error('Error creating Xero payment link:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

// GET /api/xero-payments/invoice-status/:brandId/:invoiceId - Get invoice status
router.get('/invoice-status/:brandId/:invoiceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, invoiceId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const invoiceStatus = await XeroService.getInvoiceStatus(brandId, invoiceId);

    res.json({
      success: true,
      invoice: invoiceStatus
    });
  } catch (error) {
    console.error('Error getting Xero invoice status:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

// POST /api/xero-payments/refresh-token/:brandId - Refresh access token
router.post('/refresh-token/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const success = await XeroService.refreshAccessToken(brandId);

    if (success) {
      res.json({ success: true, message: 'Token refreshed successfully' });
    } else {
      res.status(400).json({ error: 'Failed to refresh token' });
    }
  } catch (error) {
    console.error('Error refreshing Xero token:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/xero-payments/save-credentials - Save Xero credentials
router.post('/save-credentials', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, clientId, clientSecret } = req.body;

    if (!brandId || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'Missing required fields: brandId, clientId, clientSecret' });
    }

    // Only super admin or brand admin can save credentials
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const success = await XeroService.saveXeroCredentials(brandId, {
      brand_id: brandId,
      client_id: clientId,
      client_secret: clientSecret
    });

    if (success) {
      res.json({ success: true, message: 'Xero credentials saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  } catch (error) {
    console.error('Error saving Xero credentials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/xero-payments/credentials/:brandId - Get Xero credentials (excluding secrets)
router.get('/credentials/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const credentials = await XeroService.getXeroCredentials(brandId);

    if (!credentials) {
      return res.json({ configured: false });
    }

    // Return credentials without sensitive data
    res.json({
      configured: true,
      clientId: credentials.client_id,
      tenantName: credentials.tenant_name,
      hasTokens: !!(credentials.access_token && credentials.refresh_token),
      tokenExpiresAt: credentials.token_expires_at
    });
  } catch (error) {
    console.error('Error getting Xero credentials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/xero-payments/redirect-uri - Get the redirect URI that should be configured in Xero
router.get('/redirect-uri', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const redirectUri = XeroService.getRedirectUri();
    res.json({ 
      redirectUri,
      instructions: `Add this exact URI to your Xero app's OAuth 2.0 redirect URIs: ${redirectUri}`,
      xeroPortalUrl: 'https://developer.xero.com/app/my-apps'
    });
  } catch (error) {
    console.error('Error getting redirect URI:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
