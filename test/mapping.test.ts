import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/errors.js';
import { DEFAULT_MAPPING, FieldMapper, fieldMap, parseTimestamp } from '../src/mapping.js';
import { event, lead, leadId } from './helpers/fixtures.js';

const ID = leadId(1);

test('default mapping', () => {
  const m = new FieldMapper(DEFAULT_MAPPING).map(lead(ID), event(ID));
  assert.deepEqual(m.columns, ['lead_id', 'created_time', 'page_id', 'form_id', 'ad_id', 'full_name', 'phone_number', 'email']);
  assert.equal(m.values.lead_id, ID);
  assert.equal(m.values.created_time, '2026-11-13T05:12:44.000Z');
  assert.equal(m.values.full_name, 'Rahim Uddin');
  assert.equal(m.values.phone_number, '+8801712345678');
  assert.equal(m.values.email, 'rahim@example.com');
  assert.deepEqual(m.extra, { 'which_service?': 'SEO, Meta ads' });
});

test('fallback sources, constants, defaults and transforms', () => {
  const mapper = new FieldMapper({
    columns: [
      { name: 'Name', from: ['field.first_name', 'field.full_name'], transform: ['upper'] },
      { name: 'Phone (local)', from: 'field.phone_number', transform: ['phone_bd:national'] },
      { name: 'Received', from: 'lead.created_time', transform: ['datetime:Asia/Dhaka'] },
      { name: 'Webhook time', from: 'event.created_time', transform: ['datetime:Asia/Dhaka'] },
      { name: 'City', from: 'field.city', default: 'unknown' },
      { name: 'Source', value: 'Facebook Lead Ads' },
      { name: 'Services', from: 'field.which_service?' },
      { name: 'Organic', from: 'lead.is_organic' },
      { name: 'Short', from: 'field.full_name', transform: ['truncate:5'] },
      { name: 'Tagged', from: 'field.full_name', transform: ['prefix:FB-', 'collapse_spaces'] },
      { name: 'Digits', from: 'field.phone_number', transform: ['digits'] },
    ],
    joinWith: ' | ',
  });
  const m = mapper.map(lead(ID, { is_organic: false }), event(ID));
  assert.equal(m.values.Name, 'RAHIM UDDIN');
  assert.equal(m.values['Phone (local)'], '01712345678');
  assert.equal(m.values.Received, '2026-11-13 11:12:44'); // UTC+6
  assert.equal(m.values['Webhook time'], '2025-11-13 08:13:20');
  assert.equal(m.values.City, 'unknown');
  assert.equal(m.values.Source, 'Facebook Lead Ads');
  assert.equal(m.values.Services, 'SEO | Meta ads');
  assert.equal(m.values.Organic, 'false');
  assert.equal(m.values.Short, 'Rahim');
  assert.equal(m.values.Tagged, 'FB-Rahim Uddin');
  assert.equal(m.values.Digits, '01712345678');
  assert.deepEqual(m.extra, {}); // includeUnmapped defaults to false
});

test('non-string lead properties are serialised', () => {
  const mapper = new FieldMapper({ columns: [{ name: 'x', from: 'lead.custom_disclaimer_responses' }] });
  const m = mapper.map(lead(ID, { custom_disclaimer_responses: [{ checkbox_key: 'a', is_checked: '1' }] }), event(ID));
  assert.equal(m.values.x, '[{"checkbox_key":"a","is_checked":"1"}]');
});

test('invalid phone numbers are kept as entered', () => {
  const mapper = new FieldMapper({ columns: [{ name: 'p', from: 'field.phone_number', transform: ['phone_bd'] }] });
  const l = lead(ID, { field_data: [{ name: 'phone_number', values: ['+1 415 555 0100'] }] });
  assert.equal(mapper.map(l, event(ID)).values.p, '+1 415 555 0100');
});

test('unparseable dates pass through', () => {
  const mapper = new FieldMapper({ columns: [{ name: 'd', from: 'field.when', transform: ['datetime'] }] });
  const l = lead(ID, { field_data: [{ name: 'when', values: ['next week'] }] });
  assert.equal(mapper.map(l, event(ID)).values.d, 'next week');
});

test('lead without field_data', () => {
  const m = new FieldMapper().map({ id: ID }, event(ID));
  assert.equal(m.values.full_name, '');
  assert.equal(m.values.form_id, event(ID).formId);
});

test('configuration errors', () => {
  const bad: Array<[unknown, RegExp]> = [
    [{}, /columns must be an array/],
    [{ columns: [{ from: 'lead.id' }] }, /name is required/],
    [{ columns: [{ name: 'a', from: 'lead.id' }, { name: 'a', from: 'lead.id' }] }, /duplicate column/],
    [{ columns: [{ name: 'a' }] }, /needs "from" or "value"/],
    [{ columns: [{ name: 'a', from: 'answers.x' }] }, /invalid source/],
    [{ columns: [{ name: 'a', from: 'lead.id', transform: ['shout'] }] }, /unknown transform/],
    [{ columns: [{ name: 'a', from: 'lead.id', transform: 'trim' }] }, /must be an array/],
    [{ columns: [{ name: 'a', from: 'lead.id', transform: ['datetime:Mars/Base'] }] }, /unknown time zone/],
    [{ columns: [{ name: 'a', from: 'lead.id', transform: ['phone_bd:intl'] }] }, /unknown format/],
    [{ columns: [{ name: 'a', from: 'lead.id', transform: ['truncate:x'] }] }, /positive length/],
  ];
  for (const [spec, re] of bad) {
    assert.throws(() => new FieldMapper(spec as never), (e: unknown) => e instanceof ConfigError && re.test((e as Error).message));
  }
});

test('fieldMap skips empty values and bad entries', () => {
  const m = fieldMap({ id: '1', field_data: [{ name: 'a', values: ['', 'x', ''] }, { values: ['y'] } as never, { name: 'b', values: 'z' as never }] });
  assert.deepEqual([...m], [['a', 'x'], ['b', '']]);
});

test('parseTimestamp', () => {
  assert.equal(parseTimestamp('2026-11-13T05:12:44+0000')?.toISOString(), '2026-11-13T05:12:44.000Z');
  assert.equal(parseTimestamp('2026-11-13T11:12:44+0600')?.toISOString(), '2026-11-13T05:12:44.000Z');
  assert.equal(parseTimestamp('1763000000')?.toISOString(), '2025-11-13T02:13:20.000Z');
  assert.equal(parseTimestamp('1763000000000')?.toISOString(), '2025-11-13T02:13:20.000Z');
  assert.equal(parseTimestamp('nope'), undefined);
});

test('columnNames', () => {
  assert.equal(new FieldMapper().columnNames.length, DEFAULT_MAPPING.columns.length);
});
