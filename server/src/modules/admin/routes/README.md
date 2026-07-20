Admin routes.

Mounted at `/api/admin` (see `admin.routes.ts`). Every route is gated by:

- `requireAuth`
- `requireRole('admin')` — the `admin` role comes from the Firebase custom claim
  on the user's token (`req.user.role`).

Current endpoints (read-only analytics, backed by the nightly rollup tables):

- `GET /api/admin/metrics/overview?days=30`
- `GET /api/admin/metrics/funnel?days=30`
- `GET /api/admin/metrics/search-terms?days=30&limit=20`
- `GET /api/admin/metrics/engagement?days=30`
