# Contributing

Thanks for helping. G-Spot Assistant reads people's mail, so a few rules come before everything else.

## Rules every change keeps

1. **Nothing but Google on the network.** The server calls Google's APIs, and fetches Claude's client metadata document from `claude.ai`. No other host, no telemetry, no update check, no third-party API, not even optional ones.
2. **Nothing personal in logs.** Never log tokens, secrets, email or file content, subjects, names or the addresses of other people. Log aliases, ids, counts, statuses and error names.
3. **Nothing personal stored in clear.** Anything personal kept in SQLite is encrypted with a key derived from `TOKEN_ENCRYPTION_KEY` (see `src/crypto.ts`). Ids, statuses and dates may stay in clear.
4. **No real people in tests or examples.** Use `example.com`, `.example` domains and invented names. Never paste real mail, addresses or documents into the repository.
5. **Few dependencies.** Each runtime dependency is code that can see mailboxes. Prefer Node's built-ins; a new dependency needs a good reason in the pull request.
6. **Tool descriptions are part of the product.** Claude reads them to decide what to do: keep them precise, and keep tool results compact (paginate, clip, drop empty fields).

## Getting started

Node 24 (see `.node-version`).

```bash
npm ci
cp .env.example .env     # BASE_URL=http://localhost:8080, DATA_DIR=./data, a Google client, your email, a key
npm run dev              # builds and starts with .env
npm test                 # builds and runs every test; Google is faked, no network needed
npm run typecheck
docker compose up --build
```

A Google client for local work needs `http://localhost:8080/auth/google/callback` as a redirect URI. Tests use fake Google responses (`src/test-support.ts`, `src/followups/test-mailboxes.ts`); never call Google from a test.

## Pull requests

- One topic per pull request, with tests for what changes.
- `npm run typecheck` and `npm test` pass, and CI is green (it also builds the Docker image).
- Update `docs/REFERENCE.md` or `docs/SETUP.md` when behaviour or setup changes. Keep the README short and free of jargon: it is for people who do not code.

## License

By contributing you agree that your contribution is licensed under the [GNU AGPL v3](LICENSE), like the rest of the project.
