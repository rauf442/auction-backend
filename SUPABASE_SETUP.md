# Supabase Authentication Setup Guide

## ✅ What We've Done (Proper Architecture)

1. **Removed Custom Password Storage**: No more password hashes in our database
2. **Using Supabase Auth**: All authentication handled by Supabase's secure system
3. **Profiles Table**: Stores user metadata (no passwords) linked to `auth.users`
4. **JWT Integration**: Custom tokens for frontend-backend communication
5. **Trigger Function**: Automatically creates profile when auth user is created

## 🔑 Required: Get Service Role Key

To create admin users programmatically, you need the service role key:

1. Go to [Supabase Dashboard](https://supabase.com/dashboard/project/vfhchlxfmlytylyiglwf)
2. Settings → API → Service Role Key
3. Copy the key (starts with `eyJ...` and contains `"role":"service_role"`)
4. Replace the anon key in `backend/.env`:

```env
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

## 🧑‍💼 Creating Admin User

### Option 1: Manual via Supabase Dashboard (Recommended)
1. Go to [Authentication → Users](https://supabase.com/dashboard/project/vfhchlxfmlytylyiglwf/auth/users)
2. Click "Add User"
3. Email: `admin@msaber.com`
4. Password: `admin123`
5. Email Confirm: ✅ Yes
6. Auto Confirm User: ✅ Yes

The profile will be created automatically by our database trigger.

### Option 2: Programmatic (After getting service key)
```bash
curl -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@msaber.com",
    "password": "admin123", 
    "firstName": "Admin",
    "lastName": "User"
  }'
```

## 🧪 Testing Authentication

1. **Start backend**: `npm run dev` 
2. **Test login**:
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@msaber.com",
    "password": "admin123",
    "remember": false
  }'
```

Expected response:
```json
{
  "user": {
    "id": "uuid-here",
    "email": "admin@msaber.com",
    "role": "admin",
    "is_active": true,
    "first_name": "Admin",
    "last_name": "User"
  },
  "token": "jwt-token-here",
  "error": null
}
```

## 🏗️ Architecture Flow

```
Frontend → Backend API → Supabase Auth
                      ↓
                   auth.users (passwords)
                      ↓  
                   profiles (metadata)
```

**Security Benefits:**
- ✅ No password storage in our code
- ✅ Supabase handles password hashing, salting, security
- ✅ Built-in password reset, email verification
- ✅ Rate limiting and breach protection
- ✅ SOC 2 Type 2 compliance

## 🚀 Next Steps

1. Get service role key from dashboard
2. Create admin user (Option 1 or 2 above)
3. Test login via API or frontend
4. Ready for development! 