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

E2E simulates four-player and eight-player games over real WebSockets, including refresh, authorization/privacy guards, three balanced detective rounds, voting, reveal, replay, and both majority and split-vote outcomes. Unit tests cover seeded evidence/timeline validation, quota fallback, DO state reload, presence and TTS caching/failure. Build before unit tests because the storage/TTS tests import the bundled Worker. Set `MYSTERY_ARTIFACT=/absolute/path/case.json` during E2E to save the first mock game's public case, private cards and reveal.

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

Normal mode makes **one** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` JSON-schema call, capped at 900 output tokens and a 20-second caller deadline. A seeded, hand-written case ledger chooses among six settings, five eras, five genres and five clued methods, assigns invented names and a killer, and fixes the clock, alibis, evidence and deductions. The AI edits the title and character voices and may order the printed evidence for the reveal; it cannot invent the solution or change the ledger. Invalid reveal references are repaired from the ledger. All AI errors, including quota errors 429/4006, immediately select the complete **classic case**, without retrying or blocking the party. Detective questions and answer-quoting reactions are local templates, with no further text-model calls. Replay avoids the previous setting, era, genre and method. Underlying Workers AI calls may continue after the caller deadline because the binding does not expose cancellation. Optional Gemini can provide the edit without a Workers AI binding; explicit mock mode always wins. Keep secrets in Cloudflare secrets (or gitignored `.dev.vars` locally), never in the browser or committed configuration.

The host's `/api/tts?code=XXXX` endpoint calls `@cf/deepgram/aura-1` (`orion`, MP3). Only authenticated hosts can request current public narration or its exact sentence chunks. The browser plays chunks of at most 260 characters sequentially, including the long reveal. Audio is cached by text (64 chunks, cleared by hibernation). A failed voice request disables further remote voice calls in that room; a known text quota error skips remote voice altogether. Empty/invalid responses and model/rate-limit/network failures use chunked browser `speechSynthesis`, selecting a local English voice when available. The server deadline is 12 seconds, browser fetch deadline 15 seconds. Phones can explicitly read the public scene or reveal using their device voice, never another player's private card. If the OS has no working speech engine, a persistent narration status explains that text is still available rather than promising replay will fix it. Browser autoplay may require a click. Phone dictation uses browser SpeechRecognition where available, with keyboard fallback.

## Rules & privacy

Host creates a room, guests join, host starts. Read role cards, introduce characters and read each shareable clue aloud. Three guests answer per round, on a rotation whose total question counts differ by at most one for every supported party size. The TV identifies player and character and marks waiting/answered status. Guests answer out loud **and** submit text. The detective quotes those statements; host controls pacing. After all votes, the tally and evidence-referenced solution identify the catchable moment and interpret the actual votes. The killer loses only with an absolute majority (more than half of all players). Replay keeps the guest identities and clears the mystery, answers and votes.

Role cards are projected server-side by player identity; the host never receives private cards or killer flags before reveal. Host/player capabilities are random tokens in localStorage, not guessable room codes. Refresh uses that token to recover the same role. Do not share a browser profile across players: anyone with a player's localStorage token can impersonate that player. Names and AI text are escaped before rendering. A shared screen should never be used to open private phone cards.

Room state (including private roles and votes) is stored in DO storage and survives hibernation/restarts. Socket identity and heartbeat times are stored in hibernation attachments; interrupted preparation clears its busy flag and shows a retry message. Two-second heartbeats mark a silent guest offline after six seconds, and lobby seats are released after fifteen seconds disconnected. Duplicate names are rejected case-insensitively. Active-game seats are never removed automatically: an offline guest can recover their role, answer and vote. The host cannot bypass a required guest answer or vote, so keep phones connected. Each room expires and deletes its data **24 hours after creation**. Room codes are invitations, not passwords. There is no host-transfer feature or account-level abuse protection; add Cloudflare rate limiting before broad public promotion.

The plot and fallback use the same curated evidence engine rather than unrestricted AI plots. Mock mode selects varied classic cases without any model calls. Automated tests never call live AI.
