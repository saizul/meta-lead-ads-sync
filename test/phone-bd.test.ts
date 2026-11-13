import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBdPhone, parseBdPhone, toAsciiDigits } from '../src/phone-bd.js';

const VALID: Array<[string, string, string]> = [
  ['01712345678', '+8801712345678', 'Grameenphone'],
  ['01312345678', '+8801312345678', 'Grameenphone'],
  ['01412345678', '+8801412345678', 'Banglalink'],
  ['01912345678', '+8801912345678', 'Banglalink'],
  ['01512345678', '+8801512345678', 'Teletalk'],
  ['01612345678', '+8801612345678', 'Airtel'],
  ['01812345678', '+8801812345678', 'Robi'],
  ['+8801712345678', '+8801712345678', 'Grameenphone'],
  ['8801712345678', '+8801712345678', 'Grameenphone'],
  ['008801712345678', '+8801712345678', 'Grameenphone'],
  ['+88001712345678', '+8801712345678', 'Grameenphone'],
  ['1712345678', '+8801712345678', 'Grameenphone'],
  ['017-1234-5678', '+8801712345678', 'Grameenphone'],
  ['+880 1712 345678', '+8801712345678', 'Grameenphone'],
  ['(+880) 1712.345.678', '+8801712345678', 'Grameenphone'],
  ['  01712345678  ', '+8801712345678', 'Grameenphone'],
  ['০১৭১২৩৪৫৬৭৮', '+8801712345678', 'Grameenphone'],
  ['+৮৮০১৮১২৩৪৫৬৭৮', '+8801812345678', 'Robi'],
  ['٠١٧١٢٣٤٥٦٧٨', '+8801712345678', 'Grameenphone'],
];

for (const [input, e164, operator] of VALID) {
  test(`valid: ${input}`, () => {
    const r = parseBdPhone(input);
    assert.equal(r.valid, true, JSON.stringify(r));
    if (r.valid) {
      assert.equal(r.e164, e164);
      assert.equal(r.national, '0' + e164.slice(4));
      assert.equal(r.operator, operator);
    }
  });
}

const INVALID = ['', '   ', '01212345678', '01112345678', '0171234567', '017123456789', '+14155550100', '02-9876543', 'call me', '01712345678 ext 2', '+880+1712345678x'];

for (const input of INVALID) {
  test(`invalid: ${JSON.stringify(input)}`, () => {
    assert.equal(parseBdPhone(input).valid, false);
  });
}

test('normalizeBdPhone formats', () => {
  assert.equal(normalizeBdPhone('01712-345678'), '+8801712345678');
  assert.equal(normalizeBdPhone('01712-345678', 'national'), '01712345678');
  assert.equal(normalizeBdPhone('01712-345678', 'digits'), '8801712345678');
});

test('normalizeBdPhone keeps foreign numbers as they were', () => {
  assert.equal(normalizeBdPhone(' +1 415 555 0100 '), '+1 415 555 0100');
  assert.equal(normalizeBdPhone(''), '');
});

test('toAsciiDigits', () => {
  assert.equal(toAsciiDigits('ফোন: ০১২৩৪৫৬৭৮৯'), 'ফোন: 0123456789');
});
