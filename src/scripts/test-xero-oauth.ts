// backend/src/scripts/test-xero-oauth.ts
import { XeroService } from '../utils/xero-client';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testXeroOAuth() {
  console.log('🧪 Testing Xero OAuth2 Integration');
  console.log('==================================\n');

  const testBrandId = '2'; // Use a test brand ID currently set to AURUM

  try {
    // Check if test credentials are set
    const testClientId = process.env.XERO_TEST_CLIENT_ID;
    const testClientSecret = process.env.XERO_TEST_CLIENT_SECRET;

    if (testClientId && testClientSecret) {
      console.log('✅ Test credentials found:');
      console.log(`   Client ID: ${testClientId}`);
      console.log(`   Client Secret: ${testClientSecret ? '***' + testClientSecret.slice(-4) : 'Not set'}`);
      console.log('');
    } else {
      console.log('❌ Test credentials not found. Set XERO_TEST_CLIENT_ID and XERO_TEST_CLIENT_SECRET environment variables.');
      console.log('');
    }

    // Test building authorization URL
    console.log('🔗 Testing authorization URL generation...');
    const authUrl = await XeroService.getAuthorizationUrl(testBrandId);

    if (authUrl) {
      console.log('✅ Authorization URL generated successfully:');
      console.log(`   ${authUrl}`);
      console.log('');
    } else {
      console.log('❌ Failed to generate authorization URL');
      console.log('');
    }

    // Check existing credentials
    console.log('🔍 Checking existing Xero credentials...');
    const existingCredentials = await XeroService.getXeroCredentials(testBrandId);

    if (existingCredentials) {
      console.log('✅ Existing credentials found:');
      console.log(`   Client ID: ${existingCredentials.client_id}`);
      console.log(`   Has Access Token: ${!!existingCredentials.access_token}`);
      console.log(`   Has Refresh Token: ${!!existingCredentials.refresh_token}`);
      console.log(`   Token Expires At: ${existingCredentials.token_expires_at || 'Not set'}`);
      console.log(`   Tenant ID: ${existingCredentials.tenant_id || 'Not set'}`);
      console.log(`   Tenant Name: ${existingCredentials.tenant_name || 'Not set'}`);
      console.log('');
    } else {
      console.log('ℹ️  No existing credentials found for brand:', testBrandId);
      console.log('');
    }

    // Test client creation
    console.log('🏗️  Testing Xero client creation...');
    const xeroClient = await XeroService.getXeroClient(testBrandId);

    if (xeroClient) {
      console.log('✅ Xero client created successfully');
      console.log(`   Client configured with redirect URI: http://localhost:3001/api/xero-payments/callback`);
      console.log('');
    } else {
      console.log('❌ Failed to create Xero client');
      console.log('');
    }

    console.log('📋 Next Steps for Testing:');
    console.log('1. Set environment variables:');
    console.log('   export XERO_TEST_CLIENT_ID=F2F43C647EE2447DA1249F7C3339D108');
    console.log('   export XERO_TEST_CLIENT_SECRET=your_client_secret_here');
    console.log('');
    console.log('2. Start the backend server: npm run dev');
    console.log('');
    console.log('3. Get the authorization URL by calling the API:');
    console.log('   GET /api/xero-payments/auth-url/:brandId');
    console.log('');
    console.log('4. Visit the authorization URL in your browser to complete OAuth flow');
    console.log('');
    console.log('5. Check that the callback redirects to: http://localhost:3001/api/xero-payments/callback');
    console.log('');
    console.log('6. Verify the redirect goes back to your frontend with success/error parameters');
    console.log('');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }
}

// Run the test
testXeroOAuth().catch(console.error);
