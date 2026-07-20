import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

// Process-wide cache keyed by `${lang}:${text}`. Translations are pure functions
// of (lang, text) and the server is itself content-addressable, so caching in
// the client avoids re-hitting the network when the same string renders in
// multiple components or after navigation.
const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string[]>>();

interface TranslateResponse {
  translations: string[];
}

function cacheKey(lang: string, text: string) {
  return `${lang}:${text}`;
}

async function fetchTranslations(targetLang: string, texts: string[]): Promise<string[]> {
  const res = await apiRequest<TranslateResponse>("/api/translation/translate", {
    method: "POST",
    headers: getJsonHeaders(),
    body: JSON.stringify({ sourceLang: "en", targetLang, texts }),
  });
  if (!res.success) throw new Error(res.error);
  return res.data.translations;
}

export interface DynamicTranslationResult {
  translated: string[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Translate user-generated text (listing descriptions, review bodies, etc.)
 * into the current UI language. Pass a string or array of strings; the hook
 * returns an array preserving input order.
 *
 * No-ops when the UI is already in English — returns the input verbatim.
 */
export function useDynamicTranslation(input: string | string[]): DynamicTranslationResult {
  const { language } = useLanguage();
  const texts = Array.isArray(input) ? input : [input];

  // Stable key for effect dependency — avoids refetching when the parent
  // re-renders with a new array identity containing the same strings.
  const textsKey = texts.join("\u0001");

  const [state, setState] = useState<DynamicTranslationResult>(() => {
    if (language === "en") return { translated: texts, isLoading: false, error: null };
    const hits = texts.map((t) => memoryCache.get(cacheKey(language, t)));
    if (hits.every((h) => h !== undefined)) {
      return { translated: hits as string[], isLoading: false, error: null };
    }
    return { translated: texts, isLoading: true, error: null };
  });

  const lastReq = useRef(0);

  useEffect(() => {
    if (language === "en") {
      setState({ translated: texts, isLoading: false, error: null });
      return;
    }

    const hits = texts.map((t) => memoryCache.get(cacheKey(language, t)));
    if (hits.every((h) => h !== undefined)) {
      setState({ translated: hits as string[], isLoading: false, error: null });
      return;
    }

    const missTexts = Array.from(new Set(texts.filter((t) => memoryCache.get(cacheKey(language, t)) === undefined)));
    const batchKey = `${language}\u0002${missTexts.join("\u0001")}`;

    let promise = inflight.get(batchKey);
    if (!promise) {
      promise = fetchTranslations(language, missTexts).finally(() => {
        inflight.delete(batchKey);
      });
      inflight.set(batchKey, promise);
    }

    const reqId = ++lastReq.current;
    setState((s) => ({ ...s, isLoading: true, error: null }));

    promise.then(
      (results) => {
        missTexts.forEach((t, i) => memoryCache.set(cacheKey(language, t), results[i] ?? t));
        if (reqId !== lastReq.current) return;
        const resolved = texts.map((t) => memoryCache.get(cacheKey(language, t)) ?? t);
        setState({ translated: resolved, isLoading: false, error: null });
      },
      (err: Error) => {
        if (reqId !== lastReq.current) return;
        setState({ translated: texts, isLoading: false, error: err.message });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, textsKey]);

  return state;
}
