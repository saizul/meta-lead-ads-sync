import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SinkError } from '../src/errors.js';
import { FieldMapper } from '../src/mapping.js';
import { verifySignature } from '../src/signature.js';
import { TelegramSink, escapeHtml, renderTemplate } from '../src/sinks/telegram.js';
import { WebhookSink } from '../src/sinks/webhook.js';
import type { LeadContext } from '../src/types.js';
import { event, lead, leadId } from './helpers/fixtures.js';
import { MockFetch } from './helpers/mock-fetch.js';

const ID = leadId(5);
const N8N = 'https://n8n.example.com/webhook/leads';
const BOT = '123456:ABC-test_token';
const TG = `https://api.telegram.org/bot${BOT}/sendMessage`;

function ctx(overrides = {}): LeadContext {
  const mapper = new FieldMapper({
    columns: [
      { name: 'Name', from: 'field.full_name' },
      { name: 'Phone', from: 'field.phone_number', transform: ['phone_bd'] },
      { name: 'City', from: 'field.city' },
    ],
    includeUnmapped: true,
  });
  const l = lead(ID, overrides);
  return { event: event(ID), lead: l, mapped: mapper.map(l, event(ID)) };
}

test('webhook sink posts signed JSON with an idempotency key', async () => {
  const mock = new MockFetch().on('POST', N8N, { status: 200, text: 'ok' });
  const sink = new WebhookSink({ url: N8N, secret: 'n8n-secret', headers: { 'X-Api-Key': 'k' }, fetch: mock.fetch });
  await sink.send(ctx());
  const call = mock.calls[0]!;
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['idempotency-key'], ID);
  assert.equal(call.headers['x-api-key'], 'k');
  assert.equal(verifySignature(Buffer.from(call.body), call.headers['x-signature-256'], 'n8n-secret').ok, true);
  const body = JSON.parse(call.body);
  assert.equal(body.event, 'lead.created');
  assert.equal(body.leadgen_id, ID);
  assert.equal(body.lead.Phone, '+8801712345678');
  assert.equal(body.extra.email, ' Rahim@Example.COM ');
  assert.equal(body.raw.lead.id, ID);
  assert.equal(body.raw.event.leadgenId, ID);
});

test('webhook sink without secret or raw', async () => {
  const mock = new MockFetch().on('POST', N8N, { status: 204, text: '' });
  await new WebhookSink({ url: N8N, includeRaw: false, fetch: mock.fetch }).send(ctx());
  assert.equal(mock.calls[0]!.headers['x-signature-256'], undefined);
  assert.equal(JSON.parse(mock.calls[0]!.body).raw, undefined);
});

test('webhook sink errors are classified', async () => {
  const mock = new MockFetch().on('POST', N8N, { status: 502, text: 'bad gateway' }, { status: 404, text: 'no workflow' }, new TypeError('ECONNREFUSED'));
  const sink = new WebhookSink({ name: 'n8n', url: N8N, fetch: mock.fetch });
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && e.retryable && e.status === 502 && e.sink === 'n8n');
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && !e.retryable && /no workflow/.test(e.message));
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && e.retryable && /ECONNREFUSED/.test(e.message));
});

test('webhook sink validates its url', () => {
  assert.throws(() => new WebhookSink({ url: 'not a url' }), /invalid url/);
  assert.throws(() => new WebhookSink({ url: 'ftp://example.com/x' }), /http\(s\)/);
});

test('telegram sink sends an HTML message', async () => {
  const mock = new MockFetch().on('POST', TG, { json: { ok: true, result: { message_id: 1 } } });
  const sink = new TelegramSink({ botToken: BOT, chatId: -1001234567890, messageThreadId: 7, disableNotification: true, fetch: mock.fetch });
  await sink.send(ctx({ field_data: [{ name: 'full_name', values: ['<Rahim & Co>'] }, { name: 'phone_number', values: ['01712345678'] }] }));
  const body = JSON.parse(mock.calls[0]!.body);
  assert.equal(body.chat_id, -1001234567890);
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.message_thread_id, 7);
  assert.equal(body.disable_notification, true);
  assert.equal(body.text, '<b>New lead</b>\n<b>Name:</b> &lt;Rahim &amp; Co&gt;\n<b>Phone:</b> +8801712345678');
});

test('telegram templates', () => {
  const c = ctx();
  assert.equal(renderTemplate('Lead: {{Name}} ({{ Phone }}) {{email}} {{missing}}!', c), 'Lead: Rahim Uddin (+8801712345678)  Rahim@Example.COM  !');
  assert.ok(renderTemplate('{{#all}}', c).includes('<b>which_service?:</b> SEO, Meta ads'));
  const long = renderTemplate('x'.repeat(5000), c);
  assert.equal(long.length, 4096);
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('telegram errors: 429 carries retry_after, 400 is final, token never leaks', async () => {
  const mock = new MockFetch().on(
    'POST',
    TG,
    { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } },
    { status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } },
    new TypeError(`request to ${TG} failed`),
  );
  const sink = new TelegramSink({ botToken: BOT, chatId: '1', fetch: mock.fetch });
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && e.retryable && (e as unknown as { retryAfterMs: number }).retryAfterMs === 3000);
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && !e.retryable && /chat not found/.test(e.message));
  await assert.rejects(sink.send(ctx()), (e: unknown) => e instanceof SinkError && !e.message.includes(BOT));
});

test('telegram sink validation', () => {
  assert.throws(() => new TelegramSink({ botToken: 'nope', chatId: '1' }), /invalid botToken/);
  assert.throws(() => new TelegramSink({ botToken: BOT, chatId: '' }), /chatId/);
});
