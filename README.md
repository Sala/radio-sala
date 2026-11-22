# Radio Sala

Personal station. One Cloudflare Worker serves the Vue app as static assets and a Hono API. A Durable Object is the clock for each live station. YouTube's own player stays visible and plays in the browser.

## Run locally

```sh
npm install
npm run dev
```

Open http://127.0.0.1:8787

`npm run dev` applies the D1 migration to the local database, builds the Vue app into `dist/`, and starts `wrangler dev` on port 8787. This does not deploy.

## Bindings

Secrets are names only. Put values in `.dev.vars` (see `.dev.vars.example`) for local Wrangler. For a later deploy, use `wrangler secret put`. Do not write the values into the repo.

| Name | Kind | What it is |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret |
| `SESSION_SECRET` | secret | HMAC key for the session cookie |
| `YOUTUBE_API_KEY` | secret | YouTube Data API key |
| `DB` | D1 `radio-sala` | Allowlist, DJs, users, settings, tracks, stations |
| `CLIPS` | R2 `radio-sala-clips` | Cached DJ speech |
| `AI` | Workers AI | Speech model `@cf/deepgram/aura-1`. Commented out of `wrangler.jsonc` because the binding has no local simulator and would stop `wrangler dev` without a Cloudflare login. Uncomment `"ai": { "binding": "AI", "remote": true }` after `wrangler login`. |
| `STATION` | Durable Object `Station` | One object per live station |
| `ASSETS` | static assets | The built Vue app |

Google's redirect URI for this local server is `http://127.0.0.1:8787/api/auth/callback`.

The D1 `database_id` in `wrangler.jsonc` is a local placeholder. Replace it with the id from `wrangler d1 create radio-sala` before any deploy.

## What works before the secrets are set

The gate loads and names any unset secret. A share link opens the listen-only route. Sign-in, settings, starting a station, YouTube search, and DJ speech wait until the binding they need is present. A missing key is shown on the screen. It does not throw a blank error.

Allowed sign-in is seeded as `scorbaciufermecat@gmail.com`. The DJs seeded in D1 are Vinnie Vega, Rosa Marquez, and Miles Crowe.

## Speech

DJ speech calls Workers AI model `@cf/deepgram/aura-1` and stores the mp3 in the R2 binding `CLIPS`. No other voice provider is configured. The `AI` binding is commented out so this local server starts without a Cloudflare API token. The call is still in `worker/speech.ts`. Uncomment the binding after `wrangler login` when you want audio. Until that call returns audio, a break stays on screen as text.

Breaks can use Wikipedia's on-this-day feed, a Wikipedia or MusicBrainz note about the real artist, Open-Meteo for the city in settings, and GDELT headlines for world, Romania, or music. If a source does not answer, the screen says so and the DJ does not invent the missing fact.

Songs kept from YouTube are public, embeddable, in the music category, and between 1.5 and 7 minutes. Age-restricted videos, region-restricted videos, YouTube Topic art tracks, and mixes are dropped. If the player still refuses one, the host or a listener skips to the next candidate. The start screen picks one song, from a mood or a lookup. Later tracks follow that song: another by the same artist, then a related mood, not more results for the words that found the first one.
