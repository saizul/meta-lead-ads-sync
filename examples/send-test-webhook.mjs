// Sign a webhook body with your app secret and POST it to a running server, the way
// Meta does. The lead id in the body must exist for the Graph API call to succeed, so
// for a dry run point the server at a test Page or watch the "could not fetch lead" log.
//
//   META_APP_SECRET=... node examples/send-test-webhook.mjs http://localhost:8080/webhook examples/sample-webhook.json
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [url = 'http://localhost:8080/webhook', file = new URL('./sample-webhook.json', import.meta.url)] = process.argv.slice(2);
const secret = process.env.META_APP_SECRET;
if (!secret) {
  console.error('set META_APP_SECRET');
  process.exit(2);
}
const body = await readFile(file);
const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body,
});
console.log(res.status, await res.text());
