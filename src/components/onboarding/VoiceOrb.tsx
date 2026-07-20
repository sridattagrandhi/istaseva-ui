import { useEffect, useRef } from "react";
import { VoiceState } from "@/hooks/useVoiceAssistant";

interface VoiceOrbProps {
  voiceState: VoiceState;
  onToggle: () => void;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
}

const VoiceOrb = ({ voiceState, onToggle, disabled, size = "lg" }: VoiceOrbProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  const dims = size === "lg" ? 180 : size === "md" ? 110 : 48;
  const buttonSize = size === "lg" ? 88 : size === "md" ? 56 : 40;
  const iconSize = size === "lg" ? 36 : size === "md" ? 24 : 18;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims * dpr;
    canvas.height = dims * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;
    const animate = () => {
      frame++;
      ctx.clearRect(0, 0, dims, dims);
      const cx = dims / 2;
      const cy = dims / 2;

      if (voiceState === "listening") {
        // Animated sound wave rings
        const ringCount = 4;
        for (let r = 0; r < ringCount; r++) {
          const phase = (frame * 0.03) + (r * 1.2);
          const amplitude = 6 + Math.sin(phase) * 8;
          const baseRadius = buttonSize / 2 + 8 + (r * 14);
          const radius = baseRadius + amplitude;
          const alpha = 0.25 - r * 0.06;

          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.strokeStyle = `hsla(239, 84%, 67%, ${alpha})`;
          ctx.lineWidth = 2.5 - r * 0.4;
          ctx.stroke();
        }

        // Inner glow
        const glowPulse = 0.15 + Math.sin(frame * 0.05) * 0.08;
        const gradient = ctx.createRadialGradient(cx, cy, buttonSize / 2, cx, cy, buttonSize / 2 + 30);
        gradient.addColorStop(0, `hsla(239, 84%, 67%, ${glowPulse})`);
        gradient.addColorStop(1, "hsla(239, 84%, 67%, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, dims, dims);

      } else if (voiceState === "speaking") {
        // Smooth speaking wave bars
        const barCount = 12;
        for (let i = 0; i < barCount; i++) {
          const angle = (i / barCount) * Math.PI * 2;
          const phase = frame * 0.06 + i * 0.5;
          const amplitude = 6 + Math.sin(phase) * 10;
          const innerR = buttonSize / 2 + 6;
          const outerR = innerR + amplitude;

          const x1 = cx + Math.cos(angle) * innerR;
          const y1 = cy + Math.sin(angle) * innerR;
          const x2 = cx + Math.cos(angle) * outerR;
          const y2 = cy + Math.sin(angle) * outerR;

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.strokeStyle = `hsla(174, 83%, 32%, ${0.5 - (i % 3) * 0.1})`;
          ctx.lineWidth = 3;
          ctx.lineCap = "round";
          ctx.stroke();
        }

      } else if (voiceState === "processing") {
        // Spinning arc
        const startAngle = (frame * 0.04) % (Math.PI * 2);
        const arcLen = Math.PI * 0.8;
        ctx.beginPath();
        ctx.arc(cx, cy, buttonSize / 2 + 10, startAngle, startAngle + arcLen);
        ctx.strokeStyle = "hsla(239, 84%, 67%, 0.4)";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();

        // Counter-spinning
        ctx.beginPath();
        ctx.arc(cx, cy, buttonSize / 2 + 20, -startAngle, -startAngle + arcLen * 0.6);
        ctx.strokeStyle = "hsla(174, 83%, 32%, 0.25)";
        ctx.lineWidth = 2;
        ctx.stroke();

      } else {
        // Idle: subtle breathing pulse
        const pulse = Math.sin(frame * 0.02) * 0.06 + 0.08;
        const gradient = ctx.createRadialGradient(cx, cy, buttonSize / 2 - 5, cx, cy, buttonSize / 2 + 20);
        gradient.addColorStop(0, `hsla(239, 84%, 67%, ${pulse})`);
        gradient.addColorStop(1, "hsla(239, 84%, 67%, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, dims, dims);
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(animRef.current);
  }, [voiceState, dims, buttonSize]);

  const stateLabels: Record<VoiceState, string> = {
    idle: size === "sm" ? "" : "Tap to speak",
    listening: size === "sm" ? "" : "Listening...",
    processing: size === "sm" ? "" : "Processing...",
    speaking: size === "sm" ? "" : "Ista AI is speaking...",
  };

  const bgClasses: Record<VoiceState, string> = {
    idle: "bg-primary shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:scale-105",
    listening: "bg-primary shadow-xl shadow-primary/50 scale-105",
    processing: "bg-primary/80 shadow-lg shadow-primary/20",
    speaking: "bg-accent shadow-lg shadow-accent/40",
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: dims, height: dims }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: dims, height: dims }}
        />
        <button
          onClick={onToggle}
          disabled={disabled || voiceState === "processing"}
          className={`absolute inset-0 m-auto rounded-full flex items-center justify-center transition-all duration-300 ${bgClasses[voiceState]} disabled:opacity-50 disabled:cursor-not-allowed active:scale-95`}
          style={{ width: buttonSize, height: buttonSize }}
          aria-label={stateLabels[voiceState] || "Voice control"}
        >
          {voiceState === "listening" ? (
            <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" className="text-primary-foreground animate-pulse">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="currentColor"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          ) : voiceState === "speaking" ? (
            <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" className="text-accent-foreground">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-pulse"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-pulse [animation-delay:200ms]"/>
            </svg>
          ) : voiceState === "processing" ? (
            <div className="flex gap-1 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-foreground animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-foreground animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-primary-foreground animate-bounce [animation-delay:300ms]" />
            </div>
          ) : (
            <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" className="text-primary-foreground">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="currentColor"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </div>

      {stateLabels[voiceState] && (
        <p className={`text-xs font-medium transition-all duration-300 ${
          voiceState === "listening" ? "text-primary animate-pulse" :
          voiceState === "speaking" ? "text-accent" :
          voiceState === "processing" ? "text-muted-foreground" :
          "text-muted-foreground"
        }`}>
          {stateLabels[voiceState]}
        </p>
      )}
    </div>
  );
};

export default VoiceOrb;
