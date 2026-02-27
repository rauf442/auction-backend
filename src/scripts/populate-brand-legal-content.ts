// backend/src/scripts/populate-brand-legal-content.ts
// Purpose: Populate brand legal content from HTML files

import { readFileSync } from 'fs';
import { join } from 'path';
import { supabaseAdmin } from '../utils/supabase';

interface BrandContent {
  code: string;
  buyer_terms_and_conditions: string;
  vendor_terms_and_conditions: string;
  privacy_policy: string;
  brand_address: string;
  contact_email: string;
  contact_phone: string;
  business_whatsapp_number: string;
  website_url: string;
}

// Extract content from HTML files
function extractContentFromHTML(htmlContent: string): string {
  // Find the sqs-html-content div and extract its content
  const startMarker = '<div class="sqs-html-content" data-sqsp-text-block-content="">';
  const endMarker = '</div>';

  const startIndex = htmlContent.indexOf(startMarker);
  if (startIndex === -1) return '';

  const contentStart = startIndex + startMarker.length;
  const endIndex = htmlContent.indexOf(endMarker, contentStart);
  if (endIndex === -1) return '';

  return htmlContent.substring(contentStart, endIndex).trim();
}

async function populateBrandContent() {
  const brands: BrandContent[] = [
    {
      code: 'AURUM',
      buyer_terms_and_conditions: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/aurum-buyers-terms-and-conditions.html'), 'utf-8')),
      vendor_terms_and_conditions: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/aurum-sellers-terms-and-conditions.html'), 'utf-8')),
      privacy_policy: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/aurum-privacy-policy.html'), 'utf-8')),
      brand_address: 'Stansted Auction Rooms\nPurley Way\nPurley\nSurrey\nUnited Kingdom\nCR0 0XZ',
      contact_email: 'auctions@aurum.com',
      contact_phone: '+44 1279 817778',
      business_whatsapp_number: '+441279817778',
      website_url: 'https://aurumauctions.com'
    },
    {
      code: 'METSAB',
      buyer_terms_and_conditions: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/metsab-buyers-terms-and-conditions.html'), 'utf-8')),
      vendor_terms_and_conditions: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/metsab-sellers-terms-and-conditions.html'), 'utf-8')),
      privacy_policy: extractContentFromHTML(readFileSync(join(__dirname, '../../../test-data/metsab-privacy-policy.html'), 'utf-8')),
      brand_address: 'Stansted Auction Rooms\nPurley Way\nPurley\nSurrey\nUnited Kingdom\nCR0 0XZ',
      contact_email: 'auctions@metsab.com',
      contact_phone: '+44 1279 817778',
      business_whatsapp_number: '+441279817778',
      website_url: 'https://metsabauctions.com'
    }
  ];

  console.log('🚀 Starting brand legal content population...');

  for (const brand of brands) {
    console.log(`📝 Processing brand: ${brand.code}`);

    try {
      const { data, error } = await supabaseAdmin
        .from('brands')
        .update({
          buyer_terms_and_conditions: brand.buyer_terms_and_conditions,
          vendor_terms_and_conditions: brand.vendor_terms_and_conditions,
          privacy_policy: brand.privacy_policy,
          brand_address: brand.brand_address,
          contact_email: brand.contact_email,
          contact_phone: brand.contact_phone,
          business_whatsapp_number: brand.business_whatsapp_number,
          website_url: brand.website_url,
          updated_at: new Date().toISOString()
        })
        .eq('code', brand.code)
        .select();

      if (error) {
        console.error(`❌ Error updating ${brand.code}:`, error);
      } else {
        console.log(`✅ Successfully updated ${brand.code}`);
      }
    } catch (err) {
      console.error(`💥 Failed to process ${brand.code}:`, err);
    }
  }

  console.log('🎉 Brand legal content population completed!');
}

async function clearBrandLegalContent() {
  console.log('🧹 Starting brand legal content cleanup...');

  try {
    const { data, error } = await supabaseAdmin
      .from('brands')
      .update({
        buyer_terms_and_conditions: null,
        vendor_terms_and_conditions: null,
        privacy_policy: null,
        updated_at: new Date().toISOString()
      })
      .neq('id', 0) // Clear all brands
      .select();

    if (error) {
      console.error('❌ Error clearing legal content:', error);
    } else {
      console.log(`✅ Successfully cleared legal content from ${data?.length || 0} brands`);
    }
  } catch (err) {
    console.error('💥 Failed to clear legal content:', err);
  }

  console.log('🎉 Brand legal content cleanup completed!');
}

// Check command line arguments
const command = process.argv[2];

if (command === 'clear') {
  clearBrandLegalContent();
} else if (command === 'populate') {
  populateBrandContent();
} else {
  console.log('Usage: ts-node populate-brand-legal-content.ts [clear|populate]');
  console.log('  clear: Clear all legal content from brands');
  console.log('  populate: Populate brands with legal content from HTML files');
  process.exit(1);
}
