# Quick Reference: Change Superadmin Password

## TL;DR
```bash
cd backend
npm run change-password superadmin@art.com NewPassword123
```

## Script Location
- **File**: `backend/src/scripts/change-superadmin-password.ts`
- **NPM Script**: `npm run change-password`

## What It Does
✅ Finds Supabase auth user by email address  
✅ Changes password without needing current password  
✅ Works with service role key (admin access)  

## Requirements
- `SUPABASE_URL` in `.env`
- `SUPABASE_SERVICE_ROLE_KEY` in `.env`
- Backend directory (`cd backend` first)

## Command Format
```
npm run change-password <email> <new-password>
```

## Example
```bash
npm run change-password superadmin@art.com MySecurePass2024
```

## Output
```
🔍 Looking up user with email: superadmin@art.com
✅ Found user: [UUID]
📧 Email: superadmin@art.com
🔐 Updating password...
✅ Password updated successfully!

📝 Summary:
   Email: superadmin@art.com
   New password: MySecurePass2024
   Updated at: [timestamp]
```

## Errors & Solutions

| Error | Solution |
|-------|----------|
| Missing required environment variables | Add keys to `.env` file |
| User not found with email | Check email exists in Supabase auth |
| Password must be at least 8 characters | Use longer password (8+ chars) |

## Full Documentation
See `CHANGE_PASSWORD_SCRIPT.md` for complete details
