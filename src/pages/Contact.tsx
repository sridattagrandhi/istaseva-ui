import { MapPin, Phone, Mail, Clock, Send, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { SUPPORT_EMAIL, SUPPORT_PHONE } from "@/lib/legal";

const Contact = () => {
  const { t } = useLanguage();
  const chatMessages = [
    { from: "bot", text: t("contact.botGreeting", { defaultValue: "Hi there! 👋 Welcome to IstaSeva support. How can I help you today?" }) },
    { from: "bot", text: t("contact.botPrompt", { defaultValue: "You can ask me about bookings, services, host onboarding, or anything else!" }) },
  ];

  const [form, setForm] = useState({ name: "", email: "", phone: "", subject: "", message: "" });
  const [sending, setSending] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState(chatMessages);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.message) {
      toast.error(t("contact.fillRequired", { defaultValue: "Please fill in all required fields" }));
      return;
    }
    setSending(true);
    setTimeout(() => {
      setSending(false);
      toast.success(t("contact.messageSent", { defaultValue: "Message sent successfully! We'll get back to you within 24 hours." }));
      setForm({ name: "", email: "", phone: "", subject: "", message: "" });
    }, 1500);
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    setMessages(prev => [...prev, { from: "user", text: chatInput }]);
    const input = chatInput.toLowerCase();
    setChatInput("");
    setTimeout(() => {
      let reply = t("contact.replyDefault", { defaultValue: "Thanks for your message! A support agent will be with you shortly. In the meantime, you can also email us at {{email}}.", email: SUPPORT_EMAIL });
      if (input.includes("book")) reply = t("contact.replyBooking", { defaultValue: "For booking help, go to your Dashboard → My Bookings. You can also call us at {{phone}} for urgent assistance.", phone: SUPPORT_PHONE });
      else if (input.includes("host") || input.includes("list")) reply = t("contact.replyHost", { defaultValue: "To list your property, visit the 'Become a Host' page and sign up. Our team will verify your listing within 24 hours!" });
      else if (input.includes("service") || input.includes("partner")) reply = t("contact.replyService", { defaultValue: "To join as a service provider, visit 'Become a Provider'. You can start earning as soon as your profile is verified." });
      else if (input.includes("cancel")) reply = t("contact.replyCancel", { defaultValue: "Stays can be cancelled free up to 24 hours before check-in. Services can be cancelled up to 2 hours before. Go to Dashboard → My Bookings." });
      else if (input.includes("price") || input.includes("payment")) reply = t("contact.replyPrice", { defaultValue: "We accept UPI, debit/credit cards, and cash on arrival. All prices include service fees — no hidden charges!" });
      setMessages(prev => [...prev, { from: "bot", text: reply }]);
    }, 800);
  };

  return (
    <div className="min-h-screen bg-background">
      <section className="bg-gradient-to-r from-primary/5 to-accent/5 py-10 sm:py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-2">{t("contact.getInTouch", { defaultValue: "Get in Touch" })}</h1>
          <p className="text-muted-foreground">{t("contact.heroSubtitle", { defaultValue: "Have questions? We'd love to hear from you. Reach out anytime." })}</p>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="grid lg:grid-cols-3 gap-8 lg:gap-10">
          <div className="space-y-5">
            <h2 className="font-display text-xl font-semibold">{t("contact.contactInformation", { defaultValue: "Contact Information" })}</h2>
            {[
              { icon: MapPin, label: t("contact.address", { defaultValue: "Address" }), value: "IstaSeva HQ, HSR Layout, Bengaluru, Karnataka 560102", href: undefined as string | undefined },
              { icon: Phone, label: t("contact.phone", { defaultValue: "Phone" }), value: SUPPORT_PHONE, href: `tel:${SUPPORT_PHONE.replace(/\s+/g, "")}` },
              { icon: Mail, label: t("contact.email", { defaultValue: "Email" }), value: SUPPORT_EMAIL, href: `mailto:${SUPPORT_EMAIL}` },
              { icon: Clock, label: t("contact.workingHours", { defaultValue: "Working Hours" }), value: t("contact.workingHoursValue", { defaultValue: "Mon - Sat, 9 AM - 7 PM IST" }) },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-3 p-3 bg-card rounded-xl border border-border">
                <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <item.icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-medium text-sm">{item.label}</p>
                  {item.href ? (
                    <a href={item.href} className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{item.value}</a>
                  ) : (
                    <p className="text-sm text-muted-foreground">{item.value}</p>
                  )}
                </div>
              </div>
            ))}

            <div className="p-5 bg-gradient-to-br from-primary/10 to-accent/5 rounded-2xl border border-primary/10">
              <MessageCircle className="w-8 h-8 text-primary mb-3" />
              <h3 className="font-semibold text-sm mb-1">{t("contact.needInstantHelp", { defaultValue: "Need instant help?" })}</h3>
              <p className="text-xs text-muted-foreground mb-3">{t("contact.chatBotPrompt", { defaultValue: "Chat with our support bot for quick answers about bookings, services, and more." })}</p>
              <Button size="sm" className="rounded-full text-xs" onClick={() => setChatOpen(true)}>{t("contact.startLiveChat", { defaultValue: "Start Live Chat" })}</Button>
            </div>
          </div>

          <div className="lg:col-span-2">
            <form onSubmit={handleSubmit} className="bg-card rounded-2xl border border-border p-6 sm:p-8">
              <h2 className="font-display text-xl font-semibold mb-6">{t("contact.sendUsMessage", { defaultValue: "Send us a Message" })}</h2>
              <div className="grid sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">{t("contact.fullNameLabel", { defaultValue: "Full Name *" })}</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder={t("contact.namePlaceholder", { defaultValue: "Your name" })} className="w-full px-4 py-3 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">{t("contact.emailLabel", { defaultValue: "Email *" })}</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="you@example.com" className="w-full px-4 py-3 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">{t("contact.phoneLabel", { defaultValue: "Phone" })}</label>
                  <input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder={t("contact.phonePlaceholder", { defaultValue: "+91 98765 43210" })} className="w-full px-4 py-3 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1.5">{t("contact.subjectLabel", { defaultValue: "Subject" })}</label>
                  <input type="text" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder={t("contact.subjectPlaceholder", { defaultValue: "How can we help?" })} className="w-full px-4 py-3 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 transition-all" />
                </div>
              </div>
              <div className="mb-6">
                <label className="text-sm font-medium text-foreground block mb-1.5">{t("contact.messageLabel", { defaultValue: "Message *" })}</label>
                <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
                  placeholder={t("contact.messagePlaceholder", { defaultValue: "Tell us more..." })} rows={5}
                  className="w-full px-4 py-3 border border-border rounded-xl text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 resize-none transition-all" />
              </div>
              <Button type="submit" className="rounded-xl px-8 h-12 font-semibold shadow-md shadow-primary/20" disabled={sending}>
                {sending ? t("contact.sending", { defaultValue: "Sending..." }) : <><Send className="w-4 h-4 mr-2" />{t("contact.sendMessage", { defaultValue: "Send Message" })}</>}
              </Button>
            </form>
          </div>
        </div>
      </div>

      {/* Live Chat Overlay */}
      {chatOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-80 sm:w-96 bg-card rounded-2xl border border-border shadow-2xl overflow-hidden animate-scale-in">
          <div className="bg-primary text-primary-foreground p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-foreground/20 flex items-center justify-center">
                <MessageCircle className="w-4 h-4" />
              </div>
              <div>
                <p className="font-semibold text-sm">IstaSeva Support</p>
                <p className="text-[10px] opacity-70 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />{t("contact.online", { defaultValue: "Online" })}</p>
              </div>
            </div>
            <button onClick={() => setChatOpen(false)} className="p-1 hover:bg-primary-foreground/10 rounded-lg"><X className="w-4 h-4" /></button>
          </div>
          <div className="h-64 overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${
                  m.from === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}>{m.text}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-border p-3 flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendChat()}
              placeholder={t("contact.typeMessage", { defaultValue: "Type a message..." })}
              className="flex-1 px-3 py-2 bg-background border border-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Button size="sm" className="rounded-xl shrink-0" onClick={sendChat}>
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Contact;
