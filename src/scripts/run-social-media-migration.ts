// backend/src/scripts/run-social-media-migration.ts
import { supabaseAdmin } from '../utils/supabase';
import * as fs from 'fs';
import * as path from 'path';

async function runMigration() {
  console.log('🚀 Starting social media tables migration...');
  
  try {
    // Read the SQL file
    const sqlPath = path.join(__dirname, 'create-social-media-tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the SQL
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql }).single();
    
    if (error) {
      // If the RPC doesn't exist, try direct execution
      console.log('RPC method not available, trying direct execution...');
      
      // Split SQL into individual statements and execute them
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      for (const statement of statements) {
        console.log('Executing:', statement.substring(0, 50) + '...');
        // Note: Supabase client doesn't support raw SQL execution
        // This will need to be run via psql or Supabase dashboard
      }
      
      console.log('⚠️  Migration SQL prepared but could not be auto-executed.');
      console.log('Please run the SQL in create-social-media-tables.sql via Supabase dashboard or psql');
      return;
    }
    
    console.log('✅ Migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  }
}

runMigration();





