// backend/src/services/realtime-chat.ts
import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { supabaseAdmin } from '../utils/supabase';
import jwt from 'jsonwebtoken';

interface AuthenticatedSocket extends Socket {
    userId?: string;
    userProfile?: {
        id: number;
        auth_user_id: string;
        first_name: string;
        last_name: string;
        email: string;
        role: string;
    };
}

interface SocketData {
    userId: string;
    userProfile: any;
}

class RealtimeChatService {
    private io: SocketIOServer;
    private userSockets: Map<string, string[]> = new Map(); // userId -> socketIds[]
    private realtimeChannel: any;

    constructor(server: HTTPServer) {
        this.io = new SocketIOServer(server, {
            cors: {
                origin: [
                    process.env.FRONTEND_URL || 'http://localhost:3000',
                    'http://localhost:3000',
                    'https://invoice.aurumauctions.com',
                    'https://invoice.metsabauctions.com'
                ],
                credentials: true
            },
            transports: ['websocket', 'polling']
        });

        this.setupSocketHandlers();
        this.setupSupabaseSubscription();
    }

    private async setupSocketHandlers() {
        this.io.use(async (socket: any, next) => {
            try {
                const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

                if (!token) {
                    return next(new Error('Authentication token required'));
                }

                // Verify JWT token
                const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

                // Get user profile from database
                const { data: userProfile, error } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .eq('id', decoded.userId)
                    .single();

                if (error || !userProfile) {
                    return next(new Error('Invalid user'));
                }

                socket.userId = userProfile.auth_user_id;
                socket.userProfile = userProfile;
                next();
            } catch (error) {
                console.error('Socket authentication error:', error);
                next(new Error('Authentication failed'));
            }
        });

        this.io.on('connection', (socket: any) => {
            console.log(`🔌 User connected: ${socket.userProfile?.first_name} ${socket.userProfile?.last_name} (${socket.id})`);
            console.log(`🔌 User ID: ${socket.userId}, joining room: user:${socket.userId}`);

            // Track user socket connections
            const userId = socket.userId;
            if (!this.userSockets.has(userId)) {
                this.userSockets.set(userId, []);
            }
            this.userSockets.get(userId)!.push(socket.id);
            console.log(`🔌 Active connections for user ${userId}:`, this.userSockets.get(userId));

            // Join user to their personal room
            socket.join(`user:${userId}`);
            console.log(`🔌 Socket ${socket.id} joined room user:${userId}`);

            // Handle typing indicators
            socket.on('typing:start', (data: { receiverId: string }) => {
                socket.to(`user:${data.receiverId}`).emit('user:typing', {
                    userId: socket.userId,
                    userName: `${socket.userProfile.first_name} ${socket.userProfile.last_name}`,
                    isTyping: true
                });
            });

            socket.on('typing:stop', (data: { receiverId: string }) => {
                socket.to(`user:${data.receiverId}`).emit('user:typing', {
                    userId: socket.userId,
                    userName: `${socket.userProfile.first_name} ${socket.userProfile.last_name}`,
                    isTyping: false
                });
            });

            // Handle message read status
            socket.on('message:read', async (data: { messageId: string }) => {
                try {
                    const { error } = await supabaseAdmin
                        .from('internal_messages')
                        .update({
                            status: 'read',
                            read_at: new Date().toISOString()
                        })
                        .eq('id', data.messageId)
                        .eq('receiver_id', socket.userId);

                    if (!error) {
                        // Notify sender that message was read
                        const { data: message } = await supabaseAdmin
                            .from('internal_messages')
                            .select('sender_id')
                            .eq('id', data.messageId)
                            .single();

                        if (message) {
                            socket.to(`user:${message.sender_id}`).emit('message:read', {
                                messageId: data.messageId,
                                readBy: socket.userId,
                                readAt: new Date().toISOString()
                            });
                        }
                    }
                } catch (error) {
                    console.error('Error marking message as read:', error);
                }
            });

            // Handle user presence
            socket.on('user:online', () => {
                socket.broadcast.emit('user:status', {
                    userId: socket.userId,
                    status: 'online',
                    lastSeen: new Date().toISOString()
                });
            });

            socket.on('disconnect', () => {
                console.log(`🔌 User disconnected: ${socket.userProfile?.first_name} ${socket.userProfile?.last_name} (${socket.id})`);

                // Remove socket from user's socket list
                const userSocketIds = this.userSockets.get(userId) || [];
                const filteredSockets = userSocketIds.filter(id => id !== socket.id);

                if (filteredSockets.length === 0) {
                    this.userSockets.delete(userId);
                    // User is completely offline
                    socket.broadcast.emit('user:status', {
                        userId: socket.userId,
                        status: 'offline',
                        lastSeen: new Date().toISOString()
                    });
                } else {
                    this.userSockets.set(userId, filteredSockets);
                }
            });
        });
    }

    private async setupSupabaseSubscription() {
        try {
            console.log('🔄 Setting up Supabase realtime subscription...');

            // Subscribe to all changes in internal_messages table
            this.realtimeChannel = supabaseAdmin
                .channel('internal_messages_changes')
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'internal_messages'
                    },
                    async (payload) => {
                        console.log('📨 Database change detected:', payload.eventType, (payload.new as any)?.id);
                        console.log('📨 Full payload:', JSON.stringify(payload, null, 2));
                        await this.handleMessageChange(payload);
                    }
                )
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'message_reactions'
                    },
                    async (payload) => {
                        console.log('👍 Reaction change detected:', payload.eventType);
                        await this.handleReactionChange(payload);
                    }
                )
                .subscribe((status, err) => {
                    console.log('📡 Supabase realtime subscription status:', status);
                    if (err) {
                        console.error('❌ Supabase realtime subscription error:', err);
                    }
                    if (status === 'SUBSCRIBED') {
                        console.log('✅ Successfully subscribed to realtime changes');
                    } else if (status === 'CHANNEL_ERROR') {
                        console.error('❌ Channel error in realtime subscription');
                    } else if (status === 'TIMED_OUT') {
                        console.error('❌ Realtime subscription timed out');
                    } else if (status === 'CLOSED') {
                        console.error('❌ Realtime subscription closed');
                    }
                });

        } catch (error) {
            console.error('❌ Error setting up Supabase subscription:', error);
        }
    }

    private async handleMessageChange(payload: any) {
        try {
            const { eventType, new: newMessage, old: oldMessage } = payload;
            console.log('🔄 Handling message change:', eventType, 'Message ID:', newMessage?.id);

            if (eventType === 'INSERT' && newMessage) {
                console.log('📝 Fetching message details from messages_with_details view...');

                // Get full message details with sender/receiver info
                const { data: messageWithDetails, error } = await supabaseAdmin
                    .from('messages_with_details')
                    .select('*')
                    .eq('id', newMessage.id)
                    .single();

                if (error) {
                    console.error('❌ Error fetching message details:', error);
                    return;
                }

                if (messageWithDetails) {
                    console.log('✅ Message details fetched:', messageWithDetails.sender_name, '->', messageWithDetails.receiver_name);
                    // Notify receiver
                    if (messageWithDetails.receiver_id) {
                        console.log('📤 Emitting message:new to receiver:', messageWithDetails.receiver_id);
                        this.io.to(`user:${messageWithDetails.receiver_id}`).emit('message:new', messageWithDetails);
                    }

                    // Notify sender (for confirmation)
                    if (messageWithDetails.sender_id) {
                        console.log('📤 Emitting message:sent to sender:', messageWithDetails.sender_id);
                        this.io.to(`user:${messageWithDetails.sender_id}`).emit('message:sent', messageWithDetails);
                    }

                    // For task assignments, notify the assigned user
                    if (messageWithDetails.task_assigned_to && messageWithDetails.task_assigned_to !== messageWithDetails.receiver_id) {
                        this.io.to(`user:${messageWithDetails.task_assigned_to}`).emit('task:assigned', messageWithDetails);
                    }
                }
            } else if (eventType === 'UPDATE' && newMessage) {
                // Get updated message details
                const { data: messageWithDetails } = await supabaseAdmin
                    .from('messages_with_details')
                    .select('*')
                    .eq('id', newMessage.id)
                    .single();

                if (messageWithDetails) {
                    // Broadcast update to all relevant users
                    const usersToNotify = new Set([
                        messageWithDetails.sender_id,
                        messageWithDetails.receiver_id,
                        messageWithDetails.task_assigned_to
                    ].filter(Boolean));

                    usersToNotify.forEach(userId => {
                        this.io.to(`user:${userId}`).emit('message:updated', messageWithDetails);
                    });

                    // Special notification for task status changes
                    if (oldMessage?.task_status !== newMessage.task_status) {
                        usersToNotify.forEach(userId => {
                            this.io.to(`user:${userId}`).emit('task:status_changed', {
                                messageId: newMessage.id,
                                oldStatus: oldMessage?.task_status,
                                newStatus: newMessage.task_status,
                                message: messageWithDetails
                            });
                        });
                    }
                }
            } else if (eventType === 'DELETE' && oldMessage) {
                // Notify about message deletion
                const usersToNotify = new Set([
                    oldMessage.sender_id,
                    oldMessage.receiver_id,
                    oldMessage.task_assigned_to
                ].filter(Boolean));

                usersToNotify.forEach(userId => {
                    this.io.to(`user:${userId}`).emit('message:deleted', {
                        messageId: oldMessage.id
                    });
                });
            }
        } catch (error) {
            console.error('Error handling message change:', error);
        }
    }

    private async handleReactionChange(payload: any) {
        try {
            const { eventType, new: newReaction, old: oldReaction } = payload;

            if (eventType === 'INSERT' && newReaction) {
                // Get message details to know who to notify
                const { data: message } = await supabaseAdmin
                    .from('internal_messages')
                    .select('sender_id, receiver_id, task_assigned_to')
                    .eq('id', newReaction.message_id)
                    .single();

                if (message) {
                    const usersToNotify = new Set([
                        message.sender_id,
                        message.receiver_id,
                        message.task_assigned_to
                    ].filter(Boolean));

                    usersToNotify.forEach(userId => {
                        this.io.to(`user:${userId}`).emit('reaction:added', {
                            messageId: newReaction.message_id,
                            reaction: newReaction.reaction,
                            userId: newReaction.user_id
                        });
                    });
                }
            } else if (eventType === 'DELETE' && oldReaction) {
                // Similar handling for reaction removal
                const { data: message } = await supabaseAdmin
                    .from('internal_messages')
                    .select('sender_id, receiver_id, task_assigned_to')
                    .eq('id', oldReaction.message_id)
                    .single();

                if (message) {
                    const usersToNotify = new Set([
                        message.sender_id,
                        message.receiver_id,
                        message.task_assigned_to
                    ].filter(Boolean));

                    usersToNotify.forEach(userId => {
                        this.io.to(`user:${userId}`).emit('reaction:removed', {
                            messageId: oldReaction.message_id,
                            reaction: oldReaction.reaction,
                            userId: oldReaction.user_id
                        });
                    });
                }
            }
        } catch (error) {
            console.error('Error handling reaction change:', error);
        }
    }

    // Method to send system notifications
    public sendSystemNotification(userId: string, notification: any) {
        this.io.to(`user:${userId}`).emit('system:notification', notification);
    }

    // Method to get online users
    public getOnlineUsers(): string[] {
        return Array.from(this.userSockets.keys());
    }

    // Method to check if user is online
    public isUserOnline(userId: string): boolean {
        return this.userSockets.has(userId);
    }

    // Clean up
    public destroy() {
        if (this.realtimeChannel) {
            this.realtimeChannel.unsubscribe();
        }
        this.io.close();
    }
}

export default RealtimeChatService;
