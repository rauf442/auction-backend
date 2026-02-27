// backend/src/scripts/apply-include-fields-migration.ts
// Script to apply the include fields migration when connectivity is restored

import { supabaseAdmin } from '../utils/supabase';

async function applyIncludeFieldsMigration() {
  console.log('🔧 Applying include fields migration...\n');

  try {
    // Check if columns already exist
    const { data: existingColumns, error: checkError } = await supabaseAdmin
      .from('information_schema.columns')
      .select('column_name')
      .eq('table_name', 'items')
      .like('column_name', 'include_artist_%');

    if (checkError) {
      console.error('❌ Error checking existing columns:', checkError);
      return;
    }

    const existingColumnNames = existingColumns?.map(col => col.column_name) || [];
    console.log('📊 Existing include columns:', existingColumnNames);

    // Define all required columns
    const requiredColumns = [
      'include_artist_description',
      'include_artist_key_description',
      'include_artist_biography',
      'include_artist_notable_works',
      'include_artist_major_exhibitions',
      'include_artist_awards_honors',
      'include_artist_market_value_range',
      'include_artist_signature_style'
    ];

    // Find missing columns
    const missingColumns = requiredColumns.filter(col => !existingColumnNames.includes(col));
    console.log('📝 Missing columns:', missingColumns);

    if (missingColumns.length === 0) {
      console.log('✅ All include fields already exist!');
      return;
    }

    // Add missing columns
    console.log('🚀 Adding missing columns...');
    for (const column of missingColumns) {
      const defaultValue = column.includes('description') || column.includes('key_description') ? 'true' : 'false';

      const { error: alterError } = await supabaseAdmin.rpc('add_column_if_not_exists', {
        table_name: 'items',
        column_name: column,
        column_type: 'BOOLEAN',
        default_value: defaultValue
      });

      if (alterError) {
        console.error(`❌ Error adding column ${column}:`, alterError);
      } else {
        console.log(`✅ Added column: ${column}`);
      }
    }

    // Verify all columns exist
    const { data: finalColumns, error: finalCheckError } = await supabaseAdmin
      .from('information_schema.columns')
      .select('column_name, data_type, column_default')
      .eq('table_name', 'items')
      .like('column_name', 'include_artist_%');

    if (finalCheckError) {
      console.error('❌ Error verifying final columns:', finalCheckError);
    } else {
      console.log('\n📋 Final include columns:');
      finalColumns?.forEach(col => {
        console.log(`   ${col.column_name}: ${col.data_type} (default: ${col.column_default})`);
      });
    }

    console.log('\n🎉 Include fields migration completed!');

  } catch (error) {
    console.error('💥 Unexpected error during migration:', error);
  }
}

// Manual SQL for when RPC is not available
function getManualSQL(): string {
  return `
-- Run this SQL manually in your Supabase SQL editor:

ALTER TABLE items
ADD COLUMN IF NOT EXISTS include_artist_description BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS include_artist_key_description BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS include_artist_biography BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS include_artist_notable_works BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS include_artist_major_exhibitions BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS include_artist_awards_honors BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS include_artist_market_value_range BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS include_artist_signature_style BOOLEAN DEFAULT false;

-- Verify the columns were added:
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'items'
AND column_name LIKE 'include_artist_%'
ORDER BY column_name;
  `;
}

// If running directly
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--manual-sql')) {
    console.log('📄 Manual SQL for Supabase dashboard:');
    console.log(getManualSQL());
  } else {
    applyIncludeFieldsMigration()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
      });
  }
}

export { applyIncludeFieldsMigration, getManualSQL };
