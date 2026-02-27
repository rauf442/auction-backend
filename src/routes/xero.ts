// backend/src/routes/xero.ts
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

// Get authorization URL to start OAuth flow
router.get('/auth/url/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    // Check user permissions
    if (req.user?.role !== 'super_admin') {
      // Additional brand access check can be added here
    }

    const authUrl = await XeroService.getAuthorizationUrl(brandId);
    
    if (!authUrl) {
      return res.status(400).json({ error: 'Could not generate authorization URL. Please check Xero credentials.' });
    }

    res.json({ success: true, authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// Handle OAuth callback
router.get('/auth/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/platforms?xero_error=${error}`);
    }

    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/platforms?xero_error=missing_params`);
    }

    // Extract brand ID from state (you might want to encode this better)
    const brandId = state as string;
    
    // Build the full callback URL with query parameters for apiCallback
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const callbackUrl = `${baseUrl}${req.originalUrl}`;

    const success = await XeroService.handleCallback(brandId, callbackUrl);

    if (success) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/platforms?xero_success=true`);
    } else {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/platforms?xero_error=callback_failed`);
    }
  } catch (error) {
    console.error('Error handling Xero callback:', error);
    res.redirect(`${process.env.FRONTEND_URL}/settings/platforms?xero_error=server_error`);
  }
});

// Update tenant information for a brand
router.post('/update-tenant/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check user permissions
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const success = await XeroService.updateTenantInfo(brandId);

    if (success) {
      res.json({ success: true, message: 'Tenant information updated successfully' });
    } else {
      res.status(400).json({ error: 'Failed to update tenant information' });
    }
  } catch (error) {
    console.error('Error updating tenant info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manually set tenant information for a brand
router.post('/set-tenant/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    const { tenantId, tenantName } = req.body;

    if (!tenantId || !tenantName) {
      return res.status(400).json({ error: 'Missing required fields: tenantId, tenantName' });
    }

    // Check user permissions
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const success = await XeroService.setTenantInfo(brandId, tenantId, tenantName);

    if (success) {
      res.json({ success: true, message: 'Tenant information set successfully' });
    } else {
      res.status(400).json({ error: 'Failed to set tenant information' });
    }
  } catch (error) {
    console.error('Error setting tenant info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Clear Xero credentials for a brand (force reconnection)
router.post('/clear-credentials/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;

    // Check user permissions
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const success = await XeroService.clearXeroCredentials(brandId);

    if (success) {
      res.json({
        success: true,
        message: 'Xero credentials cleared successfully. User must reconnect their Xero account.',
        requiresReconnection: true
      });
    } else {
      res.status(400).json({ error: 'Failed to clear Xero credentials' });
    }
  } catch (error) {
    console.error('Error clearing Xero credentials:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create invoice in Xero and get payment link
router.post('/invoices', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const {
      brandId,
      amount,
      description,
      customerEmail
    } = req.body;

    if (!brandId || !amount || !description) {
      return res.status(400).json({ 
        error: 'Missing required fields: brandId, amount, description' 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const result = await XeroService.createPaymentLink(
      brandId,
      parseFloat(amount),
      description,
      customerEmail
    );

    res.json({
      success: true,
      invoice: result
    });
  } catch (error) {
    console.error('Error creating Xero invoice:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create invoice in Xero' });
  }
});

// Get invoice status from Xero
router.get('/invoices/:brandId/:invoiceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, invoiceId } = req.params;
    
    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const invoice = await XeroService.getInvoiceStatus(brandId, invoiceId);
    
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json({
      success: true,
      invoice
    });
  } catch (error) {
    console.error('Error fetching Xero invoice:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch invoice from Xero' });
  }
});

// Create payment link for existing invoice
router.post('/invoices/:brandId/:invoiceId/payment-link', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, invoiceId } = req.params;
    
    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    // Get invoice details to create payment link
    const invoice = await XeroService.getInvoiceStatus(brandId, invoiceId);
    
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // For existing invoices, the payment URL is typically part of the invoice data
    const paymentUrl = `https://go.xero.com/organisationlogin/default.aspx?shortcode=${brandId}&redirecturl=/AccountsReceivable/Edit.aspx?InvoiceID=${invoiceId}`;
    
    res.json({
      success: true,
      paymentLink: {
        invoiceId,
        paymentUrl,
        amount: invoice.total,
        status: invoice.status
      }
    });
  } catch (error) {
    console.error('Error creating payment link:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create payment link' });
  }
});

// Get Xero connection status
router.get('/status/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const credentials = await XeroService.getXeroCredentials(brandId);
    
    res.json({
      success: true,
      connected: !!(credentials && credentials.access_token),
      credentials: credentials ? {
        tenant_name: credentials.tenant_name,
        hasTokens: !!(credentials.access_token && credentials.refresh_token),
        tokenExpiresAt: credentials.token_expires_at
      } : null
    });
  } catch (error) {
    console.error('Error checking Xero status:', error);
    res.status(500).json({ error: 'Failed to check Xero status' });
  }
});

// Refresh access token
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

// Disconnect Xero integration (deactivate credentials)
router.post('/disconnect/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    // Check if user has access to this brand
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    // Set credentials as inactive
    const credentials = await XeroService.getXeroCredentials(brandId);
    if (credentials) {
      await XeroService.saveXeroCredentials(brandId, {
        ...credentials,
        access_token: undefined,
        refresh_token: undefined,
        token_expires_at: undefined
      });
    }
    
    res.json({
      success: true,
      message: 'Xero integration disconnected'
    });
  } catch (error) {
    console.error('Error disconnecting Xero:', error);
    res.status(500).json({ error: 'Failed to disconnect Xero' });
  }
});

// Get Tax Rates
router.get('/tax-rates/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const taxRates = await XeroService.getTaxRates(brandId);
    
    res.json({
      success: true,
      taxRates
    });
  } catch (error) {
    console.error('Error fetching tax rates:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch tax rates' });
  }
});

// Get Invoices
router.get('/invoices-list/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    const { where, order } = req.query;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const invoices = await XeroService.getInvoices(brandId, where as string, order as string);
    
    res.json({
      success: true,
      invoices
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch invoices' });
  }
});

// Get Bank Transfers
router.get('/bank-transfers/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const bankTransfers = await XeroService.getBankTransfers(brandId);
    
    res.json({
      success: true,
      bankTransfers
    });
  } catch (error) {
    console.error('Error fetching bank transfers:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch bank transfers' });
  }
});

// Get Bank Transactions
router.get('/bank-transactions/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    const { bankAccountId } = req.query;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const bankTransactions = await XeroService.getBankTransactions(brandId, bankAccountId as string);
    
    res.json({
      success: true,
      bankTransactions
    });
  } catch (error) {
    console.error('Error fetching bank transactions:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch bank transactions' });
  }
});

// Get Accounts
router.get('/accounts/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const accounts = await XeroService.getAccounts(brandId);
    
    res.json({
      success: true,
      accounts
    });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch accounts' });
  }
});

// Get Attachments
router.get('/attachments/:brandId/:entityType/:entityId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, entityType, entityId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const attachments = await XeroService.getAttachments(brandId, entityType, entityId);
    
    res.json({
      success: true,
      attachments
    });
  } catch (error) {
    console.error('Error fetching attachments:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch attachments' });
  }
});

// Get Credit Notes
router.get('/credit-notes/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const creditNotes = await XeroService.getCreditNotes(brandId);
    
    res.json({
      success: true,
      creditNotes
    });
  } catch (error) {
    console.error('Error fetching credit notes:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch credit notes' });
  }
});

// Get History Records
router.get('/history/:brandId/:entityType/:entityId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, entityType, entityId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const historyRecords = await XeroService.getHistoryRecords(brandId, entityType, entityId);
    
    res.json({
      success: true,
      historyRecords
    });
  } catch (error) {
    console.error('Error fetching history records:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch history records' });
  }
});

// Get Contacts (for invoice reminders)
router.get('/contacts/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const contacts = await XeroService.getContacts(brandId);
    
    res.json({
      success: true,
      contacts
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch contacts' });
  }
});

// Get Reports
router.get('/reports/:brandId/:reportType', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId, reportType } = req.params;
    const options = req.query;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const reports = await XeroService.getReports(brandId, reportType, options);
    
    res.json({
      success: true,
      reports
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch reports' });
  }
});

// Get Tracking Categories (Types & Codes)
router.get('/tracking-categories/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const trackingCategories = await XeroService.getTrackingCategories(brandId);
    
    res.json({
      success: true,
      trackingCategories
    });
  } catch (error) {
    console.error('Error fetching tracking categories:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch tracking categories' });
  }
});

// Get Organisation
router.get('/organisation/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const organisation = await XeroService.getOrganisation(brandId);
    
    res.json({
      success: true,
      organisation
    });
  } catch (error) {
    console.error('Error fetching organisation:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch organisation' });
  }
});

// Get Currencies
router.get('/currencies/:brandId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { brandId } = req.params;
    
    if (req.user?.role !== 'super_admin') {
      // Add brand membership check here if needed
    }

    const currencies = await XeroService.getCurrencies(brandId);
    
    res.json({
      success: true,
      currencies
    });
  } catch (error) {
    console.error('Error fetching currencies:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch currencies' });
  }
});

export default router;