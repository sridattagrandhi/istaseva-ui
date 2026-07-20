/**
 * Chat / Messaging Domain Service
 */

import { getRealtimeProvider } from "@/config/providers";
import type { RealtimeSubscription } from "@/providers/realtime/realtime.interface";
import type { Conversation, Message, ServiceResult, UUID } from "@/types/domain";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

export class ChatService {
  private realtime = getRealtimeProvider();

  async getConversations(): Promise<ServiceResult<Conversation[]>> {
    const result = await apiRequest<{ data: any[] }>("/api/chat/conversations", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: (result.data.data || []).map((row) => ({
        participantId: row.other_user_id,
        participantName: row.participant_name || `User ${String(row.other_user_id).slice(0, 8)}`,
        lastMessage: row.content,
        lastMessageAt: row.created_at,
        unreadCount: row.unread_count || 0,
      })),
    };
  }

  async sendMessage(_senderId: UUID, receiverId: UUID, content: string): Promise<ServiceResult<Message>> {
    const result = await apiRequest<{ data: any }>("/api/chat/messages", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        receiver_id: receiverId,
        content,
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapMessage(result.data.data) };
  }

  async getConversation(_userId: UUID, otherUserId: UUID): Promise<ServiceResult<Message[]>> {
    const result = await apiRequest<{ data: any[] }>(`/api/chat/conversations/${otherUserId}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapMessage) };
  }

  async markConversationAsRead(otherUserId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ data: any }>(`/api/chat/conversations/${otherUserId}/read`, {
      method: "PATCH",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  async markAsRead(messageId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ data: any }>(`/api/chat/messages/${messageId}/read`, {
      method: "PATCH",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  subscribeToMessages(userId: UUID, callback: (message: Message) => void): RealtimeSubscription {
    // Per-user channel (SEC-005): the server publishes each message to the
    // sender's and receiver's own `user:<id>:messages` channels and rejects
    // subscriptions to channels not owned by the connection's user. The
    // participant check below is defense-in-depth, no longer the boundary.
    return this.realtime.subscribeToChannel(`user:${userId}:messages`, (payload: any) => {
      const row = payload.new || payload;
      if (row?.receiver_id === userId || row?.sender_id === userId) {
        callback(this.mapMessage(row));
      }
    });
  }

  private mapMessage(row: any): Message {
    return {
      id: row.id,
      senderId: row.sender_id,
      receiverId: row.receiver_id,
      content: row.content,
      isRead: row.is_read,
      createdAt: row.created_at,
    };
  }
}

let _instance: ChatService | null = null;
export function getChatService(): ChatService {
  if (!_instance) _instance = new ChatService();
  return _instance;
}
