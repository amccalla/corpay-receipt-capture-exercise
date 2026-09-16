/**
 * Display names for the currency picker.
 *
 * Presentation data, so it lives here rather than in the domain — `money.ts`
 * cares about exponents and parsing, not about what a human calls a currency.
 * The list is derived from SUPPORTED_CURRENCIES at module load, so a currency
 * added to the parser cannot silently go missing from the picker, and one
 * without a name here degrades to just its code rather than disappearing.
 */

import { SUPPORTED_CURRENCIES } from '../domain/money';
import type { CurrencyCode } from '../domain/types';

const NAMES: Readonly<Record<string, string>> = {
  AED: 'UAE Dirham', ARS: 'Argentine Peso', AUD: 'Australian Dollar',
  BHD: 'Bahraini Dinar', BIF: 'Burundian Franc', BRL: 'Brazilian Real',
  CAD: 'Canadian Dollar', CHF: 'Swiss Franc', CLP: 'Chilean Peso',
  CNY: 'Chinese Yuan', COP: 'Colombian Peso', CZK: 'Czech Koruna',
  DJF: 'Djiboutian Franc', DKK: 'Danish Krone', EGP: 'Egyptian Pound',
  EUR: 'Euro', GBP: 'British Pound', GNF: 'Guinean Franc',
  HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli Shekel', INR: 'Indian Rupee', IQD: 'Iraqi Dinar',
  ISK: 'Icelandic Krona', JOD: 'Jordanian Dinar', JPY: 'Japanese Yen',
  KES: 'Kenyan Shilling', KMF: 'Comorian Franc', KRW: 'South Korean Won',
  KWD: 'Kuwaiti Dinar', LYD: 'Libyan Dinar', MXN: 'Mexican Peso',
  MYR: 'Malaysian Ringgit', NGN: 'Nigerian Naira', NOK: 'Norwegian Krone',
  NZD: 'New Zealand Dollar', OMR: 'Omani Rial', PHP: 'Philippine Peso',
  PLN: 'Polish Zloty', PYG: 'Paraguayan Guarani', RON: 'Romanian Leu',
  RUB: 'Russian Ruble', RWF: 'Rwandan Franc', SAR: 'Saudi Riyal',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', THB: 'Thai Baht',
  TND: 'Tunisian Dinar', TRY: 'Turkish Lira', TWD: 'New Taiwan Dollar',
  UGX: 'Ugandan Shilling', USD: 'US Dollar', VND: 'Vietnamese Dong',
  VUV: 'Vanuatu Vatu', XAF: 'Central African Franc', XOF: 'West African Franc',
  XPF: 'CFP Franc', ZAR: 'South African Rand',
};

export interface CurrencyOption {
  readonly code: CurrencyCode;
  readonly name: string;
  /** Lowercased "usd us dollar", so one search box matches code or name. */
  readonly search: string;
}

export const CURRENCY_OPTIONS: readonly CurrencyOption[] = SUPPORTED_CURRENCIES.map((code) => {
  const name = NAMES[code] ?? code;
  return { code, name, search: `${code} ${name}`.toLowerCase() };
});

/** Codes the picker should surface first, because they are the common ones. */
export const COMMON_CURRENCIES: readonly CurrencyCode[] = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'];

export function filterCurrencies(query: string): readonly CurrencyOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return CURRENCY_OPTIONS;
  return CURRENCY_OPTIONS.filter((c) => c.search.includes(q));
}
