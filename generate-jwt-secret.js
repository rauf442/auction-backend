#!/usr/bin/env node

/**
 * JWT Secret Generator
 * Generates cryptographically secure JWT secrets
 */

const crypto = require('crypto');

function generateJWTSecret(length = 64, encoding = 'hex') {
  const secret = crypto.randomBytes(length).toString(encoding);
  console.log(`\n🔐 Generated JWT Secret (${encoding.toUpperCase()}):\n`);
  console.log(secret);
  console.log(`\n📏 Length: ${secret.length} characters`);
  console.log(`📝 Add to your environment variables as:`);
  console.log(`JWT_SECRET=${secret}`);
  console.log(`\n⚠️  Store this securely - treat it like a password!\n`);
}

// Generate secrets in different formats
console.log('=== JWT Secret Generator ===\n');

console.log('1. HEX Format (Longer, more secure):');
generateJWTSecret(64, 'hex');

console.log('\n' + '='.repeat(50) + '\n');

console.log('2. Base64URL Format (URL-safe):');
generateJWTSecret(48, 'base64url');

console.log('\n' + '='.repeat(50) + '\n');
console.log('💡 Tip: Use the hex version for maximum security');
console.log('🔄 Run: node generate-jwt-secret.js');
