// design/api/chat.ts — peer messaging (host/provider ↔ guest) against /api/chat.
// Conversations are keyed by the OTHER party's user id (a Firebase uid / TEXT,
// not a UUID), created implicitly on first message. Mirrors web src/domains/chat.
import { api } from "@/lib/api";

export type Conversation = {
  otherUserId: string;
  name: string;
  last: string;
  at: string;        // ISO timestamp of last message
  unread: number;
};

export type ChatMessage = {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  createdAt: string; // ISO
};

function mapMessage(m: any): ChatMessage {
  return {
    id: String(m.id),
    senderId: String(m.sender_id),
    receiverId: String(m.receiver_id),
    content: m.content ?? "",
    createdAt: m.created_at,
  };
}

/** Conversation list for the Messages tab (newest first, server-ordered). */
export async function fetchConversations(limit = 50): Promise<Conversation[]> {
  const res = await api.get("/api/chat/conversations", { params: { limit } });
  const items = res.data?.data ?? [];
  return (Array.isArray(items) ? items : []).map((c: any) => ({
    otherUserId: String(c.other_user_id),
    name: c.participant_name || "Conversation",
    last: c.content || "",
    at: c.created_at,
    unread: Number(c.unread_count || 0),
  }));
}

/** Messages in one thread. Server returns newest-first; callers sort ascending. */
export async function fetchMessages(otherUserId: string, before?: string): Promise<ChatMessage[]> {
  const res = await api.get(`/api/chat/conversations/${otherUserId}`, {
    params: { limit: 100, ...(before ? { before } : {}) },
  });
  const items = res.data?.data ?? [];
  return (Array.isArray(items) ? items : []).map(mapMessage);
}

export async function sendMessage(receiverId: string, content: string): Promise<ChatMessage> {
  const res = await api.post("/api/chat/messages", { receiver_id: receiverId, content });
  return mapMessage(res.data?.data ?? res.data);
}

/** Clear the unread badge for a thread (called when it opens). Best-effort. */
export async function markConversationRead(otherUserId: string): Promise<void> {
  await api.patch(`/api/chat/conversations/${otherUserId}/read`);
}

/** Short relative time for the conversation list ("2m", "1h", "3d"). */
export function ago(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
