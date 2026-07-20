import { useState, useEffect, useRef } from "react";
import { Clock, MapPin, Zap, Navigation, Loader2, Calendar, User } from "lucide-react";
import { getSmartScheduleService } from "@/domains/providers/smart-schedule.service";

interface Slot {
  provider_id: string;
  provider_name: string;
  start_time: string;
  end_time: string;
  estimated_travel_minutes: number;
  distance_km: number;
  is_zone_optimized: boolean;
  score: number;
}

interface SmartSchedulePickerProps {
  serviceCategory: string;
  lat?: number;
  lng?: number;
  durationMinutes?: number;
  onSlotSelect: (slot: Slot, date: string) => void;
  selectedSlot?: Slot | null;
}

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function getDateOptions() {
  const dates: { value: string; label: string }[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const value = d.toISOString().slice(0, 10);
    const label = i === 1 ? "Tomorrow" : d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    dates.push({ value, label });
  }
  return dates;
}

const SmartSchedulePicker = ({ serviceCategory, lat, lng, durationMinutes = 60, onSlotSelect, selectedSlot }: SmartSchedulePickerProps) => {
  const [date, setDate] = useState(getDateOptions()[0].value);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalProviders, setTotalProviders] = useState(0);
  const dateOptions = getDateOptions();
  const datePickerRef = useRef<HTMLInputElement>(null);
  const openDatePicker = () => {
    const input = datePickerRef.current;
    if (!input) return;
    // Native picker — showPicker() is the only reliable way to programmatically
    // open the calendar. Falls back to focus()+click for old browsers.
    if (typeof (input as any).showPicker === "function") {
      try { (input as any).showPicker(); return; } catch { /* fall through */ }
    }
    input.focus();
    input.click();
  };

  useEffect(() => {
    const fetchSlots = async () => {
      setLoading(true);
      setError(null);
      const result = await getSmartScheduleService().findSlots({
        serviceCategory,
        lat,
        lng,
        preferredDate: date,
        durationMinutes,
      });

      if (!result.success || !result.data) {
        setError("Could not load available slots");
        setLoading(false);
        return;
      }

      setSlots(result.data.slots || []);
      setTotalProviders(result.data.totalProviders || 0);
      setLoading(false);
    };
    fetchSlots();
  }, [date, serviceCategory, lat, lng, durationMinutes]);

  // Group slots by provider
  const groupedByProvider: Record<string, Slot[]> = {};
  slots.forEach((s) => {
    if (!groupedByProvider[s.provider_id]) groupedByProvider[s.provider_id] = [];
    groupedByProvider[s.provider_id].push(s);
  });

  // Get top 3 recommended slots
  const recommended = slots.slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Zap className="w-4 h-4 text-primary" />
        Pick a time slot
      </div>

      {/* Date selector — quick picks for the next week, plus a free-form
          date input for further-out bookings (no upper bound). */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {dateOptions.map((d) => (
          <button
            key={d.value}
            onClick={() => setDate(d.value)}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
              date === d.value
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-muted/50 text-muted-foreground border-border hover:border-primary/30"
            }`}
          >
            <Calendar className="w-3 h-3 inline mr-1" />
            {d.label}
          </button>
        ))}
        <button
          type="button"
          onClick={openDatePicker}
          className={`flex-shrink-0 inline-flex items-center px-3 py-2 rounded-xl text-xs font-medium border cursor-pointer transition-all ${
            !dateOptions.some((d) => d.value === date)
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-muted/50 text-muted-foreground border-border hover:border-primary/30"
          }`}
        >
          <Calendar className="w-3 h-3 mr-1" />
          {dateOptions.some((d) => d.value === date)
            ? "Pick date"
            : new Date(date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
        </button>
        {/* Hidden native input, opened imperatively via showPicker(). Kept
            outside the scrolling pill row so its position doesn't affect
            layout. The min date is tomorrow — same-day bookings handled
            via dedicated "Tomorrow" pill above. */}
        <input
          ref={datePickerRef}
          type="date"
          min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Finding optimal slots…
        </div>
      ) : error ? (
        <div className="text-center py-6 text-destructive text-sm">{error}</div>
      ) : slots.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground text-sm">
          {totalProviders === 0
            ? "This provider hasn't added bookable times yet. Message them to coordinate a time."
            : "No available slots for this date. Try another day."}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Recommended slots */}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Recommended ({totalProviders} provider{totalProviders !== 1 ? "s" : ""} available)
            </p>
            <div className="space-y-2">
              {recommended.map((slot, i) => (
                <button
                  key={`${slot.provider_id}-${slot.start_time}`}
                  onClick={() => onSlotSelect(slot, date)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    selectedSlot?.provider_id === slot.provider_id && selectedSlot?.start_time === slot.start_time
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border hover:border-primary/30 bg-card"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                        {i === 0 ? "⭐" : <User className="w-3.5 h-3.5" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold">{formatTime(slot.start_time)} – {formatTime(slot.end_time)}</span>
                          {i === 0 && <span className="text-[9px] font-bold uppercase text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Best</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{slot.provider_name}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <MapPin className="w-3 h-3" />{slot.distance_km} km
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Navigation className="w-3 h-3" />~{slot.estimated_travel_minutes} min
                      </div>
                    </div>
                  </div>
                  {slot.is_zone_optimized && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-success">
                      <Zap className="w-3 h-3" /> Zone-optimized — provider already nearby
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* More slots */}
          {slots.length > 3 && (
            <details className="group">
              <summary className="text-xs text-primary cursor-pointer font-medium hover:underline">
                Show {slots.length - 3} more slots
              </summary>
              <div className="mt-2 space-y-2">
                {slots.slice(3).map((slot) => (
                  <button
                    key={`${slot.provider_id}-${slot.start_time}`}
                    onClick={() => onSlotSelect(slot, date)}
                    className={`w-full text-left p-2.5 rounded-lg border transition-all text-sm ${
                      selectedSlot?.provider_id === slot.provider_id && selectedSlot?.start_time === slot.start_time
                        ? "border-primary bg-primary/5"
                        : "border-border/50 hover:border-primary/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{formatTime(slot.start_time)} – {formatTime(slot.end_time)}</span>
                        <span className="text-xs text-muted-foreground ml-2">{slot.provider_name}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{slot.distance_km} km</span>
                        {slot.is_zone_optimized && <Zap className="w-3 h-3 text-success" />}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
        <Clock className="w-3 h-3" /> Slots account for travel time & existing bookings
      </p>
    </div>
  );
};

export default SmartSchedulePicker;
