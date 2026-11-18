import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMystery, generateMystery, questions, reaction, quoteExcerpt, isMock, withDeadline } from '../ai.js';
import { buildCase, banned, evidenceAtRound } from '../cases.js';
import { narrationChunks } from '../public/narration.js';
import { Room } from '../dist/worker.js';

const people = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Guest ${i}`, token: `token${i}` }));
const players = people(4);
const fixture = (p = players) => buildCase(p, { seed: 'regression-case' });
test('seeded classic cases cover 3–8 guests, varied worlds and grounded shareable evidence', () => {
  const settings = new Set(), eras = new Set(), genres = new Set(), methods = new Set();
  for (let n = 3; n <= 8; n++) for (let seed = 0; seed < 40; seed++) {
    const p = people(n), m = validateMystery(buildCase(p, { seed: String(seed) }), p);
    settings.add(m.settingName); eras.add(m.era); genres.add(m.genre); methods.add(m.methodName);
    assert.equal(banned.test(JSON.stringify(m)), false);
    assert.equal(m.characters.filter(c => c.killer).length, 1);
    assert.equal(m.characters.length, n);
    assert.equal(new Set(m.characters.map(c => c.personality)).size, n);
    assert.equal(new Set(m.characters.map(c => c.relationship)).size, n);
    assert.ok(m.characters.every(c => c.relationship.includes(m.victim)));
    for (const c of m.characters) {
      assert.equal(c.playerName, p.find(p => p.id === c.playerId).name);
      assert.ok(!p.some(p => p.name === c.name)); assert.notEqual(c.secret, 'None');
      assert.ok(m.solutionClueIds.includes(c.shareableClueId));
      assert.ok(c.clues.every(clue => clue.subjectId !== c.playerId));
    }
    assert.equal(new Set(m.solutionClueIds).size, n * 2 + 1);
    assert.match(m.solution, /moment to catch/);
  }
  assert.deepEqual([settings.size, eras.size, genres.size, methods.size], [6, 5, 5, 5]);
  assert.deepEqual(fixture(), fixture());
  const first = fixture(), next = buildCase(players, { seed: 'regression-case', previous: first });
  for (const key of ['settingName', 'era', 'genre', 'methodName']) assert.notEqual(next[key], first[key]);
  assert.throws(() => buildCase([]));
  assert.equal(isMock({}), true); assert.equal(isMock({ AI: {}, MOCK_AI: '1' }), true);
});
test('validator rejects invalid coverage, timelines, self-clues, unprinted evidence and invented reveal facts', () => {
  assert.throws(() => validateMystery({}, players));
  for (const change of [
    m => { m.characters.forEach(c => { c.killer = true; }); },
    m => { m.characters[1].playerId = m.characters[0].playerId; },
    m => { m.characters.pop(); }, m => { m.characters[0].clues = []; }, m => { m.title = ''; },
    m => { m.timeOfDeath = 'during dinner'; }, m => { m.timeline[2].time = '00:00'; },
    m => { m.characters[0].alibiTime = '00:00'; },
    m => { m.characters[0].clues[0].subjectId = m.characters[0].playerId; },
    m => { m.solutionClueIds.push('C999'); }, m => { m.solution += ' An unseen fingerprint proves it.'; },
    m => { m.methodClueId = m.catchClueId; }, m => { m.title = 'Blackstone Manor'; },
    m => { m.characters.flatMap(c => c.clues).find(c => c.id === m.catchClueId).unlockRound = 1; },
    m => { m.characters[0].clues[0].unlockRound = 4; }
  ]) { const m = fixture(); change(m); assert.throws(() => validateMystery(m, players)); }
});
test('one small json_schema call edits the case, repairs invalid citations, and ignores extra properties', async () => {
  const m = fixture(); let calls = 0;
  const env = { AI: { run: async (_model, input) => {
    calls++; assert.equal(input.response_format.type, 'json_schema'); assert.equal(input.max_tokens, 900);
    return { response: { title: 'Dead Letters After Dark', voices: players.map(p => ({ playerId: p.id, personality: 'Dry humour; impatient with evasions.' })), revealClueIds: ['C999'], killerPlayerId: 'intruder', solution: 'An invented clue', characters: [] } };
  } } };
  const generated = await generateMystery(env, players, { seed: m.seed });
  assert.equal(generated.source, 'ai'); assert.equal(calls, 1);
  assert.deepEqual(generated.solutionClueIds, m.solutionClueIds); assert.equal(generated.solution, m.solution);
  assert.equal(generated.killerPlayerId, undefined);
});
test('quota 4006/429, malformed output, bad edits and any AI error fall back immediately without retries', async () => {
  for (const failure of [new Error('429: code 4006 daily allocation exceeded'), new Error('network unavailable'), '{', {}, { title: 'Mansion of Deceit', voices: [] }]) {
    let calls = 0;
    const env = { AI: { run: async () => { calls++; if (failure instanceof Error) throw failure; return { response: failure }; } } };
    const m = await generateMystery(env, players, { seed: 'failure' });
    assert.equal(m.source, 'classic'); assert.equal(calls, 1); validateMystery(m, players);
    if (failure instanceof Error && /4006/.test(failure.message)) assert.equal(m.quotaLimited, true);
  }
  const m = await generateMystery({ AI: { run: async () => ({ errors: [{ code: 4006, message: 'quota' }] }) } }, players);
  assert.equal(m.quotaLimited, true);
});
test('questions are balanced, nonrepeating and reference only the addressee’s unlocked clue', async () => {
  const env = { AI: { run: () => { throw new Error('Detective must not call AI'); } } };
  for (let n = 3; n <= 8; n++) {
    const m = fixture(people(n)), counts = Object.fromEntries(m.characters.map(c => [c.playerId, 0])), lines = [];
    for (let round = 1; round <= 3; round++) {
      const qs = await questions(env, m, round); assert.equal(qs.length, 3);
      assert.equal(new Set(qs.map(q => q.playerId)).size, 3);
      for (const q of qs) { counts[q.playerId]++; const c = m.characters.find(c => c.playerId === q.playerId); assert.ok(c.clues.some(clue => clue.unlockRound <= round && q.text.includes(clue.id))); assert.ok(!q.text.includes(c.secret)); lines.push(q.text); }
    }
    assert.equal(new Set(lines).size, 9);
    assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1);
    assert.ok(Object.values(counts).every(n => n >= 1));
  }
});
test('reactions quote actual answers, distinguish rounds, handle empty input and never call AI', async () => {
  const m = fixture(), env = { AI: { run: () => { throw new Error('No AI'); } } };
  const lines = await Promise.all([1, 2, 3].map(round => reaction(env, m, { p0: 'I checked the entry recorder.' }, round)));
  assert.equal(new Set(lines).size, 3); lines.forEach(line => assert.ok(line.includes('I checked the entry recorder.')));
  assert.match(await reaction(env, m, {}), /No statements/);
});
test('quote excerpts keep complete short answers and mark word-boundary omissions', async () => {
  assert.equal(quoteExcerpt('I checked it out.'), 'I checked it out.');
  assert.equal(quoteExcerpt(''), ''); assert.equal(quoteExcerpt(null), '');
  assert.equal(quoteExcerpt('A complete phrase', 17), 'A complete phrase');
  assert.equal(quoteExcerpt('I checked it out yesterday.', 16), 'I checked it…');
  assert.equal(quoteExcerpt('indivisibleword', 6), '…');
  const answer = 'I checked it out. '.repeat(30), excerpt = quoteExcerpt(answer);
  assert.ok(excerpt.length <= 180); assert.ok(excerpt.endsWith('…'));
  assert.ok(answer.startsWith(excerpt.slice(0, -1)));
  const next = answer[excerpt.length - 1]; assert.match(next, /\s/);
  assert.ok((await reaction({}, fixture(), { p0: answer })).includes(`“${excerpt}”`));
});
test('evidence escalates from ambiguous leads to method/motive then the decisive alibi record', () => {
  for (let n = 3; n <= 8; n++) for (let seed = 0; seed < 20; seed++) {
    const m = buildCase(people(n), { seed: String(seed) }), all = m.characters.flatMap(c => c.clues);
    assert.deepEqual(evidenceAtRound(m, 0), []);
    for (let round = 1; round <= 3; round++) {
      const evidence = evidenceAtRound(m, round), fresh = evidence.filter(c => c.unlockRound === round);
      assert.ok(fresh.length > 0);
      assert.ok(evidence.every(c => c.explanation === undefined && c.kind === undefined));
    }
    assert.ok(evidenceAtRound(m, 1).every(c => all.find(clue => clue.id === c.id).kind === 'redHerring'));
    assert.ok(evidenceAtRound(m, 2).some(c => c.id === m.methodClueId));
    assert.ok(evidenceAtRound(m, 2).some(c => c.id === m.motiveClueId));
    assert.ok(!evidenceAtRound(m, 2).some(c => c.id === m.catchClueId));
    assert.ok(m.characters.every(c => c.clues.some(clue => clue.unlockRound === 1)));
    assert.deepEqual(new Set(evidenceAtRound(m, 3).map(c => c.id)), new Set(m.solutionClueIds));
  }
});
test('model deadline releases a hung caller', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 5), /timed out/);
  assert.equal(await withDeadline(Promise.resolve('ready'), 5), 'ready');
});
test('narration splits a long reveal into bounded sentence/word chunks without dropping text', () => {
  assert.deepEqual(narrationChunks(''), []);
  const text = fixture(people(8)).solution, chunks = narrationChunks(text);
  assert.ok(chunks.length > 10); assert.ok(chunks.every(c => c.length <= 260));
  assert.equal(chunks.join(' '), text.replace(/\s+/g, ' ').trim());
});
function context(storage = new Map()) {
  const ctx = { sockets: [], storage: { get: async key => structuredClone(storage.get(key)), put: async (key, value) => storage.set(key, structuredClone(value)), setAlarm: async time => { ctx.alarmAt = time; }, deleteAll: async () => storage.clear() }, getWebSockets: () => ctx.sockets, blockConcurrencyWhile: fn => { ctx.ready = Promise.resolve().then(fn); } };
  return ctx;
}
function socket(auth = {}) { return { auth, messages: [], deserializeAttachment() { return this.auth; }, serializeAttachment(a) { this.auth = a; }, send(m) { this.messages.push(JSON.parse(m)); }, close() {} }; }
async function roomFixture(n = 4, env = {}) {
  const players = people(n).map(p => ({ ...p, lastSeen: Date.now() }));
  const storage = new Map([['room', { code: 'TEST', hostToken: 'host', phase: 'lobby', players, round: 0, revision: 0, answers: {}, votes: {}, questions: [], expiresAt: Date.now() + 86400000 }]]);
  const ctx = context(storage), room = new Room(ctx, env); await ctx.ready; return { room, ctx, storage };
}
test('room projections hide sealed evidence until its round, reconnect preserves unlocks, and reveal requires published clues', async () => {
  const { room, storage } = await roomFixture(); await room.advance(); await room.save();
  const m = room.room.mystery;
  assert.deepEqual(room.view({ host: true }).evidence, []);
  for (const c of m.characters) assert.deepEqual(room.view({ playerId: c.playerId }).role.clues, []);
  for (let round = 1; round <= 3; round++) {
    await room.advance(); await room.save();
    const host = room.view({ host: true }), visible = new Set(host.evidence.map(c => c.id));
    assert.equal(host.role, undefined);
    assert.equal(host.public.seed, undefined);
    for (const c of m.characters) {
      const own = room.view({ playerId: c.playerId });
      assert.ok(own.role.clues.every(clue => visible.has(clue.id)));
      for (const clue of c.clues.filter(clue => clue.unlockRound > round)) assert.ok(!JSON.stringify(own).includes(clue.text));
    }
    const ctx = context(storage), restored = new Room(ctx, {}); await ctx.ready;
    assert.deepEqual(restored.view({ playerId: 'p0' }), room.view({ playerId: 'p0' }));
    room.room.answers = Object.fromEntries(room.room.questions.map(q => [q.playerId, 'I will compare the new evidence.'])); await room.advance();
  }
  await room.advance();
  room.room.votes = Object.fromEntries(players.map(p => [p.id, p.id === 'p0' ? 'p1' : 'p0']));
  const published = room.room.shownClueIds; room.room.shownClueIds = [];
  await assert.rejects(room.advance(), /evidence must be shown/);
  room.room.shownClueIds = published; await room.advance();
  const hostSocket = socket({ host: true });
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: 'open-solution', id: 1 }));
  const reveal = room.view({ host: true });
  for (const [, id] of reveal.reveal.solution.matchAll(/\[(C\d+)\]/g)) assert.ok(published.includes(id));
});
test('solution opening is host-only, persisted and server-gated; phones receive compact details only after opening', async () => {
  const { room, storage } = await roomFixture();
  const host = socket({ host: true }), guest = socket({ playerId: 'p0' });
  await room.webSocketMessage(host, JSON.stringify({ type: 'open-solution', id: 1 }));
  assert.equal(host.messages.at(-1).ok, false);
  room.room.mystery = fixture(); room.room.phase = 'reveal'; room.room.round = 3;
  for (const auth of [{ host: true }, { playerId: 'p0' }]) {
    const view = room.view(auth);
    assert.equal(view.reveal.solution, undefined); assert.equal(view.reveal.why, undefined); assert.equal(view.reveal.details, undefined);
    assert.equal(view.reveal.caseFileOpen, false);
  }
  const text = narrationChunks(room.room.mystery.solution)[0];
  assert.equal((await room.tts(new Request('https://room/api/tts', { method: 'POST', body: JSON.stringify({ token: 'host', text }) }))).status, 400);
  await room.webSocketMessage(guest, JSON.stringify({ type: 'open-solution', id: 2 }));
  assert.equal(guest.messages.at(-1).ok, false); assert.equal(room.view({ playerId: 'p0' }).reveal.caseFileOpen, false);
  await room.webSocketMessage(host, JSON.stringify({ type: 'open-solution', id: 3 }));
  assert.equal(host.messages.at(-1).ok, true);
  const hostView = room.view({ host: true }), phone = room.view({ playerId: 'p0' });
  assert.ok(hostView.reveal.solution.includes(room.room.mystery.solution));
  assert.equal(phone.reveal.solution, undefined); assert.ok(phone.reveal.why.length < 300);
  assert.equal(phone.reveal.details.length, room.room.mystery.solutionClueIds.length);
  const ctx = context(storage), restored = new Room(ctx, {}); await ctx.ready;
  assert.deepEqual(restored.view({ playerId: 'p0' }).reveal, phone.reveal);
  await restored.advance(); assert.equal(restored.room.caseFileOpen, false);
});
test('the server preserves all 600 accepted statement characters and rejects overlong updates rather than trimming', async () => {
  const { room } = await roomFixture(); await room.advance(); await room.advance();
  const id = room.room.questions[0].playerId, ws = socket({ playerId: id }), text = 'x'.repeat(600);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'answer', text, id: 1 }));
  assert.equal(ws.messages.at(-1).ok, true); assert.equal(room.room.answers[id], text);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'answer', text: `${text}x`, id: 2 }));
  assert.equal(ws.messages.at(-1).ok, false); assert.match(ws.messages.at(-1).error, /1–600/);
  assert.equal(room.room.answers[id], text);
});
test('room status does not expose capabilities; interrupted preparation has a retry message', async () => {
  const missing = new Room(context(), {}); await missing.ctx.ready;
  assert.equal((await missing.fetch(new Request('https://room/status'))).status, 404);
  const { room, storage } = await roomFixture();
  assert.deepEqual(await (await room.fetch(new Request('https://room/status'))).json(), { exists: true });
  room.room.busy = true; await room.save();
  const ctx = context(storage), restored = new Room(ctx, {}); await ctx.ready;
  assert.equal(restored.room.busy, false); assert.match(restored.room.preparationNotice, /begin again/);
});
test('pre-upgrade rooms keep their original expiry and legacy private cards remain readable', async () => {
  const { room, storage } = await roomFixture();
  room.room.mystery = fixture(); room.room.mystery.characters.forEach(c => { c.clues = c.clues.map(clue => clue.text); delete c.shareableClueId; delete c.playerName; });
  delete room.room.expiresAt; await room.save();
  const ctx = context(storage), deadline = Date.now() + 60000; ctx.storage.getAlarm = async () => deadline;
  const restored = new Room(ctx, {}); await ctx.ready;
  assert.equal(restored.room.expiresAt, deadline);
  const view = restored.view({ playerId: 'p0' });
  assert.equal(view.role.playerName, players[0].name); assert.equal(view.role.clues[0].id, view.role.shareableClueId); assert.ok(view.role.clues[0].text);
  assert.equal(view.characters[0].playerName, players[0].name);
});
test('room rejects duplicate names case-insensitively but reconnect token recovers the existing seat', async () => {
  const { room, ctx } = await roomFixture();
  const ws = socket(); ctx.sockets.push(ws);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'join', name: '  gUEst 0  ', id: 1 }));
  assert.match(ws.messages.at(-1).error, /already on the guest list/); assert.equal(room.room.players.length, 4);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'join', token: 'token0', id: 2 }));
  assert.equal(ws.messages.at(-1).ok, true); assert.equal(room.room.players.length, 4);
});
test('presence expires silent sockets at six seconds, frees only lobby seats at fifteen, preserves active roles', async () => {
  const { room, ctx } = await roomFixture();
  const ws = socket({ playerId: 'p0', lastSeen: Date.now() }); ctx.sockets.push(ws);
  assert.equal(room.view({ host: true }).players[0].online, true);
  ws.auth.lastSeen -= 7000; room.room.players[0].lastSeen -= 7000;
  await room.alarm(); assert.equal(room.view({ host: true }).players[0].online, false);
  room.room.players[0].lastSeen -= 10000; ws.auth.lastSeen -= 10000;
  await room.alarm(); assert.equal(room.room.players.some(p => p.id === 'p0'), false);
  room.room.phase = 'intro'; room.room.players[0].lastSeen -= 20000;
  await room.alarm(); assert.equal(room.room.players.length, 3);
});
test('close broadcasts offline immediately, heartbeat restores it, and the room still expires after 24 hours', async () => {
  const { room, ctx, storage } = await roomFixture();
  const guest = socket({ playerId: 'p0', lastSeen: Date.now() }), host = socket({ host: true }); ctx.sockets.push(guest, host);
  await room.webSocketClose(guest, 1000, '');
  assert.equal(host.messages.filter(m => m.type === 'state').at(-1).state.players[0].online, false);
  guest.auth = { playerId: 'p0', lastSeen: Date.now() - 9000 };
  await room.webSocketMessage(guest, JSON.stringify({ type: 'ping', id: 1 }));
  assert.equal(room.online('p0'), true);
  room.room.expiresAt = Date.now() - 1; await room.alarm(); assert.equal(storage.size, 0);
});
test('reserved WebSocket close codes are never echoed onto the wire', async () => {
  for (const reserved of [1005, 1006, 1015]) {
    const { room, ctx } = await roomFixture(); const ws = socket({ playerId: 'p0', lastSeen: Date.now() }); ctx.sockets.push(ws);
    ws.close = code => assert.equal(code, 1000);
    await room.webSocketClose(ws, reserved, ''); assert.equal(room.online('p0'), false);
  }
});
test('3–8 player games finish with an exhausted AI allocation, including the last reaction and vote-aware reveal', async () => {
  for (let n = 3; n <= 8; n++) {
    let calls = 0; const { room } = await roomFixture(n, { AI: { run: async () => { calls++; throw new Error('429: 4006'); } } });
    await room.advance(); assert.equal(room.room.mystery.source, 'classic');
    const host = room.view({ host: true }); assert.equal(host.role, undefined); assert.ok(host.characters.every(c => c.secret === undefined));
    const own = room.view({ playerId: 'p0' }).role; assert.ok(own.clues.every(c => c.explanation === undefined && c.kind === undefined));
    for (let round = 1; round <= 3; round++) { await room.advance(); room.room.answers = Object.fromEntries(room.room.questions.map(q => [q.playerId, `My statement in round ${round}`])); await room.advance(); assert.equal(room.room.phase, 'reaction'); }
    await room.advance(); assert.equal(room.room.phase, 'voting');
    const killer = room.room.mystery.characters.find(c => c.killer).playerId;
    room.room.votes = Object.fromEntries(room.room.players.map(p => [p.id, p.id === killer ? room.room.players.find(p => p.id !== killer).id : killer]));
    await room.advance();
    await room.webSocketMessage(socket({ host: true }), JSON.stringify({ type: 'open-solution', id: 1 }));
    const reveal = room.view({ host: true }).reveal;
    assert.equal(reveal.killerWins, false); assert.match(reveal.solution, new RegExp(`${n - 1} of ${n} votes`)); assert.equal(calls, 1);
    await room.advance(); assert.equal(room.room.phase, 'lobby'); assert.equal(room.room.mystery, undefined);
  }
});
test('TTS accepts only current narration chunks, caches audio, and stops calling a failed voice service', async () => {
  let calls = 0;
  const { room } = await roomFixture(4, { AI: { run: async (model, input) => { calls++; assert.equal(model, '@cf/deepgram/aura-1'); assert.equal(input.speaker, 'orion'); return new Uint8Array(1024); } } });
  room.room.mystery = fixture(); room.room.phase = 'intro';
  const text = narrationChunks(room.room.mystery.intro)[0];
  const request = (token = 'host', value = text) => new Request('https://room/api/tts', { method: 'POST', body: JSON.stringify({ token, text: value }) });
  assert.equal((await room.tts(request('wrong'))).status, 403);
  assert.equal((await room.tts(request('host', 'arbitrary'))).status, 400);
  assert.equal((await room.tts(request('host', narrationChunks(room.room.mystery.solution)[0]))).status, 400);
  assert.equal((await room.tts(request())).headers.get('Content-Type'), 'audio/mpeg');
  assert.equal((await room.tts(request())).status, 200); assert.equal(calls, 1);
  room.audioCache.clear(); room.env.AI.run = async () => { calls++; throw new Error('429'); };
  assert.equal((await room.tts(request())).status, 503); assert.equal(calls, 2);
  assert.equal((await room.tts(request())).status, 503); assert.equal(calls, 2);
  for (const invalid of [{ error: 'rate limited' }, new Uint8Array(), new Response('Bad gateway', { status: 502 })]) {
    room.room.voiceUnavailable = false; room.env.AI.run = async () => invalid; assert.equal((await room.tts(request())).status, 503);
  }
  room.room.voiceUnavailable = false; room.room.mystery.quotaLimited = true;
  room.env.AI.run = () => { throw new Error('Quota guard failed'); };
  assert.equal((await room.tts(request())).status, 503);
});
