// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isFullMenuIntent,
  appendMissingMenuOptions,
  type PriceableOptionLite,
} from './full-menu-backstop.js';

const HAIRCUTS: PriceableOptionLite[] = [
  { group: 'Services', name: "Men's Haircut", price: 700, unit: 'per_visit' },
  { group: 'Services', name: "Women's Haircut", price: 1200, unit: 'per_visit' },
  { group: 'Services', name: "Kid's Haircut", price: 396, unit: 'per_visit' },
];

describe('isFullMenuIntent', () => {
  it('matches full-menu phrasings', () => {
    for (const q of [
      'Could you tell me more about it?',
      'what all do they offer?',
      'show me everything',
      'full price list please',
      'what services do they have',
      'kya kya hai?',
    ]) {
      expect(isFullMenuIntent(q)).toBe(true);
    }
  });

  it('does not match unrelated turns', () => {
    for (const q of ['book the 2pm slot', 'is it open on Monday?', 'yes go ahead']) {
      expect(isFullMenuIntent(q)).toBe(false);
    }
  });

  it('matches native-script full-menu phrasings across all locales', () => {
    for (const q of [
      'इसके बारे में और बताओ',          // hi: tell me more about it
      'पूरी जानकारी दो',                // hi: give me the full info
      'सारे options दिखाओ',            // hi: show all options
      'अजून काय आहे?',                 // mr: what else is there?
      'ఇంకా చెప్పండి',                  // te: tell me more
      'అన్నీ చూపించు',                 // te: show me all
      'ఇంకా ఏమైనా ఉన్నాయా?',           // te: is there anything else?
      'எல்லாம் சொல்லுங்க',             // ta: tell me everything
      'என்ன என்ன இருக்கு?',           // ta: what all is there?
      'ಎಲ್ಲಾ ತೋರಿಸಿ',                  // kn: show all
      'ಇನ್ನೂ ಹೇಳಿ',                    // kn: tell me more
      'എല്ലാം പറയൂ',                   // ml: tell me everything
      'എന്തെല്ലാം ഉണ്ട്?',             // ml: what all is there?
    ]) {
      expect(isFullMenuIntent(q)).toBe(true);
    }
  });

  it('does NOT fire on a single-variant native-script price question', () => {
    // "How much is the women's haircut?" — asking about ONE variant, not the
    // whole menu. Appending every variant here would be over-eager, so the
    // native matcher deliberately omits bare "how much" / "price".
    for (const q of [
      'women\'s haircut ఎంత?',          // te: how much is women's haircut?
      'पुरुष का कितने का है?',          // hi: how much is the men's one?
      'விலை என்ன?',                    // ta: what's the price?
    ]) {
      expect(isFullMenuIntent(q)).toBe(false);
    }
  });
});

describe('appendMissingMenuOptions', () => {
  it('appends the variant the model dropped (the screenshot bug)', () => {
    // Model listed Men's + Kid's but forgot Women's.
    const reply = "It's a premium salon. A men's haircut is ₹700, and kid's haircuts are ₹396.";
    const out = appendMissingMenuOptions(reply, HAIRCUTS);
    expect(out).toContain('Women');
    expect(out).toContain('1,200');
    // Didn't duplicate the ones already covered.
    expect(out.match(/700/g)?.length).toBe(1);
    expect(out.match(/396/g)?.length).toBe(1);
  });

  it('leaves the message untouched when every option is already present', () => {
    const reply = "They do Men's ₹700, Women's ₹1200, or Kid's ₹396 — which one?";
    expect(appendMissingMenuOptions(reply, HAIRCUTS)).toBe(reply);
  });

  it('matches prices regardless of ₹ / comma formatting', () => {
    const reply = 'Men ₹700, Women ₹1,200, Kid 396 rupees.';
    expect(appendMissingMenuOptions(reply, HAIRCUTS)).toBe(reply);
  });

  it('appends ALL prices when the model gave none', () => {
    const reply = "They do men's, women's and kid's haircuts.";
    const out = appendMissingMenuOptions(reply, HAIRCUTS);
    expect(out).toContain('700');
    expect(out).toContain('1,200');
    expect(out).toContain('396');
  });

  it('is a no-op for single-option listings', () => {
    const reply = 'This homestay is ₹4500 a night.';
    const single: PriceableOptionLite[] = [{ name: 'Whole home', price: 4500, unit: 'per_night' }];
    expect(appendMissingMenuOptions(reply, single)).toBe(reply);
  });

  it('formats unit suffixes and add-ons for transport + room options', () => {
    const reply = 'Here are the options.';
    const opts: PriceableOptionLite[] = [
      { group: 'Transport', name: 'Hourly rental', price: 350, unit: 'per_hour' },
      { group: 'Transport', name: 'Day rental', price: 2500, unit: 'per_day' },
      { group: 'Rooms', name: 'Deluxe Suite', price: 6000, unit: 'per_night', maxGuests: 4 },
    ];
    const out = appendMissingMenuOptions(reply, opts);
    expect(out).toContain('₹350/hr');
    expect(out).toContain('₹2,500/day');
    expect(out).toContain('₹6,000/night (sleeps 4)');
  });

  it('nests per-variant add-ons under their variant', () => {
    const reply = 'Here you go.';
    const opts: PriceableOptionLite[] = [
      { group: 'Services', name: "Men's Haircut", price: 700, unit: 'per_visit', addOns: [{ name: 'Beard Trim', price: 200 }] },
      { group: 'Services', name: "Women's Haircut", price: 1200, unit: 'per_visit' },
    ];
    const out = appendMissingMenuOptions(reply, opts);
    expect(out).toContain('add-on: Beard Trim +₹200');
  });
});
