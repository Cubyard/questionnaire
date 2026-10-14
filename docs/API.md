# Questionnaire API

Base URL: the deployed Worker (see the README). All bodies are JSON.

## Admin API

Every admin call needs `Authorization: Bearer <ADMIN_TOKEN>`. The token is a
Worker secret; locally it lives in `~/.config/questionnaire/admin.env`
(never in this repo).

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/admin/polls` | List polls with status, response counts and share links |
| POST | `/api/admin/polls` | Create a poll (body: poll definition below) |
| GET | `/api/admin/polls/{idOrSlug}` | One poll's full definition |
| PATCH | `/api/admin/polls/{idOrSlug}` | Merge changes (e.g. `{"status":"closed"}`) |
| PUT | `/api/admin/polls/{idOrSlug}` | Replace the whole definition |
| DELETE | `/api/admin/polls/{idOrSlug}` | Delete the poll and every response; its link stops working |
| GET | `/api/admin/polls/{idOrSlug}/results` | Tallies per question, including all free-text answers |
| GET | `/api/admin/polls/{idOrSlug}/responses` | Every response as JSON (`?format=csv` for CSV) |
| DELETE | `/api/admin/polls/{idOrSlug}/responses` | Clear responses, keep the poll |

Errors come back as `{"error": {"code", "message", "details?"}}` with a
matching status (400 invalid input, 401 bad token, 404 unknown poll, 409
slug taken).

### curl

```sh
source ~/.config/questionnaire/admin.env   # QUESTIONNAIRE_URL, QUESTIONNAIRE_ADMIN_TOKEN
auth="Authorization: Bearer $QUESTIONNAIRE_ADMIN_TOKEN"

curl -s -H "$auth" "$QUESTIONNAIRE_URL/api/admin/polls"
curl -s -H "$auth" -H 'content-type: application/json' \
  --data @examples/sample-poll.json "$QUESTIONNAIRE_URL/api/admin/polls"
curl -s -H "$auth" -X PATCH -H 'content-type: application/json' \
  -d '{"status":"closed"}' "$QUESTIONNAIRE_URL/api/admin/polls/team-lunch"
curl -s -H "$auth" "$QUESTIONNAIRE_URL/api/admin/polls/team-lunch/responses?format=csv"
```

The `qn` CLI in `bin/qn.mjs` wraps the same calls (`./bin/qn.mjs help`).

## Poll definition

```jsonc
{
  "slug": "team-lunch",            // optional; 3-64 of a-z 0-9 -; random if omitted
  "title": "Team lunch",           // required
  "description": "Optional intro text",
  "status": "open",                // draft (hidden) | open | closed. Default draft
  "closesAt": "2026-11-01T17:00:00Z", // optional; stops responses after this time
  "settings": {
    "showResults": "after_submit", // never | after_submit (default) | public
    "allowMultipleResponses": true,// default true; false = one response per browser
    "maxResponses": 500,           // optional cap
    "confirmationMessage": "Thanks!",
    "theme": { "hue": 210, "hue2": 330 } // optional; colors otherwise come from the slug
  },
  "questions": [
    { "id": "cuisine", "type": "single", "title": "Which cuisine?", "options": ["Tacos", "Sushi"], "allowOther": true },
    { "id": "diet", "type": "multiple", "title": "Dietary needs?", "options": ["Vegan", "Gluten free"], "maxSelections": 2, "required": false },
    { "id": "name", "type": "text", "title": "Your name" },
    { "id": "notes", "type": "paragraph", "title": "Anything else?", "required": false },
    { "id": "hunger", "type": "rating", "title": "How hungry?", "max": 5 },
    { "id": "nps", "type": "scale", "title": "Recommend us?", "min": 0, "max": 10, "minLabel": "No", "maxLabel": "Yes" }
  ]
}
```

Question `id`s default to `q1`, `q2`, ... and `required` defaults to `true`.
Keep ids stable when editing a poll that already has responses: answers are
stored by id.

## Response and results shapes

`GET .../responses`:

```json
{
  "poll": { "id": "...", "slug": "team-lunch", "title": "...", "questions": [ ... ] },
  "responses": [
    { "id": "...", "createdAt": "2026-10-14T03:00:00.000Z",
      "answers": { "cuisine": "Tacos", "diet": ["Vegan"], "hunger": 4 } }
  ]
}
```

Single choice answers are strings, multiple choice are string arrays, rating
and scale are integers, text is a string. A choice that isn't one of the
options is the respondent's "other" text.

`GET .../results`:

```json
{
  "total": 12,
  "questions": [
    { "id": "cuisine", "type": "single", "title": "Which cuisine?", "answered": 12,
      "options": [{ "label": "Tacos", "count": 7 }, { "label": "Sushi", "count": 4 }],
      "other": { "count": 1, "answers": ["Ramen"] } },
    { "id": "hunger", "type": "rating", "answered": 12, "average": 3.75,
      "distribution": [{ "value": 1, "count": 0 }, ...] },
    { "id": "notes", "type": "paragraph", "answered": 5, "answers": ["..."] }
  ]
}
```

## Public endpoints (used by the poll page)

- `GET /api/polls/{slug}`: the poll for respondents (drafts 404)
- `POST /api/polls/{slug}/responses`: `{ answers, respondentId, website, turnstileToken? }`
- `GET /api/polls/{slug}/results?respondentId=`: tallies without free text, following `showResults`

## Abuse protection

- 10 submissions per minute per IP (Workers rate limiting binding)
- Hidden honeypot field; bots that fill it get a fake success and nothing is stored
- Answers are validated against the poll and size-capped (64 KB body, 5,000 chars per paragraph)
- Optional Cloudflare Turnstile: set `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET` (secret)
- IPs are only stored as a salted hash
- `maxResponses` and `closesAt` cap a poll that gets out of hand; `DELETE` takes it down entirely
