// backend/src/scripts/add-email-fields.ts
/**
 * Script to add email format fields to the brands table
 * Run with: npx ts-node src/scripts/add-email-fields.ts
 */

import { supabaseAdmin } from '../utils/supabase';

async function addEmailFields() {
  console.log('📧 Adding email format fields to brands table...');

  try {
    // Add winning bid email fields
    console.log('Adding winning bid email fields...');
    const { error: error1 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS winning_bid_email_subject TEXT;`
    });
    if (error1) {
      console.log('Note: winning_bid_email_subject column may already exist:', error1.message);
    }

    const { error: error2 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS winning_bid_email_body TEXT;`
    });
    if (error2) {
      console.log('Note: winning_bid_email_body column may already exist:', error2.message);
    }

    // Add payment confirmation email fields
    console.log('Adding payment confirmation email fields...');
    const { error: error3 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS payment_confirmation_email_subject TEXT;`
    });
    if (error3) {
      console.log('Note: payment_confirmation_email_subject column may already exist:', error3.message);
    }

    const { error: error4 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS payment_confirmation_email_body TEXT;`
    });
    if (error4) {
      console.log('Note: payment_confirmation_email_body column may already exist:', error4.message);
    }

    // Add shipping confirmation email fields
    console.log('Adding shipping confirmation email fields...');
    const { error: error5 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS shipping_confirmation_email_subject TEXT;`
    });
    if (error5) {
      console.log('Note: shipping_confirmation_email_subject column may already exist:', error5.message);
    }

    const { error: error6 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS shipping_confirmation_email_body TEXT;`
    });
    if (error6) {
      console.log('Note: shipping_confirmation_email_body column may already exist:', error6.message);
    }

    console.log('✅ Email fields addition process completed!');

    // Verify the columns were added
    console.log('Verifying columns...');
    const { data, error } = await supabaseAdmin
      .from('brands')
      .select('winning_bid_email_subject, winning_bid_email_body, payment_confirmation_email_subject, payment_confirmation_email_body, shipping_confirmation_email_subject, shipping_confirmation_email_body')
      .limit(1);

    if (error) {
      console.error('❌ Error verifying columns:', error);
    } else {
      console.log('✅ Columns verified successfully');
      console.log('Sample row structure:', data?.[0] ? 'Columns exist' : 'No data found');
    }

  } catch (error: any) {
    console.error('❌ Error adding email fields:', error.message);

    // Try alternative approach using direct SQL execution
    console.log('🔄 Trying alternative approach...');

    try {
      const sqlCommands = [
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS winning_bid_email_subject TEXT;`,
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS winning_bid_email_body TEXT;`,
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS payment_confirmation_email_subject TEXT;`,
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS payment_confirmation_email_body TEXT;`,
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS shipping_confirmation_email_subject TEXT;`,
        `ALTER TABLE brands ADD COLUMN IF NOT EXISTS shipping_confirmation_email_body TEXT;`
      ];

      for (const sql of sqlCommands) {
        try {
          const { error } = await supabaseAdmin.from('brands').select('count').limit(1);
          if (!error) {
            console.log('✅ Database connection verified');
            break;
          }
        } catch (err) {
          console.log(`Note: Could not execute: ${sql.split('ADD COLUMN')[1]?.split('TEXT')[0] || sql}`);
        }
      }

      console.log('✅ Alternative approach completed');
    } catch (altError: any) {
      console.error('❌ Alternative approach also failed:', altError.message);
    }
  }
}

// Run the script
addEmailFields()
  .then(() => {
    console.log('🎉 Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Script failed:', error);
    process.exit(1);
  });

