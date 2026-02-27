// backend/src/utils/xero-client.ts
import { XeroClient } from 'xero-node';
import { supabaseAdmin } from './supabase';

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  scopes: string[];
  state?: string;
}

export interface XeroCredentials {
  brand_id: string;
  client_id: string;
  client_secret: string;
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  tenant_id?: string;
  tenant_name?: string;
}

// In-memory cache for Xero clients (you might want to use Redis in production)
const xeroClientCache = new Map<string, XeroClient>();

export class XeroService {
  // Helper method to ensure tenant is available, with retry logic
  static async ensureTenantAvailable(xeroClient: XeroClient, brandId: string): Promise<string> {
    let tenantId = await this.getTenantId(xeroClient, brandId);
    
    if (!tenantId) {
        // Try to discover tenant one more time before failing
        // Following Xero SDK pattern: use updateTenants(false) for faster tenant discovery
        console.log(`[TENANT_ENSURE] Tenant not found for brand ${brandId}, attempting discovery...`);
        try {
          await xeroClient.updateTenants(false);
        if (xeroClient.tenants && xeroClient.tenants.length > 0) {
          const discoveredTenantId = xeroClient.tenants[0].tenantId;
          const discoveredTenantName = xeroClient.tenants[0].tenantName;
          
          // Save discovered tenant
          const credentials = await this.getXeroCredentials(brandId);
          if (credentials) {
            await this.saveXeroCredentials(brandId, {
              ...credentials,
              tenant_id: discoveredTenantId,
              tenant_name: discoveredTenantName
            });
            console.log(`[TENANT_ENSURE] Successfully discovered and saved tenant: ${discoveredTenantId}`);
            return discoveredTenantId;
          }
        }
      } catch (discoverError) {
        console.error('[TENANT_ENSURE] Error discovering tenant:', discoverError);
      }
      
      // Check if we have tokens - if yes, connection is valid but tenant needs to be discovered
      const credentials = await this.getXeroCredentials(brandId);
      if (credentials && credentials.access_token && credentials.refresh_token) {
        throw new Error('Xero connection is active but tenant information is not yet available. Please try again in a moment or reconnect your Xero account.');
      }
      
      throw new Error('No tenant available for Xero API calls. Please reconnect your Xero account.');
    }
    
    return tenantId;
  }

  // Helper method to get tenant ID safely
  // Following Xero example app pattern: tenants should be available after getXeroClient()
  static async getTenantId(xeroClient: XeroClient, brandId?: string): Promise<string | null> {
    // First check if tenants are already available on the client
    if (xeroClient.tenants && Array.isArray(xeroClient.tenants) && xeroClient.tenants.length > 0) {
      return xeroClient.tenants[0].tenantId;
    }

    // Check if we have tenant info stored in database
    if (brandId) {
      const credentials = await this.getXeroCredentials(brandId);
      if (credentials && credentials.tenant_id) {
        // Check if credentials are mock/fake (common in development/testing)
        const isMockCredentials = this.isMockCredentials(credentials);
        if (isMockCredentials) {
          console.log(`[TENANT_DISCOVERY] Detected mock credentials for brand: ${brandId} - clearing and forcing OAuth reconnection`);
          await this.clearXeroCredentials(brandId);
          return null;
        }
        return credentials.tenant_id;
      }
    }

    // If no tenants available, try to update them (following example app pattern)
    try {
      await xeroClient.updateTenants();
      if (xeroClient.tenants && Array.isArray(xeroClient.tenants) && xeroClient.tenants.length > 0) {
        const tenantId = xeroClient.tenants[0].tenantId;
        const tenantName = xeroClient.tenants[0].tenantName;
        
        // Save tenant info to database if we have brandId
        if (brandId) {
          const credentials = await this.getXeroCredentials(brandId);
          if (credentials) {
            await this.saveXeroCredentials(brandId, {
              ...credentials,
              tenant_id: tenantId,
              tenant_name: tenantName
            });
          }
        }
        
        return tenantId;
      }
    } catch (error) {
      console.error('[TENANT_DISCOVERY] Failed to update tenants:', error);
    }

    return null;
  }

  // Get Xero credentials for a specific brand
  static async getXeroCredentials(brandId: string): Promise<XeroCredentials | null> {
    try {
      // Get credentials from database only
      const { data, error } = await supabaseAdmin
        .from('platform_credentials')
        .select('*')
        .eq('brand_id', brandId)
        .eq('platform', 'xero')
        .eq('is_active', true)
        .single();

      if (error || !data) {
        console.log(`No Xero credentials found for brand ${brandId}`);
        return null;
      }

      return {
        brand_id: brandId,
        client_id: data.key_id,
        client_secret: data.secret_value,
        access_token: data.additional?.access_token,
        refresh_token: data.additional?.refresh_token,
        token_expires_at: data.additional?.token_expires_at,
        tenant_id: data.additional?.tenant_id,
        tenant_name: data.additional?.tenant_name
      };
    } catch (error) {
      console.error('Error fetching Xero credentials:', error);
      return null;
    }
  }

  // Save or update Xero credentials
  static async saveXeroCredentials(brandId: string, credentials: Partial<XeroCredentials>): Promise<boolean> {
    try {
      const additionalData = {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_expires_at: credentials.token_expires_at,
        tenant_id: credentials.tenant_id,
        tenant_name: credentials.tenant_name
      };

      // First check if credentials already exist
      const { data: existing } = await supabaseAdmin
        .from('platform_credentials')
        .select('id')
        .eq('brand_id', brandId)
        .eq('platform', 'xero')
        .single();

      let error;
      if (existing) {
        // Update existing record
        const { error: updateError } = await supabaseAdmin
          .from('platform_credentials')
          .update({
            key_id: credentials.client_id || '',
            secret_value: credentials.client_secret || '',
            additional: additionalData,
            is_active: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', existing.id);
        error = updateError;
      } else {
        // Insert new record
        const { error: insertError } = await supabaseAdmin
          .from('platform_credentials')
          .insert({
            brand_id: brandId,
            platform: 'xero',
            key_id: credentials.client_id || '',
            secret_value: credentials.client_secret || '',
            additional: additionalData,
            is_active: true,
            updated_at: new Date().toISOString()
          });
        error = insertError;
      }

      if (error) {
        console.error('Error saving Xero credentials:', error);
        return false;
      }

      // Clear cache for this brand
      xeroClientCache.delete(brandId);

      console.log(`Xero credentials saved successfully for brand ${brandId}`);
      return true;
    } catch (error) {
      console.error('Error saving Xero credentials:', error);
      return false;
    }
  }

  // Get redirect URI for Xero OAuth
  static getRedirectUri(): string {
    // Priority: XERO_REDIRECT_URI > BACKEND_URL > default localhost
    if (process.env.XERO_REDIRECT_URI) {
      return process.env.XERO_REDIRECT_URI;
    }
    
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    // Ensure no trailing slash
    const cleanBackendUrl = backendUrl.replace(/\/$/, '');
    return `${cleanBackendUrl}/api/xero-payments/callback`;
  }

  // Get or create Xero client for a brand
  // Following the exact pattern from https://github.com/XeroAPI/xero-node-oauth2-app
  static async getXeroClient(brandId: string): Promise<XeroClient | null> {
    try {
      // Check cache first
      if (xeroClientCache.has(brandId)) {
        const cachedClient = xeroClientCache.get(brandId)!;
        // Verify cached client has tenants (tokens are checked via credentials)
        if (cachedClient.tenants && cachedClient.tenants.length > 0) {
          return cachedClient;
        }
        // If cached client is missing tenants, remove from cache and recreate
        xeroClientCache.delete(brandId);
      }

      const credentials = await this.getXeroCredentials(brandId);
      if (!credentials || !credentials.client_id || !credentials.client_secret) {
        return null;
      }

      const redirectUri = this.getRedirectUri();
      console.log(`[CLIENT_INIT] Creating Xero client for brand: ${brandId}`);
      console.log(`[CLIENT_INIT] Using redirect URI: ${redirectUri}`);

      const config: XeroConfig = {
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        redirectUris: [redirectUri],
        scopes: [
          'offline_access',                    // CRITICAL: Required for refresh tokens to work
          'openid',                            // For user identification
          'profile',                           // User profile information
          'email',                             // User email
          'accounting.transactions',           // Create/read invoices, payments, etc.
          'accounting.contacts',               // Read/write contacts
          'accounting.contacts.read',           // Read contacts
          'accounting.settings',               // Read/write settings
          'accounting.settings.read',           // Read settings (tax rates, etc.)
          'accounting.reports.read',           // Read reports
          'accounting.attachments',            // Read/write attachments
          'accounting.attachments.read'        // Read attachments
        ],
        state: '2' // Set state in config
      };

      const xeroClient = new XeroClient(config);

      // Following Xero example app: Set tokens if available, then update tenants
      if (credentials.access_token && credentials.refresh_token) {
        console.log(`[CLIENT_INIT] Setting tokens for brand: ${brandId}`);
        // expires_at should be in seconds (Unix timestamp), not milliseconds
        const expiresAt = credentials.token_expires_at 
          ? Math.floor(new Date(credentials.token_expires_at).getTime() / 1000)
          : undefined;
        
        // Set tokenSet on client (following example app pattern)
        xeroClient.setTokenSet({
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          expires_at: expiresAt
        });
        console.log(`[CLIENT_INIT] Tokens set successfully for brand: ${brandId}`, {
          expiresAt: expiresAt,
          expiresAtISO: credentials.token_expires_at
        });

        // Following example app: After setting tokens, update tenants if not already available
        // This ensures the client has tenant information for API calls
        if (!xeroClient.tenants || xeroClient.tenants.length === 0) {
          try {
            console.log(`[CLIENT_INIT] Updating tenants for brand: ${brandId}`);
            await xeroClient.updateTenants();
            if (xeroClient.tenants && xeroClient.tenants.length > 0) {
              console.log(`[CLIENT_INIT] Tenants updated successfully:`, 
                xeroClient.tenants.map(t => ({ id: t.tenantId, name: t.tenantName }))
              );
              
              // If we have tenant info but it's not in credentials, save it
              const tenantId = xeroClient.tenants[0].tenantId;
              const tenantName = xeroClient.tenants[0].tenantName;
              
              if (!credentials.tenant_id || credentials.tenant_id !== tenantId) {
                console.log(`[CLIENT_INIT] Saving discovered tenant info to database`);
                await this.saveXeroCredentials(brandId, {
                  ...credentials,
                  tenant_id: tenantId,
                  tenant_name: tenantName
                });
              }
            }
          } catch (updateError) {
            console.warn(`[CLIENT_INIT] Could not update tenants (will try on first API call):`, updateError);
            // Continue - tenant will be discovered on first API call
          }
        } else {
          console.log(`[CLIENT_INIT] Client already has tenants:`, 
            xeroClient.tenants.map(t => ({ id: t.tenantId, name: t.tenantName }))
          );
        }
      } else {
        console.log(`[CLIENT_INIT] No tokens available for brand: ${brandId}`);
      }

      // Cache the client
      xeroClientCache.set(brandId, xeroClient);
      return xeroClient;
    } catch (error) {
      console.error('[CLIENT_INIT] Error creating Xero client:', error);
      return null;
    }
  }

  // Generate authorization URL for OAuth flow
  static async getAuthorizationUrl(brandId: string): Promise<string | null> {
    try {
      console.log(`[OAUTH] Generating authorization URL for brand: ${brandId}`);

      const credentials = await this.getXeroCredentials(brandId);
      if (!credentials || !credentials.client_id || !credentials.client_secret) {
        console.error('[OAUTH] No client credentials available for OAuth');
        return null;
      }

      const redirectUri = this.getRedirectUri();
      console.log(`[OAUTH] Using client ID: ${credentials.client_id.substring(0, 8)}...`);
      console.log(`[OAUTH] Redirect URI: ${redirectUri}`);
      console.log(`[OAUTH] IMPORTANT: Ensure this redirect URI is configured in your Xero app at https://developer.xero.com/app/my-apps`);

      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        console.error('[OAUTH] Failed to create Xero client');
        return null;
      }

      // Clear cache to ensure fresh client with correct redirect URI and state
      xeroClientCache.delete(brandId);
      
      // Create a fresh client with state parameter for this OAuth request
      const oauthConfig: XeroConfig = {
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        redirectUris: [redirectUri],
        scopes: [
          'offline_access',                    // CRITICAL: Required for refresh tokens to work
          'openid',                            // For user identification
          'profile',                           // User profile information
          'email',                             // User email
          'accounting.transactions',           // Create/read invoices, payments, etc.
          'accounting.contacts',               // Read/write contacts
          'accounting.contacts.read',           // Read contacts
          'accounting.settings',               // Read/write settings
          'accounting.settings.read',           // Read settings (tax rates, etc.)
          'accounting.reports.read',           // Read reports
          'accounting.attachments',            // Read/write attachments
          'accounting.attachments.read'        // Read attachments
        ],
        state: '2' // Set state in config
      };
      
      const oauthClient = new XeroClient(oauthConfig);
      
      // Pass brandId as state parameter so we can identify which brand is connecting
      console.log(`[OAUTH] Building consent URL with state (brandId): ${brandId}`);
      const authUrl = await oauthClient.buildConsentUrl();
      console.log(`[OAUTH] Generated authorization URL: ${authUrl.substring(0, 150)}...`);

      // Log the redirect URI and state from the generated URL for verification
      try {
        const urlObj = new URL(authUrl);
        const redirectParam = urlObj.searchParams.get('redirect_uri');
        const stateParam = urlObj.searchParams.get('state');
        
        if (redirectParam) {
          console.log(`[OAUTH] Redirect URI in auth URL: ${redirectParam}`);
          if (decodeURIComponent(redirectParam) !== redirectUri) {
            console.warn(`[OAUTH] WARNING: Redirect URI mismatch! Expected: ${redirectUri}, Got: ${decodeURIComponent(redirectParam)}`);
          }
        }
        
        if (stateParam) {
          console.log(`[OAUTH] State parameter in auth URL: ${stateParam}`);
          if (stateParam !== brandId) {
            console.warn(`[OAUTH] WARNING: State mismatch! Expected: ${brandId}, Got: ${stateParam}`);
          }
        } else {
          console.warn(`[OAUTH] WARNING: No state parameter found in auth URL!`);
        }
      } catch (urlError) {
        console.warn('[OAUTH] Could not parse auth URL for verification');
      }

      return authUrl;
    } catch (error) {
      console.error('[OAUTH] Error generating Xero authorization URL:', error);
      const err = error as any;
      if (err.message) {
        console.error('[OAUTH] Error message:', err.message);
      }
      console.error('[OAUTH] This usually means:');
      console.error('[OAUTH] 1. Invalid client ID/secret in database');
      console.error('[OAUTH] 2. Incorrect redirect URI configured for Xero app');
      console.error(`[OAUTH]    Current redirect URI: ${this.getRedirectUri()}`);
      console.error('[OAUTH]    Make sure this exact URI is added in Xero Developer Portal');
      console.error('[OAUTH] 3. Missing or invalid scopes in Xero app');
      console.error('[OAUTH] 4. Xero app not properly configured in developer portal');
      return null;
    }
  }

  // Check if credentials are mock/fake (used for development/testing)
  static isMockCredentials(credentials: XeroCredentials): boolean {
    // Check for common mock patterns
    const mockPatterns = [
      /^mock[_-]/i,           // mock-tenant-id, mock_tenant_id
      /^test[_-]/i,            // test-tenant-id, test_tenant_id
      /^fake[_-]/i,            // fake-tenant-id
      /^demo[_-]/i,            // demo-tenant-id
      /mock.*token/i,          // mock_access_token_12345
      /test.*token/i,          // test_access_token_12345
      /fake.*token/i,          // fake_access_token_12345
      /demo.*token/i           // demo_access_token_12345
    ];

    // Check tenant ID and name
    if (credentials.tenant_id) {
      for (const pattern of mockPatterns) {
        if (pattern.test(credentials.tenant_id)) {
          return true;
        }
      }
    }

    if (credentials.tenant_name) {
      for (const pattern of mockPatterns) {
        if (pattern.test(credentials.tenant_name)) {
          return true;
        }
      }
    }

    // Check access token
    if (credentials.access_token) {
      for (const pattern of mockPatterns) {
        if (pattern.test(credentials.access_token)) {
          return true;
        }
      }
    }

    return false;
  }

  // Clear Xero credentials for a brand (force reconnection)
  static async clearXeroCredentials(brandId: string): Promise<boolean> {
    try {
      console.log(`[CREDENTIALS] Clearing Xero credentials for brand: ${brandId}`);

      // Remove from database
      const { error } = await supabaseAdmin
        .from('platform_credentials')
        .delete()
        .eq('brand_id', brandId)
        .eq('platform', 'xero');

      if (error) {
        console.error('[CREDENTIALS] Error clearing credentials from database:', error);
        return false;
      }

      // Clear from cache
      xeroClientCache.delete(brandId);

      console.log(`[CREDENTIALS] Successfully cleared Xero credentials for brand: ${brandId}`);
      return true;
    } catch (error) {
      console.error('[CREDENTIALS] Error clearing Xero credentials:', error);
      return false;
    }
  }

  // Manually set tenant information (for test environments or manual configuration)
  static async setTenantInfo(brandId: string, tenantId: string, tenantName: string): Promise<boolean> {
    try {
      const credentials = await this.getXeroCredentials(brandId);
      if (!credentials) {
        console.error('No credentials found for brand:', brandId);
        return false;
      }

      await this.saveXeroCredentials(brandId, {
        ...credentials,
        tenant_id: tenantId,
        tenant_name: tenantName
      });

      // Clear cache to force reload
      xeroClientCache.delete(brandId);

      console.log('Tenant info manually set for brand:', brandId, { tenantId, tenantName });
      return true;
    } catch (error) {
      console.error('Error setting tenant info:', error);
      return false;
    }
  }

  // Update tenant information if missing
  static async updateTenantInfo(brandId: string): Promise<boolean> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        return false;
      }

      const credentials = await this.getXeroCredentials(brandId);
      if (!credentials) {
        return false;
      }

      // Skip if tenant info already exists
      if (credentials.tenant_id && credentials.tenant_name) {
        return true;
      }

      console.log('Updating tenant info for brand:', brandId);

      let tenantInfo = null;

      try {
        // Try multiple methods to get tenant info
        const tenants = xeroClient.tenants || await xeroClient.updateTenants();

        if (tenants && Array.isArray(tenants) && tenants.length > 0) {
          tenantInfo = tenants[0];
        } else {
          // Try to get tenant from the client's internal state
          if (xeroClient.tenants && xeroClient.tenants.length > 0) {
            tenantInfo = xeroClient.tenants[0];
          }
        }

        if (tenantInfo) {
          await this.saveXeroCredentials(brandId, {
            ...credentials,
            tenant_id: tenantInfo.tenantId,
            tenant_name: tenantInfo.tenantName
          });

          console.log('Tenant info updated successfully:', {
            tenant_id: tenantInfo.tenantId,
            tenant_name: tenantInfo.tenantName
          });

          // Clear cache to force reload
          xeroClientCache.delete(brandId);

          return true;
        }
      } catch (error) {
        console.error('Error updating tenant info:', error);
      }

      return false;
    } catch (error) {
      console.error('Error in updateTenantInfo:', error);
      return false;
    }
  }

  // Handle OAuth callback and exchange code for tokens
  // Following the exact pattern from https://github.com/XeroAPI/xero-node-oauth2-app
  static async handleCallback(brandId: string, callbackUrl: string): Promise<boolean> {
    try {
      console.log('[OAUTH_CALLBACK] Processing callback for brand:', brandId);
      console.log('[OAUTH_CALLBACK] Callback URL:', callbackUrl.substring(0, 200) + '...');
      
      // Get credentials to create a fresh client for callback
      const credentials = await this.getXeroCredentials(brandId);
      if (!credentials || !credentials.client_id || !credentials.client_secret) {
        console.error('[OAUTH_CALLBACK] No credentials found for brand:', brandId);
        return false;
      }

      // Create a fresh client with the same config used for authorization
      // This ensures the redirect URI matches exactly
      const redirectUri = this.getRedirectUri();
      console.log('[OAUTH_CALLBACK] Creating fresh client with redirect URI:', redirectUri);
      
      const callbackConfig: XeroConfig = {
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        redirectUris: [redirectUri],
        scopes: [
          'offline_access',                    // CRITICAL: Required for refresh tokens to work
          'openid',                            // For user identification
          'profile',                           // User profile information
          'email',                             // User email
          'accounting.transactions',           // Create/read invoices, payments, etc.
          'accounting.contacts',               // Read/write contacts
          'accounting.contacts.read',           // Read contacts
          'accounting.settings',               // Read/write settings
          'accounting.settings.read',           // Read settings (tax rates, etc.)
          'accounting.reports.read',           // Read reports
          'accounting.attachments',            // Read/write attachments
          'accounting.attachments.read'        // Read attachments
        ],
        state: '2' // Set state in config
      };
      
      const callbackClient = new XeroClient(callbackConfig);
      
      // Exchange authorization code for tokens
      // Following Xero example app: apiCallback expects the full callback URL with query parameters
      // This automatically sets the tokens on the client instance
      console.log('[OAUTH_CALLBACK] Exchanging authorization code for tokens...');
      const tokenSet = await callbackClient.apiCallback(callbackUrl);
      
      console.log('[OAUTH_CALLBACK] Token set received from apiCallback:', {
        hasAccessToken: !!tokenSet.access_token,
        hasRefreshToken: !!tokenSet.refresh_token,
        expires_at: tokenSet.expires_at,
        token_type: tokenSet.token_type,
        scope: tokenSet.scope
      });

      // Following Xero example app pattern: Immediately update tenants after apiCallback
      // apiCallback sets the tokens on the client, so updateTenants() should work immediately
      console.log('[OAUTH_CALLBACK] Fetching tenant information via updateTenants()...');
      let tenantInfo = null;
      
      try {
        // Call updateTenants() - this fetches tenant information using the tokens set by apiCallback
        // Following example app: call updateTenants() right after apiCallback
        await callbackClient.updateTenants();
        
        // Check if tenants are available on the client
        if (callbackClient.tenants && Array.isArray(callbackClient.tenants) && callbackClient.tenants.length > 0) {
          tenantInfo = callbackClient.tenants[0];
          console.log('[OAUTH_CALLBACK] SUCCESS: Tenant found:', {
            tenantId: tenantInfo.tenantId,
            tenantName: tenantInfo.tenantName,
            tenantType: tenantInfo.tenantType
          });
        } else {
          console.warn('[OAUTH_CALLBACK] updateTenants() completed but no tenants found');
        }
      } catch (tenantError: any) {
        console.error('[OAUTH_CALLBACK] Error fetching tenant information:', tenantError);
        // If tenant fetch fails but we have tokens, we can still save the connection
        // Tenant will be discovered on first API call (following example app pattern)
        if (tenantError.response?.status === 401) {
          console.error('[OAUTH_CALLBACK] 401 Unauthorized - tokens may be invalid');
          throw new Error('Failed to authenticate with Xero. Please try connecting again.');
        }
        // Continue even if tenant fetch fails - tokens are valid
      }

      // Get existing credentials before saving
      const existingCredentials = await this.getXeroCredentials(brandId);
      if (!existingCredentials) {
        console.error('[OAUTH_CALLBACK] No existing credentials found for brand:', brandId);
        return false;
      }

      // Handle expires_at - Xero returns it as a Unix timestamp (seconds since epoch)
      // Convert to ISO string for storage
      let expiresAtISO: string | undefined;
      if (tokenSet.expires_at) {
        // expires_at is already in seconds, convert to milliseconds for Date
        expiresAtISO = new Date(tokenSet.expires_at * 1000).toISOString();
        console.log('[OAUTH_CALLBACK] Token expires at:', expiresAtISO, '(original:', tokenSet.expires_at, ')');
      }
      
      // Prepare updated credentials with tokens from tokenSet
      const updatedCredentials: Partial<XeroCredentials> = {
        ...existingCredentials,
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        token_expires_at: expiresAtISO
      };
      
      // Add tenant info if available (following example app pattern)
      if (tenantInfo) {
        updatedCredentials.tenant_id = tenantInfo.tenantId;
        updatedCredentials.tenant_name = tenantInfo.tenantName;
        console.log('[OAUTH_CALLBACK] Saving credentials WITH tenant info:', {
          tenant_id: tenantInfo.tenantId,
          tenant_name: tenantInfo.tenantName
        });
      } else {
        console.warn('[OAUTH_CALLBACK] Saving credentials WITHOUT tenant info - will be discovered on first API call');
      }

      // Save credentials to database (following example app: store tokenSet)
      const saveResult = await this.saveXeroCredentials(brandId, updatedCredentials);
      if (!saveResult) {
        console.error('[OAUTH_CALLBACK] Failed to save credentials');
        return false;
      }

      // Clear cache to force reload with new tokens
      xeroClientCache.delete(brandId);

      console.log('[OAUTH_CALLBACK] Xero callback handled successfully for brand:', brandId);
      console.log('[OAUTH_CALLBACK] Final status:', {
        brandId,
        hasTokens: !!(tokenSet.access_token && tokenSet.refresh_token),
        hasTenantInfo: !!tenantInfo,
        tenantId: tenantInfo?.tenantId,
        tenantName: tenantInfo?.tenantName,
        savedSuccessfully: saveResult
      });

      return true;

    } catch (error) {
      console.error('[OAUTH_CALLBACK] Error handling Xero callback:', error);
      const err = error as any;
      if (err.message) {
        console.error('[OAUTH_CALLBACK] Error message:', err.message);
      }
      if (err.response) {
        console.error('[OAUTH_CALLBACK] Error response:', {
          status: err.response.status,
          statusText: err.response.statusText,
          data: err.response.data
        });
      }
      return false;
    }
  }

  // Create a payment link (invoice) in Xero
  static async createPaymentLink(brandId: string, amount: number, description: string, customerEmail?: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const tenantId = await this.ensureTenantAvailable(xeroClient, brandId);

      // First, create or get a contact
      let contactId: string;
      if (customerEmail) {
        // Try to find existing contact
        const contacts = await xeroClient.accountingApi.getContacts(
          tenantId,
          undefined,
          `EmailAddress="${customerEmail}"`
        );

        if (contacts.body.contacts && contacts.body.contacts.length > 0) {
          contactId = contacts.body.contacts[0].contactID!;
        } else {
          // Create new contact
          const newContact = {
            name: customerEmail.split('@')[0], // Use email prefix as name
            emailAddress: customerEmail,
            contactStatus: 'ACTIVE' as any
          };

          const createdContact = await xeroClient.accountingApi.createContacts(
            tenantId,
            { contacts: [newContact] }
          );

          contactId = createdContact.body.contacts![0].contactID!;
        }
      } else {
        // Use default contact or create a generic one
        contactId = 'default-contact-id'; // You might want to handle this differently
      }

      // Create invoice
      const invoice = {
        type: 'ACCREC' as any, // Accounts Receivable
        contact: { contactID: contactId },
        date: new Date().toISOString().split('T')[0],
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
        lineItems: [{
          description: description,
          quantity: 1,
          unitAmount: amount,
          accountCode: '200' // Default sales account - you may want to configure this
        }],
        status: 'AUTHORISED' as any
      };

      const createdInvoice = await xeroClient.accountingApi.createInvoices(
        tenantId,
        { invoices: [invoice] }
      );

      const invoiceId = createdInvoice.body.invoices![0].invoiceID;

      // Get the invoice with online invoice URL
      const invoiceDetails = await xeroClient.accountingApi.getInvoice(
        tenantId,
        invoiceId!
      );

        return {
        invoiceId: invoiceId,
        invoiceNumber: invoiceDetails.body.invoices![0].invoiceNumber,
        paymentUrl: `https://go.xero.com/organisationlogin/default.aspx?shortcode=${xeroClient.tenants && xeroClient.tenants[0] ? xeroClient.tenants[0].shortCode : 'default'}&redirecturl=/AccountsReceivable/Edit.aspx?InvoiceID=${invoiceId}`,
        amount: amount,
        dueDate: invoice.dueDate,
        status: 'AUTHORISED'
      };
    } catch (error) {
      console.error('Error creating Xero payment link:', error);
      throw error;
    }
  }

  // Get invoice status from Xero
  static async getInvoiceStatus(brandId: string, invoiceId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const invoice = await xeroClient.accountingApi.getInvoice(
        xeroClient.tenants[0].tenantId,
        invoiceId
      );

      return {
        invoiceId: invoiceId,
        status: invoice.body.invoices![0].status,
        amountDue: invoice.body.invoices![0].amountDue,
        amountPaid: invoice.body.invoices![0].amountPaid,
        total: invoice.body.invoices![0].total
      };
    } catch (error) {
      console.error('Error getting Xero invoice status:', error);
      throw error;
    }
  }

  // Refresh access token
  static async refreshAccessToken(brandId: string): Promise<boolean> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        return false;
      }

      const newTokenSet = await xeroClient.refreshToken();
      
      // Save the new tokens
      const credentials = await this.getXeroCredentials(brandId);
      if (credentials) {
        await this.saveXeroCredentials(brandId, {
          ...credentials,
          access_token: newTokenSet.access_token,
          refresh_token: newTokenSet.refresh_token,
          token_expires_at: newTokenSet.expires_at ? new Date(newTokenSet.expires_at * 1000).toISOString() : undefined
        });
      }

      return true;
    } catch (error) {
      console.error('Error refreshing Xero access token:', error);
      return false;
    }
  }

  // Get Tax Rates
  static async getTaxRates(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const tenantId = await this.ensureTenantAvailable(xeroClient, brandId);

      const response = await xeroClient.accountingApi.getTaxRates(tenantId);
      return response.body.taxRates;
    } catch (error) {
      console.error('Error fetching tax rates:', error);
      throw error;
    }
  }

  // Get Invoices
  static async getInvoices(brandId: string, where?: string, order?: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }
      
      const tenantId = await this.ensureTenantAvailable(xeroClient, brandId);
      console.log(`Using tenantId: ${tenantId} for brandId: ${brandId}`);
      console.log(`Using where: ${where}, order: ${order}`);

      const response = await xeroClient.accountingApi.getInvoices(
        tenantId,
        undefined, // ifModifiedSince
        where,
        order
      );
      return response.body.invoices;
    } catch (error) {
      console.error('Error fetching invoices:', error);
      throw error;
    }
  }

  // Get Bank Transfers
  static async getBankTransfers(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getBankTransfers(xeroClient.tenants[0].tenantId);
      return response.body.bankTransfers;
    } catch (error) {
      console.error('Error fetching bank transfers:', error);
      throw error;
    }
  }

  // Get Bank Transactions
  static async getBankTransactions(brandId: string, bankAccountId?: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      if (bankAccountId) {
        const response = await xeroClient.accountingApi.getBankTransactions(
          xeroClient.tenants[0].tenantId,
          undefined, // ifModifiedSince
          `BankAccount.AccountID="${bankAccountId}"`
        );
        return response.body.bankTransactions;
      } else {
        const response = await xeroClient.accountingApi.getBankTransactions(xeroClient.tenants[0].tenantId);
        return response.body.bankTransactions;
      }
    } catch (error) {
      console.error('Error fetching bank transactions:', error);
      throw error;
    }
  }

  // Get Accounts (Chart of Accounts)
  static async getAccounts(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getAccounts(xeroClient.tenants[0].tenantId);
      return response.body.accounts;
    } catch (error) {
      console.error('Error fetching accounts:', error);
      throw error;
    }
  }

  // Get Attachments for an entity
  static async getAttachments(brandId: string, entityType: string, entityId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      let response;
      switch (entityType) {
        case 'invoices':
          response = await xeroClient.accountingApi.getInvoiceAttachments(
            xeroClient.tenants[0].tenantId,
            entityId
          );
          break;
        case 'accounts':
          response = await xeroClient.accountingApi.getAccountAttachments(
            xeroClient.tenants[0].tenantId,
            entityId
          );
          break;
        default:
          throw new Error(`Attachments not supported for entity type: ${entityType}`);
      }

      return response.body.attachments;
    } catch (error) {
      console.error('Error fetching attachments:', error);
      throw error;
    }
  }

  // Get Credit Notes
  static async getCreditNotes(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getCreditNotes(xeroClient.tenants[0].tenantId);
      return response.body.creditNotes;
    } catch (error) {
      console.error('Error fetching credit notes:', error);
      throw error;
    }
  }

  // Get History Records for an entity
  static async getHistoryRecords(brandId: string, entityType: string, entityId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      let response;
      switch (entityType) {
        case 'invoices':
          response = await xeroClient.accountingApi.getInvoiceHistory(
            xeroClient.tenants[0].tenantId,
            entityId
          );
          break;
        case 'contacts':
          response = await xeroClient.accountingApi.getContactHistory(
            xeroClient.tenants[0].tenantId,
            entityId
          );
          break;
        default:
          throw new Error(`History not supported for entity type: ${entityType}`);
      }

      return response.body.historyRecords;
    } catch (error) {
      console.error('Error fetching history records:', error);
      throw error;
    }
  }

  // Get Contacts (for managing invoice reminders)
  static async getContacts(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getContacts(xeroClient.tenants[0].tenantId);
      return response.body.contacts;
    } catch (error) {
      console.error('Error fetching contacts:', error);
      throw error;
    }
  }

  // Get Reports
  static async getReports(brandId: string, reportType: string, options?: any): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      let response;
      const tenantId = xeroClient.tenants[0].tenantId;

      switch (reportType) {
        case 'BalanceSheet':
          response = await xeroClient.accountingApi.getReportBalanceSheet(
            tenantId,
            options?.date,
            options?.periods,
            options?.timeframe,
            options?.trackingCategory1,
            options?.trackingCategory2,
            options?.standardLayout,
            options?.paymentsOnly
          );
          break;
        case 'ProfitAndLoss':
          response = await xeroClient.accountingApi.getReportProfitAndLoss(
            tenantId,
            options?.fromDate,
            options?.toDate,
            options?.periods,
            options?.timeframe,
            options?.trackingCategory1,
            options?.trackingCategory2,
            options?.standardLayout,
            options?.paymentsOnly
          );
          break;
        case 'TrialBalance':
          response = await xeroClient.accountingApi.getReportTrialBalance(
            tenantId,
            options?.date,
            options?.paymentsOnly
          );
          break;
        case 'AgedReceivables':
          response = await xeroClient.accountingApi.getReportAgedReceivablesByContact(
            tenantId,
            options?.contactId,
            options?.date,
            options?.fromDate,
            options?.toDate
          );
          break;
        case 'AgedPayables':
          response = await xeroClient.accountingApi.getReportAgedPayablesByContact(
            tenantId,
            options?.contactId,
            options?.date,
            options?.fromDate,
            options?.toDate
          );
          break;
        default:
          throw new Error(`Report type ${reportType} not supported`);
      }

      return response.body.reports;
    } catch (error) {
      console.error('Error fetching reports:', error);
      throw error;
    }
  }

  // Get Tracking Categories (Types & Codes)
  static async getTrackingCategories(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getTrackingCategories(xeroClient.tenants[0].tenantId);
      return response.body.trackingCategories;
    } catch (error) {
      console.error('Error fetching tracking categories:', error);
      throw error;
    }
  }

  // Get Organisation info
  static async getOrganisation(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getOrganisations(xeroClient.tenants[0].tenantId);
      return response.body.organisations;
    } catch (error) {
      console.error('Error fetching organisation info:', error);
      throw error;
    }
  }

  // Get Currencies
  static async getCurrencies(brandId: string): Promise<any> {
    try {
      const xeroClient = await this.getXeroClient(brandId);
      if (!xeroClient) {
        throw new Error('Xero client not available for this brand');
      }

      const response = await xeroClient.accountingApi.getCurrencies(xeroClient.tenants[0].tenantId);
      return response.body.currencies;
    } catch (error) {
      console.error('Error fetching currencies:', error);
      throw error;
    }
  }
}
export default XeroService;