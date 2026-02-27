// backend/src/scripts/check-last-access.ts
// Purpose: Check who last accessed the superadmin@art.com account and when
// Effect: Logs access history and audit trail information to txt file

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Log file path
const LOG_FILE = path.join(process.cwd(), 'superadmin-access-logs.txt');

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

async function checkLastAccess(): Promise<void> {
  try {
    log('🔍 Starting access log analysis for superadmin@art.com...');

    const targetEmail = 'superadmin@art.com';

    // Step 1: Get user auth details
    log('📧 Step 1: Getting user authentication details...');
    const { data: users, error: listError } = await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      log(`❌ Failed to list users: ${listError.message}`);
      return;
    }

    const user = users?.users?.find(u => u.email?.toLowerCase() === targetEmail.toLowerCase());

    if (!user) {
      log(`❌ User ${targetEmail} not found`);
      return;
    }

    log(`✅ User found: ${user.id}`);

    // Step 2: Log all available auth timestamps
    log('⏰ Step 2: Authentication timestamps...');
    log(`   Account created: ${user.created_at}`);
    log(`   Email confirmed: ${user.email_confirmed_at || 'Never'}`);
    log(`   Last sign in: ${user.last_sign_in_at || 'Never'}`);
    log(`   Confirmation sent: ${user.confirmation_sent_at || 'Never'}`);
    log(`   Recovery sent: ${user.recovery_sent_at || 'Never'}`);
    log(`   Email change sent: ${user.email_change_sent_at || 'Never'}`);
    log(`   Phone confirmed: ${user.phone_confirmed_at || 'Never'}`);
    // Note: banned_until property may not be available in User type
    log(`   Banned until: Not available`);

    // Step 3: Check profiles table for additional activity
    log('👤 Step 3: Checking profiles table activity...');
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('email', targetEmail);

    if (profileError) {
      log(`❌ Profile lookup error: ${profileError.message}`);
    } else if (profiles && profiles.length > 0) {
      const profile = profiles[0];
      log(`✅ Profile details:`);
      log(`   Profile ID: ${profile.id}`);
      log(`   Auth User ID: ${profile.auth_user_id}`);
      log(`   Role: ${profile.role}`);
      log(`   Active: ${profile.is_active}`);
      log(`   Created: ${profile.created_at}`);
      log(`   Updated: ${profile.updated_at}`);
      log(`   First Name: ${profile.first_name || 'N/A'}`);
      log(`   Last Name: ${profile.last_name || 'N/A'}`);

      // Check if profile was recently updated
      const updated = new Date(profile.updated_at);
      const now = new Date();
      const hoursSinceUpdate = Math.floor((now.getTime() - updated.getTime()) / (1000 * 60 * 60));

      log(`   Hours since last profile update: ${hoursSinceUpdate}`);

      if (hoursSinceUpdate < 24) {
        log('⚠️  Profile recently updated - possible recent activity');
      }
    }

    // Step 4: Check for audit logs (if available)
    log('📊 Step 4: Checking for audit logs and recent activity...');

    // Check various tables that might have activity logs
    const tablesToCheck = [
      'audit_logs',
      'user_activity',
      'login_history',
      'auth_logs',
      'access_logs'
    ];

    for (const tableName of tablesToCheck) {
      try {
        const { data: logs, error: logError } = await supabaseAdmin
          .from(tableName)
          .select('*')
          .eq('user_id', user.id)
          .or('email,eq,' + targetEmail)
          .order('created_at', { ascending: false })
          .limit(10);

        if (logError) {
          // Table might not exist, skip silently
          continue;
        }

        if (logs && logs.length > 0) {
          log(`✅ Found ${logs.length} entries in ${tableName}:`);
          logs.forEach((entry, index) => {
            log(`   ${index + 1}. ${entry.created_at} - ${JSON.stringify(entry.action || entry.activity || entry.event || 'Unknown action')}`);
            if (entry.ip_address) log(`      IP: ${entry.ip_address}`);
            if (entry.user_agent) log(`      User Agent: ${entry.user_agent}`);
          });
        }
      } catch (err) {
        // Table doesn't exist or access denied
        continue;
      }
    }

    // Step 5: Check recent database activity
    log('🗃️  Step 5: Checking recent database modifications...');

    // Check if there are any audit tables or change logs
    try {
      const { data: recentChanges, error: changeError } = await supabaseAdmin
        .rpc('get_recent_user_activity', { user_email: targetEmail })
        .select('*')
        .limit(20);

      if (!changeError && recentChanges) {
        log(`✅ Found recent activity via RPC:`);
        recentChanges.forEach((change: any, index: number) => {
          log(`   ${index + 1}. ${JSON.stringify(change, null, 2)}`);
        });
      }
    } catch (err) {
      // RPC might not exist
    }

    // Step 6: Check sessions and tokens
    log('🔑 Step 6: Checking active sessions and tokens...');

    try {
      // This is limited info available via admin API
      const { data: userDetails, error: detailError } = await supabaseAdmin.auth.admin.getUserById(user.id);

      if (!detailError && userDetails) {
        log(`✅ User details from admin API:`);
        log(`   Has active session: ${!!userDetails.user?.last_sign_in_at}`);

        if (userDetails.user?.user_metadata) {
          log(`   User metadata: ${JSON.stringify(userDetails.user.user_metadata, null, 2)}`);
        }

        if (userDetails.user?.app_metadata) {
          log(`   App metadata: ${JSON.stringify(userDetails.user.app_metadata, null, 2)}`);
        }
      }
    } catch (err: any) {
      log(`❌ Could not get detailed user info: ${err.message}`);
    }

    // Step 7: Check for IP-based access patterns
    log('🌐 Step 7: Analyzing access patterns...');

    // Try to get login attempts or failed logins
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (user.last_sign_in_at) {
      const lastSignIn = new Date(user.last_sign_in_at);
      const hoursSinceLastSignIn = Math.floor((now.getTime() - lastSignIn.getTime()) / (1000 * 60 * 60));

      log(`   Hours since last successful sign in: ${hoursSinceLastSignIn}`);

      if (hoursSinceLastSignIn < 24) {
        log('✅ Account accessed within last 24 hours');
      } else if (hoursSinceLastSignIn < 168) { // 7 days
        log('⚠️  Account accessed within last week');
      } else {
        log('❌ Account not accessed recently (more than 7 days)');
      }
    } else {
      log('❌ No recorded sign-ins ever');
    }

    // Step 8: Check for suspicious activity
    log('🚨 Step 8: Checking for suspicious activity...');

    const suspiciousIndicators = [];

    if (!user.email_confirmed_at) {
      suspiciousIndicators.push('Unconfirmed email');
    }

    // Note: banned_until property may not be available
    // if (user.banned_until) {
    //   suspiciousIndicators.push('Account currently banned');
    // }

    if (user.recovery_sent_at) {
      const recoverySent = new Date(user.recovery_sent_at);
      const hoursSinceRecovery = Math.floor((now.getTime() - recoverySent.getTime()) / (1000 * 60 * 60));

      if (hoursSinceRecovery < 24) {
        suspiciousIndicators.push('Recent password recovery request');
      }
    }

    const created = new Date(user.created_at);
    const accountAgeDays = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));

    if (accountAgeDays < 1) {
      suspiciousIndicators.push('Very new account (created today)');
    }

    if (suspiciousIndicators.length === 0) {
      log('✅ No suspicious activity indicators found');
    } else {
      log('⚠️  Suspicious activity indicators:');
      suspiciousIndicators.forEach(indicator => log(`   - ${indicator}`));
    }

    // Step 9: Summary
    log('📋 Step 9: Access Analysis Summary');

    const lastActivity = user.last_sign_in_at || user.updated_at || user.created_at;
    const lastActivityDate = new Date(lastActivity);
    const daysSinceActivity = Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24));

    log(`   Last known activity: ${lastActivityDate.toISOString()}`);
    log(`   Days since last activity: ${daysSinceActivity}`);

    if (daysSinceActivity === 0) {
      log('📊 Status: ACTIVE TODAY');
    } else if (daysSinceActivity <= 7) {
      log('📊 Status: RECENTLY ACTIVE');
    } else if (daysSinceActivity <= 30) {
      log('📊 Status: MODERATELY ACTIVE');
    } else {
      log('📊 Status: INACTIVE');
    }

    log('💡 Recommendations:');
    if (!user.last_sign_in_at) {
      log('   - Account has never been signed into');
      log('   - Check if account was created but never used');
    }

    if (suspiciousIndicators.length > 0) {
      log('   - Review suspicious activity indicators');
      log('   - Consider security audit if account compromise is suspected');
    }

    log('   - Check application logs for additional context');
    log('   - Review server access logs for IP addresses');

  } catch (error: any) {
    log(`❌ Unexpected error during access check: ${error.message}`);
    console.error(error);
  }
}

// Main execution
async function main(): Promise<void> {
  log('='.repeat(80));
  log('SUPERADMIN@ART.COM LAST ACCESS ANALYSIS');
  log('='.repeat(80));

  await checkLastAccess();

  log('='.repeat(80));
  log('ACCESS ANALYSIS COMPLETE');
  log('='.repeat(80));
}

main().catch(error => {
  log(`Unexpected error: ${error.message}`);
  process.exit(1);
});
