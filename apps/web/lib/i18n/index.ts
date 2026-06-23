import { ja } from "./ja";

// JA-only now, EN-ready. Translate selectively: keep technical terms in English
// when Japanese/kana would be less natural. When locale-switching ships, add
// en.ts + registry wiring here; upgrade to next-intl if routing/runtime needs
// outgrow this plain server/client-safe accessor.
export type MessageKey = keyof typeof ja;
export type Locale = "ja" | "en";

type Catalog = Readonly<Record<MessageKey, string>>;

export const DEFAULT_LOCALE = "ja";
export const catalogs: Partial<Record<Locale, Catalog>> & { ja: typeof ja } = { ja };

export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return catalogs[locale]?.[key] ?? ja[key];
}
