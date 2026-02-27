// backend/src/routes/users.ts
import express from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// Protect all users endpoints
router.use(authMiddleware)

// Get all users (profiles)
router.get('/', async (req: any, res) => {
  try {
    const { brand_id } = req.query;
    const baseSelect = `
      id,
      email,
      first_name,
      last_name,
      role,
      position,
      is_active,
      last_activity,
      two_factor_enabled,
      created_at,
      updated_at
    `
    let query: any = supabaseAdmin.from('profiles').select(baseSelect)
    if (brand_id && req.user?.role !== 'super_admin') {
      query = supabaseAdmin
        .from('profiles')
        .select(`${baseSelect},brand_memberships:brand_memberships!inner(brand_id)`) as any
      query = query.eq('brand_memberships.brand_id', brand_id)
    }
    const { data: profiles, error } = await (query as any).order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching users:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch users',
        details: error.message
      });
    }

    res.json({
      success: true,
      data: profiles || []
    });
  } catch (error: any) {
    console.error('Unexpected error in GET /users:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select(`
        id,
        email,
        first_name,
        last_name,
        role,
        position,
        is_active,
        last_activity,
        two_factor_enabled,
        created_at,
        updated_at
      `)
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching user:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch user',
        details: error.message
      });
    }

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      data: profile
    });
  } catch (error: any) {
    console.error('Unexpected error in GET /users/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Create user
router.post('/', async (req, res) => {
  try {
    const {
      email,
      first_name,
      last_name,
      role,
      position,
      is_active = true,
      two_factor_enabled = false
    } = req.body;

    // Validate required fields
    if (!email || !first_name || !last_name || !role) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: email, first_name, last_name, role'
      });
    }

    // Restrict roles to allowed set (admin, user). super_admin is provisioned only via script.
    if (!['admin', 'accountant', 'user'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role. Allowed roles: admin, accountant, user' });
    }

    // Generate a random UUID for auth_user_id (for demo purposes)
    const { data: newProfile, error } = await supabaseAdmin
      .from('profiles')
      .insert({
        auth_user_id: crypto.randomUUID(),
        email,
        first_name,
        last_name,
        role,
        position,
        is_active,
        two_factor_enabled
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating user:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create user',
        details: error.message
      });
    }

    res.status(201).json({
      success: true,
      data: newProfile
    });
  } catch (error: any) {
    console.error('Unexpected error in POST /users:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Update user
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Remove any fields that shouldn't be updated directly
    delete updateData.id;
    delete updateData.auth_user_id;
    delete updateData.created_at;

    // Prevent role elevation via generic update; use /:id/role endpoint instead
    if (typeof updateData.role !== 'undefined') {
      // Validate and limit role changes here as defense-in-depth
      if (updateData.role === 'super_admin') {
        return res.status(403).json({ success: false, error: 'Changing role to super_admin is not allowed via this endpoint' });
      }
      if (!['admin', 'accountant', 'user'].includes(updateData.role)) {
        return res.status(400).json({ success: false, error: 'Invalid role. Allowed roles: admin, accountant, user' });
      }
    }

    // Add updated_at timestamp
    updateData.updated_at = new Date().toISOString();

    const { data: updatedProfile, error } = await supabaseAdmin
      .from('profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating user:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update user',
        details: error.message
      });
    }

    if (!updatedProfile) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      data: updatedProfile
    });
  } catch (error: any) {
    console.error('Unexpected error in PUT /users/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Update user role
router.put('/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: role'
      });
    }

    // Disallow changing super_admin away from that role and disallow setting super_admin via this endpoint
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', id)
      .single();

    if (existingProfile?.role === 'super_admin' || role === 'super_admin') {
      return res.status(403).json({ success: false, error: 'Changing role to/from super_admin is not allowed via this endpoint' });
    }

    const { data: updatedProfile, error } = await supabaseAdmin
      .from('profiles')
      .update({
        role,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating user role:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update user role',
        details: error.message
      });
    }

    if (!updatedProfile) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      data: updatedProfile
    });
  } catch (error: any) {
    console.error('Unexpected error in PUT /users/:id/role:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Delete user (set inactive instead of actually deleting)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: updatedProfile, error } = await supabaseAdmin
      .from('profiles')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error deactivating user:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to deactivate user',
        details: error.message
      });
    }

    if (!updatedProfile) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User deactivated successfully'
    });
  } catch (error: any) {
    console.error('Unexpected error in DELETE /users/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

export default router; 
