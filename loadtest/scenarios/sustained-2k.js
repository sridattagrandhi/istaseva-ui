// Sustained 2k-concurrent scenario — modeled on the month-1 target of
// 10k registered / ~2k concurrent at peak. Ramps up, sustains, ramps down.
//
// Total duration: ~10 min. Expect this to surface:
//   • RDS connection saturation (should be fine now that RDS Proxy is in)
//   • listConversations latency (should be flat with the denormalized table)
//   • Redis/WS fan-out hot paths
//   • Rate-limiter interference on shared IPs (run from multiple sources
//     if you want to simulate many users rather than one CI runner)

import { sleep } from 'k6';
import { get, post, RECEIVER_ID } from '../lib/common.js';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 500 },   // warm-up
        { duration: '2m', target: 2000 },  // ramp to target
        { duration: '5m', target: 2000 },  // sustain
        { duration: '2m', target: 0 },     // ramp down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Reads must stay responsive at p95.
    'http_req_duration{name:listings_browse}': ['p(95)<800'],
    'http_req_duration{name:search}':          ['p(95)<1200'],
    'http_req_duration{name:conversations_list}': ['p(95)<500'],
    // Writes can be a bit slower.
    // Overall error rate and check pass-rate.
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.98'],
  },
};

// Read-only weighted journey. Writes are omitted for this scenario because
// a single test account + single source IP would saturate the per-user /
// per-IP rate limits long before any actual DB pressure showed up. Reads
// are where the scaling questions live anyway (conversations table,
// search relevance path, listing catalog). Each VU iteration = one
// simulated user action.
export default function () {
  const r = Math.random();

  if (r < 0.40) {
    get('/api/listings?limit=20', { tag: 'listings_browse' });
  } else if (r < 0.60) {
    get('/api/search?q=hotel', { tag: 'search' });
  } else if (r < 0.85) {
    get('/api/conversations?limit=50', { tag: 'conversations_list' });
  } else {
    get(`/api/conversations/${RECEIVER_ID}?limit=50`, { tag: 'conversation_detail' });
  }

  sleep(Math.random() * 2 + 0.5); // 0.5–2.5s think time
}
