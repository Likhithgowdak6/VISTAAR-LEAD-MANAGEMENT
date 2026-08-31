# WAM CRM AI — frontend

React 19 + Vite + Tailwind CSS 4 SPA for the WAM CRM AI backend.

Documentation lives in the repository's [`docs/`](../docs/README.md) folder:

- [Frontend architecture](../docs/10-frontend.md) — structure, auth state, realtime, components
- [Getting started](../docs/02-getting-started.md) — setup and local development
- [API reference](../docs/09-api-reference.md) — the endpoints this app consumes

```bash
npm run dev        # http://localhost:5173
npm run lint
npm test
npm run build      # typecheck + production build
```

`VITE_API_BASE_URL` overrides the API target (default `http://localhost:5001/api/v1`).
