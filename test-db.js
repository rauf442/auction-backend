require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY exists:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkDatabase() {
  console.log('=== CHECKING CONSIGNMENTS ===');
  const { data: consignments, error: consError } = await supabase
    .from('consignments')
    .select('id, consignment_number, created_at')
    .limit(10);

  if (consError) {
    console.error('Consignments error:', consError);
  } else {
    console.log('Consignments found:', consignments);
  }

  console.log('\\n=== CHECKING ITEMS FOR CONSIGNMENT 1 ===');
  if (consignments && consignments.length > 0) {
    const firstConsignmentId = consignments[0].id;
    const { data: items, error: itemsError } = await supabase
      .from('items')
      .select('id, title, status, consignment_id')
      .eq('consignment_id', firstConsignmentId)
      .limit(5);

    if (itemsError) {
      console.error('Items error:', itemsError);
    } else {
      console.log('Items for consignment', firstConsignmentId, ':', items);
    }
  }

  console.log('\\n=== CHECKING AUCTIONS ===');
  const { data: auctions, error: auctionsError } = await supabase
    .from('auctions')
    .select('id, short_name, artwork_ids, specialist_id')
    .limit(5);

  if (auctionsError) {
    console.error('Auctions error:', auctionsError);
  } else {
    console.log('Auctions found:', auctions);

    // Check specialist data for auctions that have specialist_id
    if (auctions && auctions.length > 0) {
      const auctionsWithSpecialists = auctions.filter(a => a.specialist_id);
      console.log('\\n=== CHECKING SPECIALISTS ===');
      console.log('Auctions with specialists:', auctionsWithSpecialists);

      for (const auction of auctionsWithSpecialists.slice(0, 2)) {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, first_name, last_name')
          .eq('id', auction.specialist_id)
          .single();

        console.log(`Profile for auction ${auction.id} (specialist ${auction.specialist_id}):`, profile, profileError ? `Error: ${profileError.message}` : '');
      }
    }
  }
}

checkDatabase().catch(console.error);
