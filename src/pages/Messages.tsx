import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, Phone, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { getChatService } from "@/domains/chat/chat.service";
import { getAnalyticsEventsService } from "@/domains/analytics/events.service";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";

const chatService = getChatService();

const Messages = () => {
  const { t } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(searchParams.get("user"));

  // Notification deep-links land on /messages?user=<id>. The state initializer
  // only runs on mount, so also react to the param changing while mounted
  // (e.g. clicking a notification while already on this page).
  const userParam = searchParams.get("user");
  useEffect(() => {
    if (userParam) setSelectedConversation(userParam);
  }, [userParam]);
  const [newMessage, setNewMessage] = useState("");
  const [search, setSearch] = useState("");
  const [peerNameOverride, setPeerNameOverride] = useState<string | null>(null);
  const messagesListRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const conversationsQuery = useQuery({
    queryKey: ["chat-conversations"],
    enabled: isAuthenticated,
    queryFn: async () => {
      const result = await chatService.getConversations();
      if (!result.success || !result.data) throw new Error(result.error || t("messages.failedLoadConversations", { defaultValue: "Failed to load conversations" }));
      return result.data;
    },
  });

  // Resolve the name of a user we're messaging (for new conversations not yet in the list)
  const peerNameQuery = useQuery({
    queryKey: ["chat-peer-name", selectedConversation],
    enabled: isAuthenticated && Boolean(selectedConversation) && !conversationsQuery.data?.some(c => c.participantId === selectedConversation),
    queryFn: async () => {
      // Try to get display name from provider or user profiles
      const result = await apiRequest<{ data: any }>(`/api/providers/by-user/${selectedConversation}`, {
        headers: getJsonHeaders(false),
      });
      if (result.success && result.data?.data?.display_name) {
        return result.data.data.display_name as string;
      }
      return null;
    },
  });

  useEffect(() => {
    if (peerNameQuery.data) setPeerNameOverride(peerNameQuery.data);
  }, [peerNameQuery.data]);

  // Call gate: is there an active booking linking me and this peer? Drives the
  // in-chat Call button (only shown once a real booking exists) and the roles
  // subtitle ("Host · Driver"). Pre-booking discovery chats return
  // hasActiveBooking:false and no button appears.
  const relationshipQuery = useQuery({
    queryKey: ["chat-call-relationship", selectedConversation],
    enabled: isAuthenticated && Boolean(selectedConversation),
    queryFn: async () => {
      const result = await apiRequest<{ hasActiveBooking: boolean; phone: string | null; roles: string[] }>(
        `/api/bookings/relationship?peerUserId=${encodeURIComponent(selectedConversation!)}`,
        { headers: getJsonHeaders(false) },
      );
      if (!result.success || !result.data) return { hasActiveBooking: false, phone: null, roles: [] as string[] };
      return result.data;
    },
  });
  const relationship = relationshipQuery.data;
  const canCall = Boolean(relationship?.hasActiveBooking && relationship?.phone);

  const roleLabel = (role: string): string | null => {
    switch (role) {
      case "host": return t("messages.roleHost", { defaultValue: "Host" });
      case "provider": return t("messages.roleProvider", { defaultValue: "Provider" });
      case "driver": return t("messages.roleDriver", { defaultValue: "Driver" });
      case "guest": return t("messages.roleGuest", { defaultValue: "Guest" });
      default: return null;
    }
  };
  const rolesSubtitle = (relationship?.roles ?? [])
    .map(roleLabel)
    .filter((label): label is string => Boolean(label))
    .join(" · ");

  const messagesQuery = useQuery({
    queryKey: ["chat-conversation", selectedConversation],
    enabled: isAuthenticated && Boolean(selectedConversation) && Boolean(user?.id),
    queryFn: async () => {
      const result = await chatService.getConversation(user!.id, selectedConversation!);
      if (!result.success || !result.data) throw new Error(result.error || t("messages.failedLoadMessages", { defaultValue: "Failed to load messages" }));
      return result.data;
    },
  });

  // Clear the unread badge for the open conversation. Runs when a thread is
  // opened and again when new messages land while it's on screen. Only fires
  // the PATCH when something addressed to me is actually unread, then
  // refreshes the conversation list so the count disappears.
  useEffect(() => {
    if (!user?.id || !selectedConversation) return;
    const hasUnread = (messagesQuery.data || []).some(
      (message) => message.receiverId === user.id && !message.isRead
    );
    if (!hasUnread) return;
    void chatService.markConversationAsRead(selectedConversation).then((result) => {
      if (result.success) {
        void queryClient.invalidateQueries({ queryKey: ["chat-conversations"] });
      }
    });
  }, [messagesQuery.data, selectedConversation, user?.id, queryClient]);

  useEffect(() => {
    if (!user?.id) return;
    const subscription = chatService.subscribeToMessages(user.id, () => {
      void queryClient.invalidateQueries({ queryKey: ["chat-conversations"] });
      if (selectedConversation) {
        void queryClient.invalidateQueries({ queryKey: ["chat-conversation", selectedConversation] });
      }
    });

    return () => subscription.unsubscribe();
  }, [queryClient, selectedConversation, user?.id]);

  // Keep the conversation pane pinned to the bottom when new messages arrive
  // or when the selected conversation changes. We mutate scrollTop on the
  // pane itself rather than calling scrollIntoView on a sentinel — the latter
  // walks up the DOM and pulls the whole page down with it, which was the
  // "page scrolls down whenever I type/select" bug.
  useEffect(() => {
    const el = messagesListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messagesQuery.data, selectedConversation]);

  const handleSend = async () => {
    if (!newMessage.trim() || !selectedConversation || !user?.id) return;
    const result = await chatService.sendMessage(user.id, selectedConversation, newMessage.trim());
    if (!result.success) {
      toast.error(result.error || t("messages.failedSendMessage", { defaultValue: "Failed to send message" }));
      return;
    }
    setNewMessage("");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["chat-conversations"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-conversation", selectedConversation] }),
    ]);
  };

  const filteredConversations = useMemo(() => {
    return (conversationsQuery.data || []).filter((conversation) =>
      conversation.participantName.toLowerCase().includes(search.toLowerCase())
    );
  }, [conversationsQuery.data, search]);

  const selectedName = filteredConversations.find((conversation) => conversation.participantId === selectedConversation)?.participantName
    || conversationsQuery.data?.find((conversation) => conversation.participantId === selectedConversation)?.participantName
    || peerNameOverride;

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  };

  /** WhatsApp-style day separator label: "Today" / "Yesterday" / weekday name
   *  within the last 7 days / full date otherwise. */
  const formatDayLabel = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return t("messages.today", { defaultValue: "Today" });
    if (diffDays === 1) return t("messages.yesterday", { defaultValue: "Yesterday" });
    if (diffDays > 1 && diffDays < 7) {
      return date.toLocaleDateString("en-IN", { weekday: "long" });
    }
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  };

  /** Sort messages oldest→newest (the API may return them in arbitrary order)
   *  and slice them into day-grouped runs so we can render a date separator
   *  before each group. */
  const groupedMessages = useMemo(() => {
    const raw = messagesQuery.data || [];
    const sorted = [...raw].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const groups: Array<{ dayKey: string; dayLabel: string; messages: typeof sorted }> = [];
    for (const message of sorted) {
      const d = new Date(message.createdAt);
      const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = groups[groups.length - 1];
      if (last && last.dayKey === dayKey) {
        last.messages.push(message);
      } else {
        groups.push({ dayKey, dayLabel: formatDayLabel(message.createdAt), messages: [message] });
      }
    }
    return groups;
  }, [messagesQuery.data]);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center p-8">
          <MessageCircle className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
          <h2 className="font-display text-xl font-bold mb-2">{t("messages.signInTitle", { defaultValue: "Sign in to view messages" })}</h2>
          <p className="text-muted-foreground text-sm mb-4">{t("messages.signInSubtitle", { defaultValue: "Chat with hosts and service providers" })}</p>
          <Button className="rounded-full" asChild><Link to="/login">{t("messages.signIn", { defaultValue: "Sign In" })}</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto h-[calc(100vh-4rem)] px-4 py-4 md:py-6">
        <div className="flex h-full border border-border rounded-2xl overflow-hidden bg-background">
          <div className={`${selectedConversation ? "hidden md:flex" : "flex"} flex-col w-full md:w-96 border-r border-border`}>
            <div className="p-4 border-b border-border">
              <h1 className="font-display text-xl font-bold mb-3">{t("messages.title", { defaultValue: "Messages" })}</h1>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("messages.searchPlaceholder", { defaultValue: "Search conversations..." })}
                  className="w-full pl-9 pr-4 py-2.5 bg-muted/50 border border-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {conversationsQuery.isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">{t("messages.loadingConversations", { defaultValue: "Loading conversations..." })}</div>
              ) : filteredConversations.length === 0 ? (
                <div className="p-8 text-center">
                  <MessageCircle className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">{t("messages.noConversations", { defaultValue: "No conversations yet" })}</p>
                </div>
              ) : (
                filteredConversations.map((conversation) => (
                  <button
                    key={conversation.participantId}
                    onClick={() => setSelectedConversation(conversation.participantId)}
                    className={`w-full flex items-center gap-3 p-4 hover:bg-muted/40 transition-colors border-b border-border/50 text-left ${
                      selectedConversation === conversation.participantId ? "bg-primary/5" : ""
                    }`}
                  >
                    <div className="w-11 h-11 rounded-full bg-gradient-to-br from-primary to-primary/70 text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
                      {conversation.participantName.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold truncate">{conversation.participantName}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {new Date(conversation.lastMessageAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{conversation.lastMessage}</p>
                    </div>
                    {conversation.unreadCount > 0 && (
                      <span className="w-5 h-5 bg-primary text-primary-foreground text-[10px] rounded-full flex items-center justify-center font-bold shrink-0">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className={`${selectedConversation ? "flex" : "hidden md:flex"} flex-col flex-1`}>
            {selectedConversation ? (
              <>
                <div className="p-4 border-b border-border flex items-center gap-3">
                  <button onClick={() => setSelectedConversation(null)} className="md:hidden p-1 rounded-lg hover:bg-muted">
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-primary/70 text-primary-foreground flex items-center justify-center text-xs font-bold">
                    {selectedName?.charAt(0) || "U"}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{selectedName || t("messages.conversation", { defaultValue: "Conversation" })}</p>
                    <p className="text-[10px] text-muted-foreground">{rolesSubtitle || t("messages.directMessages", { defaultValue: "Direct messages" })}</p>
                  </div>
                  {canCall && (
                    <a
                      href={`tel:${relationship!.phone}`}
                      onClick={() =>
                        getAnalyticsEventsService().track("provider_call_clicked", {
                          source: "messages_thread",
                          props: { roles: relationship!.roles },
                        })
                      }
                      className="ml-auto shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                      aria-label={t("messages.call", { defaultValue: "Call" })}
                      title={t("messages.call", { defaultValue: "Call" })}
                    >
                      <Phone className="w-4 h-4" />
                    </a>
                  )}
                </div>
                <div
                  ref={messagesListRef}
                  className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-2 bg-[#f5efe6]/40"
                  style={{ overscrollBehavior: "contain" }}
                >
                  {messagesQuery.isLoading ? (
                    <div className="text-sm text-muted-foreground">{t("messages.loadingMessages", { defaultValue: "Loading messages..." })}</div>
                  ) : groupedMessages.length === 0 ? (
                    <div className="text-center text-xs text-muted-foreground py-8">
                      {t("messages.noMessages", { defaultValue: "No messages yet — say hi" })} 👋
                    </div>
                  ) : (
                    groupedMessages.map((group) => (
                      <div key={group.dayKey} className="space-y-1">
                        <div className="flex justify-center my-2">
                          <span className="inline-block px-3 py-1 rounded-full bg-background/80 backdrop-blur text-[10px] font-semibold text-muted-foreground shadow-sm">
                            {group.dayLabel}
                          </span>
                        </div>
                        {group.messages.map((message, idx) => {
                          const isMine = message.senderId === user?.id;
                          const prev = group.messages[idx - 1];
                          const isFirstInRun = !prev || (prev.senderId === user?.id) !== isMine;
                          return (
                            <div
                              key={message.id}
                              className={`flex ${isMine ? "justify-end" : "justify-start"} ${isFirstInRun ? "mt-2" : "mt-0.5"}`}
                            >
                              <div
                                className={`max-w-[75%] px-3 py-2 text-sm shadow-sm whitespace-pre-wrap break-words ${
                                  isMine
                                    ? "bg-primary text-primary-foreground rounded-2xl rounded-br-sm"
                                    : "bg-white text-foreground rounded-2xl rounded-bl-sm border border-border/40"
                                }`}
                              >
                                <p className="leading-snug">{message.content}</p>
                                <p
                                  className={`text-[10px] mt-1 text-right ${
                                    isMine ? "text-primary-foreground/70" : "text-muted-foreground"
                                  }`}
                                >
                                  {formatTime(message.createdAt)}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
                <div className="p-4 border-t border-border">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newMessage}
                      onChange={(event) => setNewMessage(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void handleSend()}
                      placeholder={t("messages.typeMessage", { defaultValue: "Type a message..." })}
                      className="flex-1 px-4 py-3 bg-muted/50 border border-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <Button size="icon" className="rounded-xl shrink-0 h-11 w-11" onClick={() => void handleSend()} disabled={!newMessage.trim()}>
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center p-8">
                  <MessageCircle className="w-16 h-16 text-muted-foreground/20 mx-auto mb-4" />
                  <h3 className="font-display font-semibold text-lg mb-1">{t("messages.yourMessages", { defaultValue: "Your Messages" })}</h3>
                  <p className="text-sm text-muted-foreground">{t("messages.selectConversation", { defaultValue: "Select a conversation to start chatting" })}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Messages;
