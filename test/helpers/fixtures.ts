import { generateKeyPairSync } from 'node:crypto';
import type { Lead, LeadgenEvent } from '../../src/types.js';

export const APP_SECRET = 'test-app-secret-0123456789';
export const VERIFY_TOKEN = 'test-verify-token';
export const PAGE_TOKEN = 'EAAtestpagetoken';
export const PAGE_ID = '111111111111111';
export const FORM_ID = '222222222222222';

export function leadId(n: number): string {
  return String(900000000000000 + n);
}

export function webhookBody(ids: string[], extra: unknown[] = []): object {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1763000000,
        changes: [
          ...ids.map((id) => ({
            field: 'leadgen',
            value: {
              leadgen_id: id,
              page_id: PAGE_ID,
              form_id: FORM_ID,
              adgroup_id: '333333333333333',
              ad_id: '333333333333333',
              created_time: 1763000000,
            },
          })),
          ...extra,
        ],
      },
    ],
  };
}

export function event(id: string, overrides: Partial<LeadgenEvent> = {}): LeadgenEvent {
  return { leadgenId: id, pageId: PAGE_ID, formId: FORM_ID, adId: '333333333333333', createdTime: 1763000000, ...overrides };
}

export function lead(id: string, overrides: Partial<Lead> = {}): Lead {
  return {
    id,
    created_time: '2026-11-13T05:12:44+0000',
    ad_id: '333333333333333',
    form_id: FORM_ID,
    field_data: [
      { name: 'full_name', values: ['Rahim Uddin'] },
      { name: 'phone_number', values: ['01712-345678'] },
      { name: 'email', values: [' Rahim@Example.COM '] },
      { name: 'which_service?', values: ['SEO', 'Meta ads'] },
    ],
    ...overrides,
  };
}

let cachedKey: string | undefined;

/** A throwaway RSA key in PEM, standing in for a service account key. */
export function testPrivateKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  cachedKey = privateKey;
  return { privateKey, publicKey };
}

export function serviceAccountJson(privateKey = cachedKey ?? testPrivateKey().privateKey): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'key-id-1',
    private_key: privateKey,
    client_email: 'lead-sync@example-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}
