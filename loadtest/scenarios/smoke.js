// Smoke test — 30 s, 10 VUs. Sanity-checks that the stack is reachable and
// core reads work. Use this as the first step after any deploy.

import { sleep } from 'k6';
import { get, RECEIVER_ID } from '../lib/common.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  // Public: health check — must stay snappy under any load.
  // Baseline internet RTT from a laptop → CloudFront → ALB → ECS is
  // ~200-300ms. p95 TLS-handshake + first-byte variance from a laptop over
  // the public internet regularly touches 700ms, so 800ms keeps us testing
  // the server (which itself returns in <10ms) without flagging ordinary
  // network jitter. Run from inside the VPC if you want sub-100ms assertions.
  get('/health', { tag: 'health', slowMs: 800 });

  // Public: listings browse.
  get('/api/listings?limit=20', { tag: 'listings_browse' });

  // Public: search.
  get('/api/search?q=hotel', { tag: 'search' });

  // Authenticated: user's own conversations (denormalized table path).
  get('/api/conversations', { tag: 'conversations_list' });

  // Authenticated: a single conversation thread.
  get(`/api/conversations/${RECEIVER_ID}?limit=50`, { tag: 'conversation_detail' });

  sleep(1);
}
