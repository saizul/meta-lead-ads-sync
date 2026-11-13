// Use the building blocks in your own server (Express, Fastify, a serverless function...).
// Run after `npm run build`:  node examples/library-usage.mjs
import {
  FieldMapper,
  LeadProcessor,
  MemoryStore,
  normalizeBdPhone,
  parseLeadgenEvents,
  signPayload,
  verifySignature,
} from '../dist/src/index.js';

const APP_SECRET = 'example-app-secret';

// 1. Verify the raw body exactly as received.
const raw = Buffer.from(JSON.stringify({
  object: 'page',
  entry: [{ id: '111', time: 1763010000, changes: [{ field: 'leadgen', value: { leadgen_id: '900000000000001', page_id: '111', form_id: '222' } }] }],
}));
const header = signPayload(raw, APP_SECRET); // what Meta would send
console.log('signature ok:', verifySignature(raw, header, APP_SECRET).ok);

// 2. Extract leadgen events.
const { events } = parseLeadgenEvents(JSON.parse(raw.toString()));

// 3. Process with a stand-in Graph client and a custom sink.
const processor = new LeadProcessor({
  graph: {
    getLead: async (id) => ({
      id,
      created_time: '2026-11-13T05:00:00+0000',
      field_data: [
        { name: 'full_name', values: ['Rahim Uddin'] },
        { name: 'phone_number', values: ['01712-345678'] },
      ],
    }),
  },
  store: new MemoryStore(),
  mapper: new FieldMapper({
    columns: [
      { name: 'Name', from: 'field.full_name' },
      { name: 'Phone', from: 'field.phone_number', transform: ['phone_bd'] },
    ],
  }),
  sinks: [{ name: 'console', type: 'custom', send: async ({ mapped }) => console.log('lead:', mapped.values) }],
});

for (const event of events) console.log(await processor.process(event));
console.log('again:', (await processor.process(events[0])).status); // duplicate

console.log(normalizeBdPhone('+880 1812-345678', 'national'));
