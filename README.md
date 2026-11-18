# Dead of Night — Murder Mystery Party

A phone-and-TV murder mystery for 3–8 guests. One Cloudflare Worker, one SQLite-backed Durable Object per four-letter room, native hibernating WebSockets, no external services or keys required. The host is a public display; join on a separate phone if the host wants a role too.

## Local development (Node 22+)

```sh
npm ci
npm run dev
# http://localhost:8787 — mock case, no Cloudflare login or AI credits needed
```

`npm run dev` builds then starts `wrangler dev --config wrangler.mock.toml`. This local-only configuration sets `MOCK_AI=1` and omits the remote AI binding, so Wrangler does not need Cloudflare credentials just to start. Setting `--var MOCK_AI:1` on the default production configuration alone is insufficient: Wrangler still tries to initialize its remote AI proxy. On a local network, run `npx wrangler dev --config wrangler.mock.toml --ip 0.0.0.0` after building and open the host screen using the computer's LAN address, **not localhost**, so the displayed join URL and QR work on phones. Use HTTPS for microphone dictation; typing always works. The local port defaults to 8787, configurable with Wrangler's `--port` flag.

```sh
npm run lint
npm run build
npm test
# With the mock dev server running:
npm run test:e2e
# Optional: TEST_URL=http://127.0.0.1:8787 npm run test:e2e
```

E2E simulates a host and four players over real WebSockets, including refresh, authorization/privacy guards, three detective rounds, voting, reveal, replay, and both majority and split-vote outcomes. Unit tests cover schema validation, retry limits, DO state reload and TTS caching/failure. Build before unit tests because the storage/TTS tests import the bundled Worker.

## Cloudflare deployment handoff — not deployed

`npm run build` emits **only `dist/worker.js`**, an ESM bundle with HTML, CSS, browser JavaScript and QR generation embedded. No static assets upload, Node runtime, Docker, Fly.io, or remote Git repository is required. `wrangler.toml` declares the `AI` binding and `ROOMS` SQLite Durable Object migration. Deploy that bundle with those bindings and migration through your Cloudflare API workflow; do not omit the migration. No deployment is performed by CI.

### Bindings and variables

| Binding / variable | Purpose |
| --- | --- |
| `ROOMS` | Durable Object namespace bound to exported class `Room` (required) |
| `AI` | Workers AI binding, text + voice; missing binding selects mock mode |
| `MOCK_AI=1` | Force canned case/detective, browser-only speech, no model calls |
| `GEMINI_API_KEY` | Optional secret: use Gemini for text instead of Workers AI |
| `GEMINI_MODEL` | Optional Gemini model, default `gemini-2.5-flash` |
| `TEST_URL` | E2E target, default `http://127.0.0.1:8787` |

Normal mode uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with JSON-schema output, parsing, validation and one retry for mystery generation. One authoritative `killerPlayerId` is mapped to private per-character killer flags server-side, avoiding inconsistent model-generated booleans. If the model omits that ID or returns an invalid one, a single explicit killer flag is used; otherwise the server assigns one randomly and supplies missing motive/method/tips and a matching fallback solution. That last-resort solution explicitly acknowledges inconclusive clues rather than claiming they prove the randomly chosen identity. Each text request has a 55-second caller deadline (at most two attempts for generation); concise case prompts use 3,500 tokens and questions/reactions use smaller budgets. Underlying Workers AI calls may continue after a caller deadline because the binding does not expose cancellation here. Workers AI's free allocation is quota-limited, not unlimited; account limits still apply. Optional Gemini does not override explicit mock mode or a missing `AI` binding. Keep secrets in Cloudflare secrets (or gitignored `.dev.vars` locally), never in the browser or committed configuration.

The host's `/api/tts?code=XXXX` endpoint calls `@cf/deepgram/aura-1` (`orion`, MP3). Only authenticated hosts can request narration, and only current public narration text is accepted. Audio is cached by text in a bounded, per-object memory cache (cleared by hibernation). Empty/invalid responses and model/rate-limit/network failures fall back to browser `speechSynthesis`; the server's 25-second caller deadline allows fallback before the browser's 30-second fetch timeout. Browser autoplay policies may require tapping **Hear again**. Text remains readable if speech is unsupported. Phone dictation uses browser SpeechRecognition where available, with keyboard fallback.

## Rules & privacy

Host creates a room, guests join, host starts. Read role cards, introduce characters, then progress through three rounds. The detective chooses two or three guests per round (three in mock mode), who answer out loud **and** submit text. The detective reacts; host controls pacing. After all votes, the tally and solution are revealed. The killer loses only with an absolute majority (more than half of all players). Replay keeps the guest identities and clears the mystery, answers and votes.

Role cards are projected server-side by player identity; the host never receives private cards or killer flags before reveal. Host/player capabilities are random tokens in localStorage, not guessable room codes. Refresh uses that token to recover the same role. Do not share a browser profile across players: anyone with a player's localStorage token can impersonate that player. Names and AI text are escaped before rendering. A shared screen should never be used to open private phone cards.

Room state (including private roles and votes) is stored in DO storage and survives hibernation/restarts. Socket identity is stored in hibernation attachments; interrupted generation clears its busy flag on wake so the host can retry. Each room expires and deletes its data **24 hours after creation**. Room codes are invitations, not passwords; unknown guests can join an open lobby if they know the code. The guest limit is enforced on the server. An offline guest can reconnect, but the host cannot bypass their required answer or vote: keep phones connected. There is currently no kick-player or host-transfer feature. This prototype has connection and payload bounds but no account-level abuse protection; add Cloudflare rate limiting before broad public promotion.

AI-generated narrative consistency is encouraged by the prompt and structure validation, not provably guaranteed. Mock mode is a fixed rehearsal story. No live AI calls are made by the automated tests.
