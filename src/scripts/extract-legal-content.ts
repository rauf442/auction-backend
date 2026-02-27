// backend/src/scripts/extract-legal-content.ts
// Purpose: Extract HTML content from test-data files and create static HTML files

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

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

function createLegalHTMLFiles() {
  const brands = ['aurum', 'metsab'];
  const legalTypes = [
    { key: 'buyers-terms-and-conditions', filename: 'buyer-terms-conditions.html' },
    { key: 'sellers-terms-and-conditions', filename: 'seller-terms-conditions.html' },
    { key: 'privacy-policy', filename: 'privacy-policy.html' }
  ];

  console.log('🚀 Starting legal content extraction...');

  for (const brand of brands) {
    console.log(`📁 Processing ${brand}...`);

    // Create assets directory if it doesn't exist
    const assetsDir = join(__dirname, `../../../frontend/${brand}/assets/legal`);
    mkdirSync(assetsDir, { recursive: true });

    for (const legal of legalTypes) {
      const sourceFile = join(__dirname, `../../../test-data/${brand}-${legal.key}.html`);
      const targetFile = join(assetsDir, legal.filename);

      console.log(`  📄 Processing ${legal.key}...`);

      try {
        // Read and extract content
        const htmlContent = readFileSync(sourceFile, 'utf-8');
        const extractedContent = extractContentFromHTML(htmlContent);

        if (!extractedContent) {
          console.error(`  ❌ No content found in ${sourceFile}`);
          continue;
        }

        // Write only the raw extracted content
        writeFileSync(targetFile, extractedContent, 'utf-8');
        console.log(`  ✅ Created ${targetFile}`);

      } catch (error) {
        console.error(`  ❌ Error processing ${sourceFile}:`, error);
      }
    }
  }

  console.log('🎉 Legal content extraction completed!');
}

// Run the script
try {
  createLegalHTMLFiles();
  console.log('✅ Script completed successfully');
  process.exit(0);
} catch (error: any) {
  console.error('💥 Script failed:', error);
  process.exit(1);
}
