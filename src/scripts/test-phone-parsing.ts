// backend/src/scripts/test-phone-parsing.ts
import { parsePhoneNumber } from 'libphonenumber-js';

// Test the phone number parsing logic
function sanitizePhoneNumber(raw: any): string | null {
  if (raw === undefined || raw === null || raw === '') return null;

  try {
    const rawString = String(raw).trim();

    // Handle formats like: "92 (321)2119000", "1 (917)7210426", "1 2013883534", "1 (832) 438-4118"
    // First, clean the string by removing extra spaces, parentheses, dashes, etc.
    let cleaned = rawString
      .replace(/[()\-\s]/g, '') // Remove parentheses, dashes, and spaces
      .replace(/,/g, '') // Remove commas
      .replace(/\./g, ''); // Remove dots

    // If it's just digits, try to parse it
    if (/^\d+$/.test(cleaned)) {
      // First check for known country codes manually (libphonenumber-js may not recognize some)
      if (cleaned.startsWith('92') && cleaned.length === 12) {
        // Pakistan: 92 + 10 digits
        return `92 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('91') && cleaned.length === 12) {
        // India: 91 + 10 digits
        return `91 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('44') && cleaned.length >= 11) {
        // UK: 44 + remaining digits
        return `44 ${cleaned.substring(2)}`;
      }

      // Try to parse as international number using libphonenumber-js
      try {
        const phoneNumber = parsePhoneNumber(cleaned, 'US'); // Default to US, but it will detect country
        if (phoneNumber && phoneNumber.isValid()) {
          // Format as [Country code] [phone] like "92 3212119000" or "1 8324384118"
          const countryCode = phoneNumber.countryCallingCode;
          const nationalNumber = phoneNumber.nationalNumber;

          // Special handling for specific country codes to ensure proper formatting
          if (countryCode === '1' && nationalNumber.length === 10) {
            // US: 1 + 10 digits
            return `1 ${nationalNumber}`;
          } else {
            // Default formatting for other countries
            return `${countryCode} ${nationalNumber}`;
          }
        }
      } catch (parseError) {
        // If parsing fails, try to manually extract country code and number
        if (cleaned.length >= 10) {
          // Assume first 1-3 digits are country code, rest is phone number
          let countryCode = '';
          let phoneNumber = '';

          if (cleaned.startsWith('1') && cleaned.length === 11) {
            // US number: 1 + 10 digits
            countryCode = '1';
            phoneNumber = cleaned.substring(1);
          } else if (cleaned.length === 10) {
            // Assume US number without country code
            countryCode = '1';
            phoneNumber = cleaned;
          } else {
            // Try to detect country code length
            const possibleCountryCodes = ['1', '92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
            for (const code of possibleCountryCodes) {
              if (cleaned.startsWith(code)) {
                const remaining = cleaned.substring(code.length);
                if (remaining.length >= 7 && remaining.length <= 10) {
                  countryCode = code;
                  phoneNumber = remaining;
                  break;
                }
              }
            }
          }

          if (countryCode && phoneNumber) {
            return `${countryCode} ${phoneNumber}`;
          }
        }
      }
    }

    // If all parsing fails, return the cleaned digits-only version
    const digitsOnly = cleaned.replace(/\D/g, '');
    return digitsOnly.length > 0 ? digitsOnly : null;

  } catch (error) {
    console.error('Error parsing phone number:', raw, error);
    // Fallback to basic digit extraction
    const digits = String(raw).replace(/\D+/g, '');
    return digits.length > 0 ? digits : null;
  }
}

// Test cases from user
const testCases = [
  '92 (321)2119000',
  '1 (917)7210426',
  '1 2013883534',
  '1 (832) 438-4118',
  '(555) 123-4567', // Should become 1 5551234567
  '44 20 7946 0958', // UK number
  '91 9876543210', // Indian number
];

console.log('🧪 Testing Phone Number Parsing:');
console.log('=====================================');

testCases.forEach((testCase, index) => {
  const result = sanitizePhoneNumber(testCase);
  console.log(`${index + 1}. "${testCase}" -> "${result}"`);
});

console.log('\n✅ Phone number parsing test completed!');
