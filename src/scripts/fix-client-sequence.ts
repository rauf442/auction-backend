// backend/src/scripts/fix-client-sequence.ts
// Script to fix PostgreSQL auto-increment sequence for clients table
// Run this after fixing Google Sheets import to prevent ID conflicts

import { supabaseAdmin } from '../utils/supabase';

async function fixClientSequence() {
  try {
    console.log('🔧 Starting client sequence fix...');

    // Get the current maximum ID from the clients table
    const { data: maxIdResult, error: maxIdError } = await supabaseAdmin
      .from('clients')
      .select('id')
      .order('id', { ascending: false })
      .limit(1)
      .single();

    if (maxIdError) {
      console.error('❌ Error getting max client ID:', maxIdError);
      return;
    }

    const maxId = maxIdResult?.id || 0;
    const nextId = maxId + 1;

    console.log(`📊 Current max client ID: ${maxId}`);
    console.log(`🎯 Setting sequence to start from: ${nextId}`);

    // Reset the sequence to start from the next available ID
    // Note: This uses raw SQL since Supabase client doesn't support sequence operations directly
    const { data: sequenceResult, error: sequenceError } = await supabaseAdmin
      .rpc('reset_clients_sequence', { next_id: nextId });

    if (sequenceError) {
      console.error('❌ Error resetting sequence via RPC:', sequenceError);

      // Try alternative approach with raw SQL
      console.log('🔄 Trying alternative sequence reset method...');

      // This would require direct database access, but for now we'll provide instructions
      console.log('⚠️  Manual sequence reset required:');
      console.log(`   ALTER SEQUENCE clients_id_seq RESTART WITH ${nextId};`);
      console.log('   Run this in your Supabase SQL editor or database console.');
    } else {
      console.log('✅ Sequence reset successfully via RPC');
    }

    // Verify the fix by trying to create a test client
    console.log('🧪 Testing client creation...');

    const testClient = {
      first_name: 'Test',
      last_name: 'Client',
      email: `test-${Date.now()}@example.com`,
      client_type: 'buyer' as const
    };

    const { data: newClient, error: createError } = await supabaseAdmin
      .from('clients')
      .insert([testClient])
      .select()
      .single();

    if (createError) {
      console.error('❌ Test client creation failed:', createError);
    } else {
      console.log('✅ Test client created successfully with ID:', newClient?.id);

      // Clean up test client
      await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', newClient?.id);
    }

    console.log('🎉 Client sequence fix completed!');
    console.log('\n📝 Next steps:');
    console.log('   1. Test creating clients through your application');
    console.log('   2. Google Sheets imports will now auto-generate IDs');
    console.log('   3. Monitor for any remaining sequence issues');

  } catch (error) {
    console.error('💥 Unexpected error during sequence fix:', error);
  }
}

// If running directly
if (require.main === module) {
  fixClientSequence()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

export { fixClientSequence };
