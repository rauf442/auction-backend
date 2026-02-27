# Change Superadmin Password Script

## Overview
This script allows you to securely change the password for any Supabase auth user by email address without knowing the current password. Perfect for admin account password resets.

## Prerequisites
- ✅ Supabase project with Service Role Key configured in `.env`
- ✅ Backend environment variables set up:
  - `SUPABASE_URL` - Your Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (from Settings → API)

## Usage

### Basic Command
```bash
npm run change-password <email> <new-password>
```

### Example
Change password for `superadmin@art.com` to `NewSecurePassword123`:
```bash
npm run change-password superadmin@art.com NewSecurePassword123
```

### Full Workflow

1. **Navigate to backend directory:**
   ```bash
   cd backend
   ```

2. **Run the script with email and new password:**
   ```bash
   npm run change-password superadmin@art.com MyNewPassword123
   ```

3. **Expected output:**
   ```
   🔍 Looking up user with email: superadmin@art.com
   ✅ Found user: uuid-12345...
   📧 Email: superadmin@art.com
   🔐 Updating password...
   ✅ Password updated successfully!

   📝 Summary:
      Email: superadmin@art.com
      New password: MyNewPassword123
      Updated at: 2024-01-15T10:30:45.123Z
   ```

## What the Script Does

1. **Validates environment variables** - Checks `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
2. **Finds the user** - Searches Supabase auth for user by email (case-insensitive)
3. **Updates password** - Uses Supabase admin API to set new password
4. **Provides feedback** - Shows success or detailed error messages

## Password Requirements

- ✅ Minimum 8 characters
- ✅ No special restrictions (Supabase will validate)
- ✅ Can contain letters, numbers, symbols

## Error Handling

### "Missing required environment variables"
- Solution: Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `.env`

### "User not found with email"
- Solution: Verify email address exists in Supabase auth users

### "Password must be at least 8 characters long"
- Solution: Use a password with 8+ characters

## Security Notes

⚠️ **Important:**
- This script requires `SUPABASE_SERVICE_ROLE_KEY` - never commit this to git
- Keep the `.env` file with keys secure and only share the command usage, not keys
- The script is intended for admin/staff use only in development/admin environments
- Passwords should meet your organization's security policy

## For Specific Case: superadmin@art.com

To change the superadmin password used in your art platform:

```bash
npm run change-password superadmin@art.com YourNewSecurePassword
```

Then the superadmin can log in with:
- Email: `superadmin@art.com`
- Password: `YourNewSecurePassword`

## Troubleshooting

### Script won't run
- Ensure you're in the `backend` directory
- Run `npm install` to install dependencies
- Check Node.js version is 16+

### "Failed to list users"
- Verify `SUPABASE_SERVICE_ROLE_KEY` is valid and has admin permissions
- Check the key starts with `eyJ` and contains `"role":"service_role"`
- Try refreshing the key from Supabase dashboard

### Still having issues?
Check:
1. `.env` file exists and has correct values
2. Supabase project is accessible
3. User exists in Supabase auth panel
