// backend/src/scripts/investigate-artwork-password.ts
// Purpose: Investigate why "Artwork2028@" password is not working for superadmin@art.com
// Effect: Logs detailed investigation results to txt file

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Log file path
const LOG_FILE = path.join(process.cwd(), 'artwork-password-investigation.txt');

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

async function investigateArtworkPassword(): Promise<void> {
  try {
    log('🔍 Starting investigation: Why is "Artwork2028@" not working for superadmin@art.com?');

    const targetEmail = 'superadmin@art.com';
    const targetPassword = 'Artwork2028@';

    // Step 1: Verify user exists
    log(`📧 Step 1: Checking if user ${targetEmail} exists...`);
    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      log(`❌ Failed to list users: ${listError.message}`);
      return;
    }

    const user = users?.users?.find(u => u.email?.toLowerCase() === targetEmail.toLowerCase());

    if (!user) {
      log(`❌ User ${targetEmail} not found in auth system`);
      return;
    }

    log(`✅ User found: ${user.id}`);

    // Step 2: Check account status
    log('📊 Step 2: Checking account status...');

    const accountIssues = [];

    if (!user.email_confirmed_at) {
      accountIssues.push('Email not confirmed');
    }

    // Note: banned_until property may not be available in User type
    // if (user.banned_until) {
    //   accountIssues.push(`Account banned until: ${user.banned_until}`);
    // }

    if (user.confirmation_sent_at && !user.email_confirmed_at) {
      accountIssues.push('Confirmation email sent but not confirmed');
    }

    if (accountIssues.length === 0) {
      log('✅ Account status: Active and confirmed');
    } else {
      log(`⚠️  Account issues found: ${accountIssues.join(', ')}`);
    }

    // Step 3: Test the specific password
    log(`🔐 Step 3: Testing password "${targetPassword}"...`);

    let authError: any = null;

    try {
      const { data: authData, error } = await supabaseAdmin.auth.signInWithPassword({
        email: targetEmail,
        password: targetPassword
      });

      authError = error;

      if (authError) {
        log(`❌ Authentication failed: ${authError.message}`);
        log(`   Error code: ${authError.status || 'Unknown'}`);

        // Analyze common failure reasons
        if (authError.message.includes('Invalid login credentials')) {
          log('🔍 Analysis: Invalid login credentials - password is incorrect');
        } else if (authError.message.includes('Email not confirmed')) {
          log('🔍 Analysis: Email not confirmed - account needs verification');
        } else if (authError.message.includes('Too many requests')) {
          log('🔍 Analysis: Rate limited - too many login attempts');
        } else if (authError.message.includes('User not found')) {
          log('🔍 Analysis: User not found in auth system');
        } else {
          log('🔍 Analysis: Unknown authentication error');
        }

      } else {
        log('✅ Password works! Authentication successful.');
        log(`   User ID: ${authData.user?.id}`);
        log(`   Session created: ${!!authData.session}`);
        return; // Exit if password works
      }

    } catch (err: any) {
      log(`❌ Authentication error: ${err.message}`);
      authError = err;
    }

    // Step 4: Check password policy
    log('📋 Step 4: Checking password policy requirements...');

    const password = targetPassword;
    const policyChecks = [
      { check: 'Length >= 8', result: password.length >= 8 },
      { check: 'Contains uppercase', result: /[A-Z]/.test(password) },
      { check: 'Contains lowercase', result: /[a-z]/.test(password) },
      { check: 'Contains number', result: /\d/.test(password) },
      { check: 'Contains special char', result: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password) },
      { check: 'No spaces', result: !/\s/.test(password) }
    ];

    policyChecks.forEach(({ check, result }) => {
      log(`   ${result ? '✅' : '❌'} ${check}`);
    });

    const failedChecks = policyChecks.filter(check => !check.result);
    if (failedChecks.length > 0) {
      log(`⚠️  Password fails policy checks: ${failedChecks.map(c => c.check).join(', ')}`);
    } else {
      log('✅ Password meets all basic policy requirements');
    }

    // Step 5: Check recent password changes
    log('🔄 Step 5: Checking for recent password changes...');

    // Get user details again to check timestamps
    const updatedUser = users?.users?.find(u => u.email?.toLowerCase() === targetEmail.toLowerCase());
    if (updatedUser) {
      const created = new Date(updatedUser.created_at);
      const lastSignIn = updatedUser.last_sign_in_at ? new Date(updatedUser.last_sign_in_at) : null;
      const now = new Date();

      log(`   Account created: ${created.toISOString()}`);
      log(`   Last sign in: ${lastSignIn ? lastSignIn.toISOString() : 'Never'}`);

      if (lastSignIn) {
        const daysSinceLastSignIn = Math.floor((now.getTime() - lastSignIn.getTime()) / (1000 * 60 * 60 * 24));
        log(`   Days since last sign in: ${daysSinceLastSignIn}`);

        if (daysSinceLastSignIn > 30) {
          log('⚠️  Account inactive for more than 30 days - may have been reset');
        }
      }
    }

    // Step 6: Check for password reset requests
    log('📧 Step 6: Checking for recent password reset activity...');

    if (user.recovery_sent_at) {
      const recoverySent = new Date(user.recovery_sent_at);
      const now = new Date();
      const hoursSinceRecovery = Math.floor((now.getTime() - recoverySent.getTime()) / (1000 * 60 * 60));

      log(`   Password recovery sent: ${recoverySent.toISOString()}`);
      log(`   Hours since recovery email: ${hoursSinceRecovery}`);

      if (hoursSinceRecovery < 24) {
        log('⚠️  Recent password recovery request - password may have been changed');
      }
    } else {
      log('✅ No recent password recovery requests');
    }

    // Step 7: Check Supabase auth settings
    log('⚙️  Step 7: Checking auth configuration...');

    try {
      // Try to get auth settings (this might not work with service role)
      const { data: authSettings, error: settingsError } = await supabaseAdmin.auth.admin.getUserById(user.id);

      if (!settingsError && authSettings) {
        log('✅ Auth settings accessible');
        // Note: user_metadata access may be restricted
        // if (authSettings.user?.user_metadata?.password_changed_at) {
        //   log(`   Password last changed: ${authSettings.user.user_metadata.password_changed_at}`);
        // }
      }
    } catch (err: any) {
      log(`❌ Could not access detailed auth settings: ${err.message}`);
    }

    // Step 8: Summary and recommendations
    log('📋 Step 8: Investigation Summary');

    const issues: string[] = [];

    if (!user.email_confirmed_at) issues.push('Email not confirmed');
    // Note: banned_until property may not be available
    // if (user.banned_until) issues.push('Account banned');
    if (authError?.message?.includes('Invalid login credentials')) issues.push('Password incorrect or changed');
    if (failedChecks.length > 0) issues.push('Password policy violations');
    if (user.recovery_sent_at) issues.push('Recent password reset activity');

    if (issues.length === 0) {
      log('✅ No obvious issues found - password should work');
      log('💡 Recommendations:');
      log('   1. Try clearing browser cache/cookies');
      log('   2. Check if caps lock is on');
      log('   3. Try from incognito/private browsing mode');
      log('   4. Contact Supabase support if issue persists');
    } else {
      log('❌ Issues found:');
      issues.forEach(issue => log(`   - ${issue}`));

      log('💡 Recommendations:');
      if (issues.includes('Email not confirmed')) {
        log('   1. Confirm email address');
      }
      if (issues.includes('Account banned')) {
        log('   1. Contact administrator to unban account');
      }
      if (issues.includes('Password incorrect or changed')) {
        log('   1. Reset password using forgot password flow');
        log('   2. Check if password was changed by another admin');
      }
      if (issues.includes('Recent password reset activity')) {
        log('   1. Check email for password reset links');
        log('   2. Complete any pending password reset');
      }
    }

  } catch (error: any) {
    log(`❌ Unexpected error during investigation: ${error.message}`);
    console.error(error);
  }
}

// Main execution
async function main(): Promise<void> {
  log('='.repeat(80));
  log('ARTWORK2028@ PASSWORD INVESTIGATION FOR SUPERADMIN@ART.COM');
  log('='.repeat(80));

  await investigateArtworkPassword();

  log('='.repeat(80));
  log('INVESTIGATION COMPLETE');
  log('='.repeat(80));
}

main().catch(error => {
  log(`Unexpected error: ${error.message}`);
  process.exit(1);
});
