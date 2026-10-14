# Questionnaire

Quick, beautiful polls and questionnaires. Every poll gets its own color
palette, answers animate in, and respondents see how everyone answered (with
their own picks highlighted) right after they submit.

Polls are created and managed through an authenticated admin API, so a script,
the `qn` CLI, or a Claude project can create polls, edit them, take them down,
and pull responses for dashboards.

**Stack:** one Cloudflare Worker serving static assets plus a JSON API, with
D1 (SQLite) for polls and responses. It fits in Cloudflare's free tier at low
traffic; the paid Workers plan ($5/month) is the ceiling if it ever outgrows it.

## Question types

`single`, `multiple` (optional max selections), `text`, `paragraph`, `rating`
(stars), `scale` (0-10 or 1-10 with end labels). Choice questions can allow a
free-text "other".

## Using it

```sh
export QUESTIONNAIRE_URL=https://questionnaire.<subdomain>.workers.dev
export QUESTIONNAIRE_ADMIN_TOKEN=...   # or put both in ~/.config/questionnaire/admin.env

./bin/qn.mjs create examples/sample-poll.json   # prints the share link
./bin/qn.mjs list
./bin/qn.mjs results team-lunch
./bin/qn.mjs export team-lunch --csv -o lunch.csv
./bin/qn.mjs close team-lunch
./bin/qn.mjs delete team-lunch --yes            # the link stops working
```

Share links look like `https://<host>/p/<slug>`; `/p/<slug>/results` shows
results when the poll allows it. Full API and poll format: [docs/API.md](docs/API.md).

## Development

```sh
npm install
printf 'ADMIN_TOKEN=dev-admin-token\nIP_SALT=dev-salt\n' > .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787
npm test && npm run typecheck
```

## Deploying

```sh
npx wrangler login
npx wrangler d1 create questionnaire        # put the id in wrangler.jsonc
npm run db:migrate:remote
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN
openssl rand -hex 32 | npx wrangler secret put IP_SALT
npm run deploy
```

Optional Turnstile: create a widget, set `TURNSTILE_SITE_KEY` under `vars` in
`wrangler.jsonc`, and `npx wrangler secret put TURNSTILE_SECRET`.
