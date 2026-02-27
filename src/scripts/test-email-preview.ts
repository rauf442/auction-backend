// backend/src/scripts/test-email-preview.ts
/**
 * Test script for email preview functionality
 * Run with: npx ts-node src/scripts/test-email-preview.ts
 */

import { EmailService } from '../utils/email-service';

async function testEmailPreview() {
  console.log('🧪 Testing Email Preview Functionality...\n');

  // Test with a sample brand ID (you may need to adjust this)
  const testBrandId = 1;

  // Sample variables for testing
  const testVariables = {
    CLIENT_NAME: 'John Smith',
    ITEM_TITLE: 'Antique Painting',
    LOT_NUMBER: 'LOT-001',
    FINAL_BID_AMOUNT: '£2,500',
    AUCTION_NAME: 'Test Auction House',
    PAYMENT_TERMS: '7 days',
    CONTACT_EMAIL: 'contact@test.com',
    CONTACT_PHONE: '+44 20 1234 5678',
    INVOICE_NUMBER: 'INV-2024-001',
    PURCHASE_AMOUNT: '£2,750',
    PAYMENT_METHOD: 'Bank Transfer',
    REFERENCE_NUMBER: 'REF123456',
    BASE_URL: 'http://localhost:3000',
    BRAND_NAME: 'Test Auction House',
    PAYMENT_DATE: new Date().toLocaleDateString('en-GB'),
    INVOICE_ID: 'inv_123456'
  };

  const emailTypes = ['winning_bid', 'payment_confirmation', 'shipping_confirmation'] as const;

  for (const emailType of emailTypes) {
    console.log(`\n📧 Testing ${emailType.replace('_', ' ').toUpperCase()}...`);

    try {
      const preview = await EmailService.previewEmailTemplate(testBrandId, emailType, testVariables);

      if (preview) {
        console.log('✅ Preview generated successfully!');
        console.log('📌 Subject:', preview.subject);
        console.log('📝 Body Length:', preview.body.length, 'characters');

        // Check if variables were replaced
        const hasReplacedVars = Object.keys(testVariables).some(key =>
          preview.subject.includes(String(testVariables[key as keyof typeof testVariables])) ||
          preview.body.includes(String(testVariables[key as keyof typeof testVariables]))
        );

        if (hasReplacedVars) {
          console.log('✅ Variables were replaced in template');
        } else {
          console.log('⚠️ No variables were replaced (using default template)');
        }
      } else {
        console.log('❌ Failed to generate preview');
      }
    } catch (error: any) {
      console.error('❌ Error testing preview:', error.message);
    }
  }

  console.log('\n🎉 Email preview testing completed!');
}

// Test individual template functions
async function testDefaultTemplates() {
  console.log('\n🔧 Testing Default Template Generation...\n');
  
  // Import template functions from email-templates module
  const { getDefaultWinningBidTemplate, getDefaultPaymentConfirmationTemplate, getDefaultShippingConfirmationTemplate } = await import('../utils/email-templates');

  const templates = [
    { name: 'Winning Bid', template: getDefaultWinningBidTemplate() },
    { name: 'Payment Confirmation', template: getDefaultPaymentConfirmationTemplate() },
    { name: 'Shipping Confirmation', template: getDefaultShippingConfirmationTemplate() }
  ];

  templates.forEach(({ name, template }) => {
    console.log(`📄 ${name} Template:`);
    console.log(`   Length: ${template.length} characters`);
    console.log(`   Contains HTML: ${template.includes('<html>')}`);
    console.log(`   Contains variables: ${template.includes('[CLIENT_NAME]')}`);
    console.log('');
  });
}

// Run tests
async function runTests() {
  try {
    await testDefaultTemplates();
    await testEmailPreview();
  } catch (error: any) {
    console.error('💥 Test suite failed:', error);
    process.exit(1);
  }
}

runTests();
