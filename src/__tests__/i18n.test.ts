/**
 * i18n locale tests — ensure all shipped locales (en / fr / de) have
 * matching shape so SelectorBuilder can iterate them safely. Catches the
 * class of bug where a new locale file ships with a missing key and the
 * selector pipeline silently skips that text.
 */

import { describe, it, expect } from '@jest/globals';
import {
  setLocale,
  getSupportedLocales,
  getLocaleData,
  selectors,
  type SupportedLocale,
} from '../i18n/index.js';

const REFERENCE: SupportedLocale = 'en';

function leafKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      out.push(...leafKeys(v, next));
    } else {
      out.push(next);
    }
  }
  return out;
}

describe('i18n locales', () => {
  it('ships en, fr and de as supported locales', () => {
    expect(getSupportedLocales()).toEqual(expect.arrayContaining(['en', 'fr', 'de']));
  });

  it('every locale exposes the same leaf keys as en (no missing translations)', () => {
    setLocale(REFERENCE);
    const refKeys = leafKeys(getLocaleData()).sort();
    // Filter out the descriptive header keys that legitimately differ per locale.
    const headerKeys = new Set(['locale', 'name', 'description', '$schema']);
    const refLeaf = refKeys.filter((k) => !headerKeys.has(k));

    for (const locale of getSupportedLocales()) {
      if (locale === REFERENCE) continue;
      setLocale(locale);
      const ours = leafKeys(getLocaleData())
        .filter((k) => !headerKeys.has(k))
        .sort();
      expect(ours).toEqual(refLeaf);
    }
    setLocale(REFERENCE); // reset
  });

  it('SelectorBuilder emits selectors for every locale', () => {
    const built = selectors().buttonWithText('addSource').build();
    // 3 locales × 1 selector pattern, minus dedup if same text in two locales.
    // Each locale has a unique "Add source" translation so we expect 3 distinct.
    expect(built.length).toBe(3);
    expect(built.some((s) => s.includes('Quelle hinzufügen'))).toBe(true);
    expect(built.some((s) => s.includes('Ajouter une source'))).toBe(true);
    expect(built.some((s) => s.includes('Add source'))).toBe(true);
  });
});
