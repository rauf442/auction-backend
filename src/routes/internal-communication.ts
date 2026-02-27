// backend/src/routes/internal-communication.ts
import express from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Request interfaces - this now matches what authMiddleware sets
interface AuthRequest extends express.Request {
  user?: { id: string; email: string; role: string };
}

interface MessageRequest {
  content: string;
  message_type?: 'text' | 'task' | 'file' | 'system';
  receiver_id?: string;
  department?: string;
  parent_message_id?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  
  // Task-specific fields (matching database schema)
  task_title?: string;
  task_description?: string;
  task_due_date?: string;
  task_assigned_to?: string;
  task_estimated_hours?: number;
  
  // Attachments
  attachments?: any[];
  metadata?: Record<string, any>;
}

interface TaskUpdateRequest {
  task_status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  task_completed_at?: string;
}

// GET /api/internal-communication/messages - Get messages with filtering
router.get('/messages', async (req: AuthRequest, res) => {
  try {
    console.log('Fetching messages for user:', req.user?.id);
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const {
      conversation_id,
      user_id, // Direct user conversation
      message_type = 'all',
      status = 'all',
      sender_id,
      receiver_id,
      department,
      search,
      page = 1,
      limit = 50,
      sort_direction = 'desc'
    } = req.query;

    // Get the auth_user_id (UUID) for current user
    const { data: currentUserProfile, error: currentUserError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (currentUserError || !currentUserProfile?.auth_user_id) {
      console.error('Error fetching current user profile:', currentUserError);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    let query = supabaseAdmin
      .from('messages_with_details')
      .select('*');

    // If user_id is provided, get conversation between current user and specified user
    if (user_id) {
      query = query.or(
        `and(sender_id.eq.${currentUserProfile.auth_user_id},receiver_id.eq.${user_id}),and(sender_id.eq.${user_id},receiver_id.eq.${currentUserProfile.auth_user_id})`
      );
    } else {
      // Otherwise, get all messages involving current user
      query = query.or(
        `sender_id.eq.${currentUserProfile.auth_user_id},receiver_id.eq.${currentUserProfile.auth_user_id},task_assigned_to.eq.${currentUserProfile.auth_user_id}`
      );
    }

    // Apply other filters
    if (conversation_id) {
      query = query.eq('metadata->>conversation_id', conversation_id);
    }

    if (message_type && message_type !== 'all') {
      query = query.eq('message_type', message_type);
    }

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (sender_id) {
      query = query.eq('sender_id', sender_id);
    }

    if (receiver_id) {
      query = query.eq('receiver_id', receiver_id);
    }

    if (department) {
      query = query.eq('department', department);
    }

    if (search) {
      query = query.or(
        `content.ilike.%${search}%,task_title.ilike.%${search}%,task_description.ilike.%${search}%`
      );
    }

    // Apply sorting and pagination - for chat apps, we want oldest first (ascending)
    query = query.order('created_at', { ascending: true });
    
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;
    
    query = query.range(offset, offset + limitNum - 1);

    const { data: messages, error, count } = await query;

    if (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }

    console.log('✅ Fetched messages:', messages?.length || 0);

    res.json({
      data: messages || [], // Frontend expects 'data' field
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error in GET /messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/conversations - Get recent conversations
router.get('/conversations', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { limit = 10 } = req.query;

    // Get the auth_user_id (UUID) for filtering
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (profileError || !profile?.auth_user_id) {
      console.error('Error fetching user profile:', profileError);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    const { data: conversations, error } = await supabaseAdmin
      .rpc('get_recent_conversations', {
        user_id: profile.auth_user_id,
        conversation_limit: parseInt(limit as string)
      });

    if (error) {
      console.error('Error fetching conversations:', error);
      return res.status(500).json({ error: 'Failed to fetch conversations' });
    }

    res.json({ conversations: conversations || [] });
  } catch (error) {
    console.error('Error in GET /conversations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/unread-count - Get unread message count
router.get('/unread-count', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // First get the auth_user_id (UUID) for this user
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (profileError || !profile?.auth_user_id) {
      console.error('Error fetching user profile:', profileError);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    const { data: unreadCount, error } = await supabaseAdmin
      .rpc('get_unread_message_count', {
        user_id: profile.auth_user_id
      });

    if (error) {
      console.error('Error fetching unread count:', error);
      return res.status(500).json({ error: 'Failed to fetch unread count' });
    }

    res.json({ count: unreadCount || 0 }); // Frontend expects 'count' field
  } catch (error) {
    console.error('Error in GET /unread-count:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/messages - Send new message or task
router.post('/messages', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const messageData: MessageRequest = req.body;

    // Validate required fields
    if (!messageData.content && !messageData.task_title) {
      return res.status(400).json({ 
        error: 'Message content or task title is required' 
      });
    }

    // Validate task fields if message_type is 'task'
    if (messageData.message_type === 'task') {
      if (!messageData.task_title || !messageData.task_assigned_to) {
        return res.status(400).json({
          error: 'Task title and assigned user are required for task messages'
        });
      }
    }

    // Get the auth_user_id (UUID) for the sender
    const { data: senderProfile, error: senderError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (senderError || !senderProfile?.auth_user_id) {
      console.error('Error fetching sender profile:', senderError);
      return res.status(500).json({ error: 'Failed to fetch sender profile' });
    }

    // Convert receiver_id if it's provided (could be integer profile id or UUID auth_user_id)
    let receiverAuthUserId = messageData.receiver_id;
    if (messageData.receiver_id) {
      // Check if receiver_id is an integer (profile id) and convert to UUID
      if (!messageData.receiver_id.includes('-')) {
        const { data: receiverProfile, error: receiverError } = await supabaseAdmin
          .from('profiles')
          .select('auth_user_id')
          .eq('id', parseInt(messageData.receiver_id))
          .single();

        if (receiverError || !receiverProfile?.auth_user_id) {
          console.error('Error fetching receiver profile:', receiverError);
          return res.status(400).json({ error: 'Invalid receiver ID' });
        }
        receiverAuthUserId = receiverProfile.auth_user_id;
      }
    }

    // Convert task_assigned_to if it's provided (could be integer profile id or UUID auth_user_id)
    let assignedToAuthUserId = messageData.task_assigned_to;
    if (messageData.task_assigned_to) {
      if (!messageData.task_assigned_to.includes('-')) {
        const { data: assigneeProfile, error: assigneeError } = await supabaseAdmin
          .from('profiles')
          .select('auth_user_id')
          .eq('id', parseInt(messageData.task_assigned_to))
          .single();

        if (assigneeError || !assigneeProfile?.auth_user_id) {
          console.error('Error fetching assignee profile:', assigneeError);
          return res.status(400).json({ error: 'Invalid task assignee ID' });
        }
        assignedToAuthUserId = assigneeProfile.auth_user_id;
      }
    }

    const newMessage = {
      content: messageData.content,
      message_type: messageData.message_type || 'text',
      sender_id: senderProfile.auth_user_id,
      receiver_id: receiverAuthUserId || null,
      department: messageData.department || null,
      parent_message_id: messageData.parent_message_id || null,
      priority: messageData.priority || 'normal',
      status: 'sent',
      task_title: messageData.task_title || null,
      task_description: messageData.task_description || null,
      task_due_date: messageData.task_due_date || null,
      task_assigned_to: assignedToAuthUserId || null,
      task_status: messageData.message_type === 'task' ? 'pending' : null,
      attachments: messageData.attachments || null,
      metadata: messageData.metadata || null
    };

    const { data: message, error } = await supabaseAdmin
      .from('internal_messages')
      .insert([newMessage])
      .select()
      .single();

    if (error) {
      console.error('Error creating message:', error);
      return res.status(500).json({ 
        error: 'Failed to create message',
        details: error.message 
      });
    }

    console.log('✅ Message created successfully:', message.id);
    console.log('📤 Message details:', {
      sender: message.sender_id,
      receiver: message.receiver_id,
      content: message.content,
      type: message.message_type
    });

    res.status(201).json({ message });
  } catch (error) {
    console.error('Error in POST /messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/test-realtime - Test realtime functionality
router.post('/test-realtime', async (req: AuthRequest, res) => {
  try {
    console.log('🧪 Testing realtime functionality...');

    // Create a test message
    const testMessage = {
      content: 'Test realtime message',
      message_type: 'text',
      sender_id: 'test-sender-id',
      receiver_id: 'test-receiver-id',
      status: 'sent',
      priority: 'normal'
    };

    const { data: message, error } = await supabaseAdmin
      .from('internal_messages')
      .insert([testMessage])
      .select()
      .single();

    if (error) {
      console.error('❌ Error creating test message:', error);
      return res.status(500).json({ error: 'Failed to create test message', details: error.message });
    }

    console.log('✅ Test message created:', message.id);
    res.json({ message: 'Test message created', messageId: message.id });
  } catch (error) {
    console.error('❌ Error in test realtime:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/internal-communication/messages/:id - Update message or task
router.put('/messages/:id', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const updateData = req.body;

    // Check if message exists and user has permission to update
    const { data: existingMessage, error: fetchError } = await supabaseAdmin
      .from('internal_messages')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingMessage) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Get the auth_user_id (UUID) for current user
    const { data: currentUserProfile, error: currentUserError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (currentUserError || !currentUserProfile?.auth_user_id) {
      console.error('Error fetching current user profile:', currentUserError);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }

    // Verify permissions
    const canUpdate = 
      existingMessage.sender_id === currentUserProfile.auth_user_id ||
      (existingMessage.task_assigned_to === currentUserProfile.auth_user_id && existingMessage.message_type === 'task') ||
      existingMessage.receiver_id === currentUserProfile.auth_user_id;

    if (!canUpdate) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Handle task completion
    if (updateData.task_status === 'completed' && !updateData.task_completed_at) {
      updateData.task_completed_at = new Date().toISOString();
      updateData.task_completed_by = currentUserProfile.auth_user_id;
    }

    const { data: message, error } = await supabaseAdmin
      .from('internal_messages')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating message:', error);
      return res.status(500).json({ 
        error: 'Failed to update message',
        details: error.message 
      });
    }

    res.json({ message });
  } catch (error) {
    console.error('Error in PUT /messages/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/messages/:id/mark-read - Mark message as read
router.post('/messages/:id/mark-read', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;

    const { data: message, error } = await supabaseAdmin
      .from('internal_messages')
      .update({
        status: 'read',
        read_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('receiver_id', req.user.id) // Only receiver can mark as read
      .select()
      .single();

    if (error) {
      console.error('Error marking message as read:', error);
      return res.status(500).json({ error: 'Failed to mark message as read' });
    }

    res.json({ message });
  } catch (error) {
    console.error('Error in POST /messages/:id/mark-read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/messages/:id/reactions - Add reaction to message
router.post('/messages/:id/reactions', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id } = req.params;
    const { reaction } = req.body;

    if (!reaction) {
      return res.status(400).json({ error: 'Reaction is required' });
    }

    const { data: reactionData, error } = await supabaseAdmin
      .from('message_reactions')
      .insert([{
        message_id: id,
        user_id: req.user.id,
        reaction
      }])
      .select()
      .single();

    if (error) {
      console.error('Error adding reaction:', error);
      return res.status(500).json({ error: 'Failed to add reaction' });
    }

    res.status(201).json({ reaction: reactionData });
  } catch (error) {
    console.error('Error in POST /messages/:id/reactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/internal-communication/messages/:id/reactions/:reaction - Remove reaction
router.delete('/messages/:messageId/reactions/:reaction', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { messageId, reaction } = req.params;

    const { error } = await supabaseAdmin
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', req.user.id)
      .eq('reaction', reaction);

    if (error) {
      console.error('Error removing reaction:', error);
      return res.status(500).json({ error: 'Failed to remove reaction' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in DELETE /messages/:messageId/reactions/:reaction:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/tasks - Get tasks assigned to user
router.get('/tasks', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const {
      status = 'all',
      assigned_by,
      search,
      due_date_from,
      due_date_to,
      priority,
      page = 1,
      limit = 25
    } = req.query;

    let query = supabaseAdmin
      .from('messages_with_details')
      .select('*')
      .eq('message_type', 'task')
      .eq('task_assigned_to', req.user.id);

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('task_status', status);
    }

    if (assigned_by) {
      query = query.eq('sender_id', assigned_by);
    }

    if (priority && priority !== 'all') {
      query = query.eq('priority', priority);
    }

    if (due_date_from) {
      query = query.gte('task_due_date', due_date_from);
    }

    if (due_date_to) {
      query = query.lte('task_due_date', due_date_to);
    }

    if (search) {
      query = query.or(
        `task_title.ilike.%${search}%,task_description.ilike.%${search}%,content.ilike.%${search}%`
      );
    }

    // Apply sorting and pagination - for chat apps, we want oldest first (ascending)
    query = query.order('created_at', { ascending: true });
    
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;
    
    query = query.range(offset, offset + limitNum - 1);

    const { data: tasks, error, count } = await query;

    if (error) {
      console.error('Error fetching tasks:', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }

    res.json({
      tasks,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error in GET /tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/users - Get all users for messaging
router.get('/users', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { search } = req.query;

    let query = supabaseAdmin
      .from('profiles')
      .select('id, auth_user_id, first_name, last_name, email, role, is_active')
      .eq('is_active', true)
      .neq('id', req.user.id); // Exclude current user

    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    query = query.order('first_name');

    const { data: users, error } = await query;

    if (error) {
      console.error('Error fetching users:', error);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    res.json({ users });
  } catch (error) {
    console.error('Error in GET /users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/departments - Get all departments (simplified)
router.get('/departments', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // For now, return common departments until we add department field to profiles
    const departments = [
      'Administration',
      'Sales',
      'Accounting',
      'Operations',
      'IT',
      'Marketing',
      'Customer Service'
    ];

    res.json({ departments });
  } catch (error) {
    console.error('Error in GET /departments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/tasks - Get tasks for current user
router.get('/tasks', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { status, assigned_to_me = 'true' } = req.query;

    // Get the auth_user_id (UUID) for filtering
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', req.user.id)
      .single();

    if (profileError || !profile?.auth_user_id) {
      console.error('Error fetching user profile:', profileError);
      return res.status(500).json({ error: 'Failed to fetch user profile' });
    }
    
    let query = supabaseAdmin
      .from('internal_messages')
      .select(`
        *,
        profiles:sender_id(first_name, last_name, email),
        task_assignee:task_assigned_to(first_name, last_name, email),
        task_comments(id)
      `)
      .eq('message_type', 'task')
      .order('created_at', { ascending: true });

    // Filter by assignment
    if (assigned_to_me === 'true') {
      query = query.eq('task_assigned_to', profile.auth_user_id);
    }

    // Filter by status
    if (status && status !== 'all') {
      query = query.eq('task_status', status);
    }

    const { data: tasks, error } = await query;

    if (error) {
      console.error('Error fetching tasks:', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }

    // Add comment count
    const tasksWithCounts = tasks?.map(task => ({
      ...task,
      comment_count: task.task_comments?.length || 0,
      sender_name: task.profiles ? `${task.profiles.first_name} ${task.profiles.last_name}` : 'Unknown',
      task_assignee_name: task.task_assignee ? `${task.task_assignee.first_name} ${task.task_assignee.last_name}` : 'Unassigned'
    })) || [];

    res.json({ tasks: tasksWithCounts });
  } catch (error) {
    console.error('Error in GET /tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/internal-communication/messages/:id - Update message/task
router.put('/messages/:id', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: messageId } = req.params;
    const updateData = req.body;

    // Get the message to check permissions
    const { data: message, error: fetchError } = await supabaseAdmin
      .from('internal_messages')
      .select('sender_id, task_assigned_to, receiver_id')
      .eq('id', messageId)
      .single();

    if (fetchError || !message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if user can update this message
    const canUpdate = message.sender_id === req.user.id || 
                     message.task_assigned_to === req.user.id || 
                     message.receiver_id === req.user.id;

    if (!canUpdate) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Handle task completion
    if (updateData.task_status === 'completed' && message.task_assigned_to === req.user.id) {
      updateData.task_completed_at = new Date().toISOString();
      updateData.task_completed_by = req.user.id;
    }

    const { data: updatedMessage, error } = await supabaseAdmin
      .from('internal_messages')
      .update({
        ...updateData,
        updated_at: new Date().toISOString()
      })
      .eq('id', messageId)
      .select()
      .single();

    if (error) {
      console.error('Error updating message:', error);
      return res.status(500).json({ error: 'Failed to update message' });
    }

    res.json({ message: updatedMessage });
  } catch (error) {
    console.error('Error in PUT /messages/:id:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/messages/:id/comments - Add comment to task
router.post('/messages/:id/comments', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: messageId } = req.params;
    const { comment } = req.body;

    if (!comment?.trim()) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    // Verify user has access to this message/task
    const { data: message } = await supabaseAdmin
      .from('internal_messages')
      .select('sender_id, receiver_id, task_assigned_to')
      .eq('id', messageId)
      .single();

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check access - user must be sender, receiver, or assigned to the task
    const hasAccess = message.sender_id === req.user.id || 
                     message.receiver_id === req.user.id || 
                     message.task_assigned_to === req.user.id;

    if (!hasAccess) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const { data: newComment, error } = await supabaseAdmin
      .from('task_comments')
      .insert([{
        message_id: messageId,
        user_id: req.user.id,
        comment: comment.trim()
      }])
      .select(`
        *,
        profiles:user_id(first_name, last_name, email)
      `)
      .single();

    if (error) {
      console.error('Error adding comment:', error);
      return res.status(500).json({ error: 'Failed to add comment' });
    }

    res.status(201).json({ comment: newComment });
  } catch (error) {
    console.error('Error in POST /messages/:id/comments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/messages/:id/comments - Get comments for task
router.get('/messages/:id/comments', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { id: messageId } = req.params;

    const { data: comments, error } = await supabaseAdmin
      .from('task_comments')
      .select(`
        *,
        profiles:user_id(first_name, last_name, email)
      `)
      .eq('message_id', messageId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching comments:', error);
      return res.status(500).json({ error: 'Failed to fetch comments' });
    }

    res.json({ comments });
  } catch (error) {
    console.error('Error in GET /messages/:id/comments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/internal-communication/files - Upload files for messages
router.post('/files', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // For now, return a mock response
    // In a real implementation, you would:
    // 1. Handle multipart/form-data uploads
    // 2. Store files in Supabase Storage or another file storage service
    // 3. Create records in a message_attachments table
    
    const files = req.body.files || [];
         const mockAttachments = files.map((file: any, index: number) => ({
       id: `file_${Date.now()}_${index}`,
       name: file.name || 'uploaded_file',
       size: file.size || 0,
       type: file.type || 'application/octet-stream',
       url: `https://example.com/files/${Date.now()}_${index}`,
       uploaded_at: new Date().toISOString(),
       uploaded_by: req.user?.id
     }));

    res.status(201).json({ attachments: mockAttachments });
  } catch (error) {
    console.error('Error in POST /files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/internal-communication/files - Get file attachments
router.get('/files', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { message_id, limit = '20' } = req.query;

    // For now, return mock data
    // In a real implementation, you would query the message_attachments table
         const mockFiles = [
       {
         id: 'file_1',
         name: 'document.pdf',
         size: 1024000,
         type: 'application/pdf',
         url: 'https://example.com/files/document.pdf',
         uploaded_at: new Date().toISOString(),
         uploaded_by: req.user?.id,
         message_id: message_id || null
       }
     ];

    res.json({ files: mockFiles });
  } catch (error) {
    console.error('Error in GET /files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 