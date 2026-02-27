// backend/src/scripts/change-superadmin-password.ts
// Purpose: Change password for superadmin@art.com email
// Effect: Updates Supabase auth user password directly without needing current password

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   - SUPABASE_URL');
  console.error('   - SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Initialize Supabase admin client
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function changePasswordByEmail(email: string, newPassword: string): Promise<void> {
  try {
    console.log(`🔍 Looking up user with email: ${email}`);

    // Step 1: Find the auth user by email
    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      throw new Error(`Failed to list users: ${listError.message}`);
    }

    const user = users?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    if (!user) {
      throw new Error(`User not found with email: ${email}`);
    }

    console.log(`✅ Found user: ${user.id}`);
    console.log(`📧 Email: ${user.email}`);

    // Step 2: Update password using admin API
    console.log(`🔐 Updating password...`);

    const { data: updateData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );

    if (updateError) {
      throw new Error(`Failed to update password: ${updateError.message}`);
    }

    console.log(`✅ Password updated successfully!`);
    console.log(`\n📝 Summary:`);
    console.log(`   Email: ${email}`);
    console.log(`   New password: ${newPassword}`);
    console.log(`   Updated at: ${new Date().toISOString()}`);

  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Main execution
async function main(): Promise<void> {
  // Get arguments from command line
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`\n📚 Usage:`);
    console.log(`   npm run change-password <email> <new-password>`);
    console.log(`\n📌 Example:`);
    console.log(`   npm run change-password superadmin@art.com MySecurePassword123`);
    console.log(`\n⚠️  Password should be at least 8 characters long\n`);
    process.exit(1);
  }

  const email = args[0];
  const newPassword = args[1];

  // Validate password
  if (newPassword.length < 8) {
    console.error('❌ Password must be at least 8 characters long');
    process.exit(1);
  }

  await changePasswordByEmail(email, newPassword);
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
