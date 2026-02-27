# Backend Deployment to Render.com

## Issue Resolution

The error you encountered was because Render was trying to run `node index.js` from the project root instead of using the proper npm scripts and the compiled JavaScript in the `dist` directory.

## What Was Fixed

1. **Updated package.json**: Changed the `main` field from `"index.js"` to `"dist/index.js"`
2. **Created render.yaml**: Added proper deployment configuration for Render
3. **Added documentation**: Created comprehensive environment variables documentation

## Deployment Steps

### 1. Repository Setup
✅ **Already Done!** Your repository is ready with:
- Proper TypeScript compilation configuration
- Fixed package.json main entry point
- render.yaml deployment configuration
- Removed hardcoded superadmin functionality

### 2. Set Up Render Service

1. **Create Account & Service**
   - Go to [Render.com](https://render.com) and sign in
   - Click **"New +"** → **"Web Service"**
   - Connect your GitHub repository (`Msaber`)

2. **Basic Configuration**
   - **Name**: `msaber-backend` (or your preferred name)
   - **Runtime**: `Node`
   - **Build Command**: `cd backend && npm install && npm run build`
   - **Start Command**: `cd backend && npm start`
   - **Root Directory**: Leave empty (uses project root)

3. **Plan Selection**
   - Choose **Free** plan for testing
   - Upgrade to **Starter** ($7/month) for production

### 3. Environment Variables Setup

In your Render service's **Environment** tab, add these variables:

#### **Required Variables:**
```
NODE_ENV=production
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=your-secure-random-jwt-secret
FRONTEND_URL=https://your-frontend-domain.com
```

#### **Optional Variables:**
```
GEMINI_API_KEY=your-gemini-api-key
BACKEND_URL=https://your-render-service.onrender.com
AI_MODEL=gemini-pro
```

### 4. Deploy & Verify

1. **Trigger Deployment**
   - Click **"Create Web Service"**
   - Render will automatically build and deploy

2. **Monitor Deployment**
   - Watch the build logs for any errors
   - Check that TypeScript compilation succeeds
   - Verify the service starts on port 10000

3. **Update BACKEND_URL**
   - After deployment, copy your Render service URL
   - Add it as `BACKEND_URL` environment variable
   - Redeploy to apply the change

### 5. Database Setup

⚠️ **Important**: Before deployment, ensure your Supabase database is ready:

1. **Create Users with Roles**
   - Use Supabase dashboard to create admin users
   - Set their `role` field in the `profiles` table:
     - `super_admin` - Full system access
     - `admin` - Administrative access
     - `accountant` - Accounting access
     - `user` - Standard access

2. **Database Schema**
   - Ensure all required tables exist
   - Verify Row Level Security (RLS) policies
   - Check that `profiles` table has `auth_user_id` and `role` columns

## Post-Deployment Checklist

- [ ] Service is running on Render
- [ ] API endpoints respond correctly
- [ ] Database connection works
- [ ] Authentication works with existing users
- [ ] Frontend can connect to backend
- [ ] Environment variables are properly configured

## Troubleshooting

### Build Failures
- **TypeScript errors**: Check `backend/tsconfig.json` and source files
- **Missing dependencies**: Verify `backend/package.json` dependencies
- **Build command fails**: Check Render build logs for specific errors

### Runtime Errors
- **Database connection**: Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- **Authentication issues**: Check `JWT_SECRET` and user roles
- **Port issues**: Render automatically sets `PORT=10000`

### Common Issues
- **"Cannot find module"**: Ensure `dist/index.js` exists after build
- **"Port already in use"**: Let Render handle port assignment
- **"Database not found"**: Check Supabase project settings

## Alternative: Manual Configuration

If you prefer to configure without `render.yaml`:

1. Set **Root Directory** to `backend`
2. Use these commands:
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`

## Environment Variables Reference

See `ENVIRONMENT_VARIABLES.md` for complete variable documentation.
