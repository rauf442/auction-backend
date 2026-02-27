// src/utils/supabase.ts
import 'dotenv/config'; // ✅ Auto-load .env at startup

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://kxidbthtvjisuhuvokmx.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. Please configure your environment to run the backend.');
}

console.log('🔑 Supabase URL:', supabaseUrl);
console.log('🔑 Service role key present:', !!supabaseKey);

export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});


// Check if we have admin/service role access
const checkAdminAccess = async () => {
  try {
    // Try to access auth.users (requires service role)
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();
    if (error) {
      return false;
    } else {
      console.log('✅ Service role key detected - admin functions available');
      return true;
    }
  } catch (err: any) {
    return false;
  }
};

// Test connection
(async () => {
  try {
    const { data, error } = await supabaseAdmin.from('profiles').select('count');
    if (error) {
      console.error('❌ Supabase connection test failed:', error.message);
    } else {
      console.log('✅ Supabase connection successful');
    }
    
    // Check admin access
    await checkAdminAccess();
  } catch (err: any) {
    console.error('❌ Supabase connection error:', err.message);
  }
})();

// Database types
export interface UserProfile {
  id: string;
  email: string;
  role: 'super_admin' | 'admin' | 'accountant' | 'user';
  is_active: boolean;
  first_name?: string;
  last_name?: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  user: UserProfile | null;
  token: string | null;
  error: string | null;
} 