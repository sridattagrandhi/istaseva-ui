import { useRef, useEffect } from "react";
import { Bot, User } from "lucide-react";
import { ConversationMessage } from "@/hooks/useConversationEngine";

interface ConversationPanelProps {
  messages: ConversationMessage[];
  isProcessing: boolean;
  interimTranscript: string;
  onOptionClick: (value: string, label: string) => void;
}

const ConversationPanel = ({ messages, isProcessing, interimTranscript, onOptionClick }: ConversationPanelProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // On first mount, land on the most recent message. When the AI page opens
  // with an existing conversation, the user should see the latest exchange,
  // not the top of the history. Instant (no smooth) so there's no visible
  // scroll animation on entry. Runs once; the near-bottom effect below owns
  // every subsequent update.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  // Auto-scroll only when the user is already near the bottom — otherwise
  // they're reading older messages and we'd yank them away every time the
  // interim transcript or a new chunk arrives. Threshold matches typical
  // chat UIs (≈ one bubble height).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, isProcessing, interimTranscript]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto overscroll-contain px-4 py-4"
    >
      <div className="max-w-2xl mx-auto space-y-3">
        {messages.map((msg, idx) => (
          <div
            key={msg.id}
            className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-2 duration-300`}
          >
            {msg.role === "assistant" && (
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shrink-0 mt-1 shadow-sm">
                <Bot className="w-3.5 h-3.5 text-primary-foreground" />
              </div>
            )}
            <div className={`max-w-[85%] ${msg.role === "user" ? "order-first" : ""}`}>
              <div
                className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-md"
                    : "bg-card border border-border rounded-bl-md shadow-sm"
                }`}
              >
                {msg.content}
              </div>
              {/* Option chips */}
              {msg.options && msg.role === "assistant" && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {msg.options.map((opt, i) => (
                    <button
                      key={opt.value}
                      onClick={() => onOptionClick(opt.value, opt.label)}
                      className="px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary border border-primary/20 rounded-xl hover:bg-primary hover:text-primary-foreground transition-all duration-200 animate-in fade-in"
                      style={{ animationDelay: `${i * 30}ms` }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-1">
                <User className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
            )}
          </div>
        ))}

        {/* Interim transcript */}
        {interimTranscript && (
          <div className="flex gap-2.5 justify-end animate-in fade-in">
            <div className="max-w-[85%] order-first">
              <div className="px-3.5 py-2.5 rounded-2xl text-sm bg-primary/30 text-primary-foreground rounded-br-md italic">
                {interimTranscript}...
              </div>
            </div>
            <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-1">
              <User className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {isProcessing && (
          <div className="flex gap-2.5 animate-in fade-in duration-200">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shrink-0 shadow-sm">
              <Bot className="w-3.5 h-3.5 text-primary-foreground" />
            </div>
            <div className="px-3.5 py-2.5 bg-card border border-border rounded-2xl rounded-bl-md">
              <div className="flex gap-1.5 items-center h-5">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
};

export default ConversationPanel;
