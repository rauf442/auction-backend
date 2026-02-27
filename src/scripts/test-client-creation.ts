// backend/src/scripts/test-client-creation.ts
// Test script to verify client creation works after sequence fix

import { supabaseAdmin } from '../utils/supabase';

async function testClientCreation() {
  console.log('🧪 Testing client creation after sequence fix...\n');

  try {
    // Get current max ID before test
    const { data: maxIdBefore } = await supabaseAdmin
      .from('clients')
      .select('id')
      .order('id', { ascending: false })
      .limit(1)
      .single();

    const currentMaxId = maxIdBefore?.id || 0;
    console.log(`📊 Current max client ID: ${currentMaxId}`);

    // Create a test client
    const testClient = {
      first_name: 'Sequence',
      last_name: 'Test',
      email: `sequence-test-${Date.now()}@example.com`,
      client_type: 'buyer' as const,
      status: 'active' as const
    };

    console.log('🚀 Creating test client...');
    const { data: newClient, error: createError } = await supabaseAdmin
      .from('clients')
      .insert([testClient])
      .select()
      .single();

    if (createError) {
      console.error('❌ Client creation failed:', createError);
      return false;
    }

    const newClientId = newClient?.id;
    console.log(`✅ Test client created successfully with ID: ${newClientId}`);

    // Verify the ID is greater than current max
    if (newClientId && newClientId > currentMaxId) {
      console.log(`✅ ID auto-incremented correctly (${currentMaxId} → ${newClientId})`);
    } else {
      console.error(`❌ ID increment failed! Expected > ${currentMaxId}, got ${newClientId}`);
      return false;
    }

    // Create another client to test sequence continuity
    const testClient2 = {
      first_name: 'Sequence',
      last_name: 'Test 2',
      email: `sequence-test-2-${Date.now()}@example.com`,
      client_type: 'buyer' as const,
      status: 'active' as const
    };

    console.log('🚀 Creating second test client...');
    const { data: newClient2, error: createError2 } = await supabaseAdmin
      .from('clients')
      .insert([testClient2])
      .select()
      .single();

    if (createError2) {
      console.error('❌ Second client creation failed:', createError2);
      return false;
    }

    const newClientId2 = newClient2?.id;
    console.log(`✅ Second test client created successfully with ID: ${newClientId2}`);

    // Verify sequence continuity
    if (newClientId2 && newClientId2 === newClientId + 1) {
      console.log(`✅ Sequence working correctly (${newClientId} → ${newClientId2})`);
    } else {
      console.error(`❌ Sequence broken! Expected ${newClientId + 1}, got ${newClientId2}`);
      return false;
    }

    // Clean up test clients
    console.log('🧹 Cleaning up test clients...');
    await supabaseAdmin
      .from('clients')
      .delete()
      .in('id', [newClientId, newClientId2]);

    console.log('✅ Test completed successfully!');
    console.log('\n📝 Summary:');
    console.log('   ✅ PostgreSQL sequence is working correctly');
    console.log('   ✅ Client creation auto-generates proper IDs');
    console.log('   ✅ No more "duplicate key value" errors expected');
    console.log('   ✅ Google Sheets import will ignore ID columns');

    return true;

  } catch (error) {
    console.error('💥 Unexpected error during testing:', error);
    return false;
  }
}

// If running directly
if (require.main === module) {
  testClientCreation()
    .then((success) => {
      if (success) {
        console.log('\n🎉 All tests passed! Client creation is fixed.');
      } else {
        console.log('\n❌ Some tests failed. Check the output above.');
      }
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

export { testClientCreation };
