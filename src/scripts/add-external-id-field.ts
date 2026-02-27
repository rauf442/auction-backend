// backend/src/scripts/add-external-id-field.ts
import { supabaseAdmin } from '../utils/supabase';

/**
 * Adds external_id field to clients table for Google Sheets sync matching
 * This field will store unique identifiers from external sources like Google Sheets
 */
async function addExternalIdField() {
  try {
    console.log('🚀 Starting external_id field migration...');

    // Check if external_id column already exists by trying to select it
    const { data: testSelect, error: checkError } = await supabaseAdmin
      .from('clients')
      .select('external_id')
      .limit(1);

    if (!checkError) {
      console.log('✅ external_id column already exists in clients table');
      return;
    }

    // If we get an error about the column not existing, that's expected
    if (checkError.message && checkError.message.includes('column') && checkError.message.includes('does not exist')) {
      console.log('📝 external_id column not found, will need to add it manually');
    } else {
      console.error('❌ Unexpected error checking for external_id column:', checkError);
      return;
    }

    console.log('📝 external_id column not found, will need to add it manually via Supabase Dashboard or CLI');
    console.log('🔧 Please run the following SQL in your Supabase SQL Editor:');
    console.log(`
-- Add external_id column to clients table
ALTER TABLE clients
ADD COLUMN external_id TEXT;

-- Add unique index for external_id (allowing NULL values)
CREATE UNIQUE INDEX idx_clients_external_id
ON clients(external_id)
WHERE external_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN clients.external_id IS 'Unique identifier from external sources (e.g., Google Sheets) for sync operations';
    `);

    // Test if we can at least query the clients table
    const { data: testData, error: testError } = await supabaseAdmin
      .from('clients')
      .select('id')
      .limit(1);

    if (testError) {
      console.error('❌ Error testing clients table access:', testError);
      return;
    }

    console.log('✅ Clients table is accessible, ready for manual migration');

  } catch (error: any) {
    console.error('❌ Migration failed:', error);
  }
}

// Run the migration
addExternalIdField().then(() => {
  console.log('🏁 Migration script completed');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Migration script failed:', error);
  process.exit(1);
});
