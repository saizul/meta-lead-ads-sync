// n8n "Code" node (Run Once for Each Item) placed right after a Webhook node with
// "Raw Body" enabled. Rejects requests that were not signed by meta-lead-ads-sync.
// Set N8N_WEBHOOK_SECRET in the n8n environment to the sink's "secret".
const crypto = require('crypto');

const secret = $env.N8N_WEBHOOK_SECRET;
const raw = Buffer.from($input.item.binary.data.data, 'base64');
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const given = $input.item.json.headers['x-signature-256'] || '';

if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
  throw new Error('invalid signature');
}

return { json: JSON.parse(raw.toString('utf8')) };
