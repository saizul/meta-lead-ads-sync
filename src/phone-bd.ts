/**
 * Bangladeshi mobile number normalisation.
 *
 * Lead forms collect phone numbers in every shape: `01712-345678`, `+880 1712 345678`,
 * `8801712345678`, `00880...`, `1712345678`, Bangla digits (`০১৭১২৩৪৫৬৭৮`) and with the
 * trunk zero kept after the country code (`+88001712345678`). All of them are the same
 * number, `+8801712345678` in E.164.
 *
 * A valid mobile number is `01` followed by an operator digit 3-9 and eight more digits.
 */

export type BdOperator = 'Grameenphone' | 'Banglalink' | 'Teletalk' | 'Airtel' | 'Robi';

const OPERATORS: Record<string, BdOperator> = {
  '013': 'Grameenphone',
  '014': 'Banglalink',
  '015': 'Teletalk',
  '016': 'Airtel',
  '017': 'Grameenphone',
  '018': 'Robi',
  '019': 'Banglalink',
};

export type BdPhoneResult =
  | { valid: true; e164: string; national: string; operator: BdOperator; input: string }
  | { valid: false; input: string; reason: string };

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Replace Bangla and Arabic-Indic digits with ASCII digits. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const b = BANGLA_DIGITS.indexOf(ch);
    if (b >= 0) {
      out += String(b);
      continue;
    }
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    out += a >= 0 ? String(a) : ch;
  }
  return out;
}

export function parseBdPhone(input: string): BdPhoneResult {
  const raw = String(input ?? '');
  const ascii = toAsciiDigits(raw).trim();
  if (!ascii) return { valid: false, input: raw, reason: 'empty' };
  // Allow digits, spaces, dots, dashes, parentheses and one leading plus ("+880" or "(+880)").
  if (!/^\(?\+?[\d\s.\-()]+$/.test(ascii)) return { valid: false, input: raw, reason: 'unexpected characters' };
  let digits = ascii.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2); // international prefix 00
  if (digits.startsWith('880')) {
    // "880" also covers the common "88" + national number form (8801712345678).
    digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1); // +880 0171... (trunk zero kept)
    digits = '0' + digits;
  } else if (digits.length === 10 && digits.startsWith('1')) {
    digits = '0' + digits;
  }
  if (!/^01[3-9]\d{8}$/.test(digits)) {
    return { valid: false, input: raw, reason: 'not a Bangladeshi mobile number' };
  }
  const operator = OPERATORS[digits.slice(0, 3)]!;
  return { valid: true, e164: `+88${digits}`, national: digits, operator, input: raw };
}

export type PhoneFormat = 'e164' | 'national' | 'digits';

/**
 * Normalise a number for storage. Returns the input unchanged (trimmed) when it is not a
 * Bangladeshi mobile number, so foreign or landline numbers are never lost.
 */
export function normalizeBdPhone(input: string, format: PhoneFormat = 'e164'): string {
  const r = parseBdPhone(input);
  if (!r.valid) return String(input ?? '').trim();
  if (format === 'national') return r.national;
  if (format === 'digits') return r.e164.slice(1);
  return r.e164;
}
