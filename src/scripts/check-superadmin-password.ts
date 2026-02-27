// backend/src/scripts/check-superadmin-password.ts
// Purpose: Check current password status and account details for superadmin@art.com
// Effect: Logs account information and password verification results to txt file

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Log file path
const LOG_FILE = path.join(process.cwd(), 'superadmin-password-check.txt');

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  const error = '❌ Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY';
  console.error(error);
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${error}\n`);
  process.exit(1);
}

// Initialize Supabase admin client
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function log(message: string): void {
  const timestampedMessage = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  fs.appendFileSync(LOG_FILE, timestampedMessage + '\n');
}

async function checkSuperAdminAccount(): Promise<void> {
  try {
    log('🔍 Starting superadmin@art.com account analysis...');

    // Step 1: Get user details from auth.users
    log('📧 Looking up user in auth.users table...');
    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      log(`❌ Failed to list users: ${listError.message}`);
      return;
    }

    const user = users?.users?.find(u => u.email?.toLowerCase() === 'superadmin@art.com');

    if (!user) {
      log('❌ User superadmin@art.com not found in auth.users');
      return;
    }

    log(`✅ Found user:`);
    log(`   User ID: ${user.id}`);
    log(`   Email: ${user.email}`);
    log(`   Email Confirmed: ${user.email_confirmed_at ? 'Yes' : 'No'}`);
    log(`   Created: ${user.created_at}`);
    log(`   Last Sign In: ${user.last_sign_in_at || 'Never'}`);
    log(`   User Metadata: ${JSON.stringify(user.user_metadata, null, 2)}`);
    log(`   App Metadata: ${JSON.stringify(user.app_metadata, null, 2)}`);

    // Step 2: Check profiles table
    log('👤 Checking profiles table...');
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('email', 'superadmin@art.com');

    if (profileError) {
      log(`❌ Profile lookup error: ${profileError.message}`);
    } else if (!profiles || profiles.length === 0) {
      log('❌ No profile found in profiles table');
    } else {
      const profile = profiles[0];
      log(`✅ Found profile:`);
      log(`   Profile ID: ${profile.id}`);
      log(`   Role: ${profile.role}`);
      log(`   Active: ${profile.is_active}`);
      log(`   First Name: ${profile.first_name || 'N/A'}`);
      log(`   Last Name: ${profile.last_name || 'N/A'}`);
      log(`   Created: ${profile.created_at}`);
      log(`   Updated: ${profile.updated_at}`);
    }

    // Step 3: Test known passwords (we cannot see the actual password, but can test authentication)
    log('🔐 Testing password authentication with common passwords...');

    const testPasswords = [
      'Artwork2028@',
      'Admin123!',
      'Password123!',
      'SuperAdmin2024!',
      'Art2024@',
      'Admin@2024'
    ];

    for (const testPassword of testPasswords) {
      try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
          email: 'superadmin@art.com',
          password: testPassword
        });

        if (authError) {
          log(`❌ Password "${testPassword}" failed: ${authError.message}`);
        } else {
          log(`✅ Password "${testPassword}" WORKS! User authenticated successfully.`);
          log(`   Session created: ${!!authData.session}`);
          break; // Stop testing once we find a working password
        }
      } catch (err: any) {
        log(`❌ Password "${testPassword}" error: ${err.message}`);
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Step 4: Check password reset tokens or sessions
    log('🔑 Checking for active sessions or reset tokens...');
    try {
      const { data: sessions, error: sessionError } = await supabaseAdmin.auth.admin.listUsers();
      if (!sessionError && sessions) {
        const superAdminUser = sessions.users.find(u => u.email === 'superadmin@art.com');
        if (superAdminUser) {
          log(`📊 User session status: ${JSON.stringify({
            last_sign_in_at: superAdminUser.last_sign_in_at,
            email_confirmed_at: superAdminUser.email_confirmed_at,
            recovery_sent_at: superAdminUser.recovery_sent_at
          }, null, 2)}`);
        }
      }
    } catch (err: any) {
      log(`❌ Session check error: ${err.message}`);
    }

    log('✅ Account analysis complete. Check the log file for full details.');

  } catch (error: any) {
    log(`❌ Unexpected error: ${error.message}`);
    console.error(error);
  }
}

// Main execution
async function main(): Promise<void> {
  log('='.repeat(80));
  log('SUPERADMIN@ART.COM PASSWORD AND ACCOUNT ANALYSIS');
  log('='.repeat(80));

  await checkSuperAdminAccount();

  log('='.repeat(80));
  log('ANALYSIS COMPLETE');
  log('='.repeat(80));
}

main().catch(error => {
  log(`Unexpected error: ${error.message}`);
  process.exit(1);
});
