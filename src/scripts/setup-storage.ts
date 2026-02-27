// backend/src/scripts/setup-storage.ts
import { supabaseAdmin } from '../utils/supabase';

const STORAGE_BUCKET = 'artwork-images';

async function setupStorage() {
  try {
    console.log('🏗️  Setting up Supabase storage...');
    
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
    
    if (listError) {
      console.error('❌ Failed to list buckets:', listError);
      return;
    }
    
    const bucketExists = buckets?.some(bucket => bucket.name === STORAGE_BUCKET);
    
    if (bucketExists) {
      console.log(`✅ Storage bucket "${STORAGE_BUCKET}" already exists`);
    } else {
      console.log(`📦 Creating storage bucket "${STORAGE_BUCKET}"...`);
      
      const { data, error } = await supabaseAdmin.storage.createBucket(STORAGE_BUCKET, {
        public: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        fileSizeLimit: 10485760, // 10MB
      });
      
      if (error) {
        console.error('❌ Failed to create bucket:', error);
        return;
      }
      
      console.log(`✅ Storage bucket "${STORAGE_BUCKET}" created successfully`);
    }
    
    // Test upload to verify permissions
    console.log('🧪 Testing upload permissions...');
    const testFile = Buffer.from('test');
    const testPath = `test-${Date.now()}.txt`;
    
    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(testPath, testFile, {
        contentType: 'text/plain',
        upsert: true
      });
    
    if (uploadError) {
      console.error('❌ Upload test failed:', uploadError);
      return;
    }
    
    // Clean up test file
    await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove([testPath]);
    
    console.log('✅ Upload permissions verified');
    console.log('🎉 Storage setup completed successfully!');
    
  } catch (error) {
    console.error('❌ Storage setup failed:', error);
  }
}

// Run the setup
setupStorage().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Setup failed:', error);
  process.exit(1);
});
