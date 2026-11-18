import test from 'node:test';
import assert from 'node:assert/strict';
import { cannedMystery, validateMystery, generateMystery, questions, reaction, isMock, withDeadline } from '../ai.js';
import { Room } from '../dist/worker.js';

const players = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `Guest ${i}` }));
test('mock cases validate for every supported player count', () => {
  for (let n = 3; n <= 8; n++) {
    const people = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Guest ${i}` }));
    assert.equal(cannedMystery(people).characters.length, n);
  }
  assert.equal(isMock({}), true); assert.equal(isMock({ AI: {}, MOCK_AI: '1' }), true);
});
test('rejects empty, duplicate, missing-player and multiple-killer mysteries', () => {
  assert.throws(() => validateMystery({}, players));
  for (const change of [m => { m.characters[1].killer = true; }, m => { m.characters[1].playerId = 'p0'; }, m => { m.characters.pop(); }, m => { m.characters[0].clues = []; }, m => { m.title = ''; }]) {
    const m = cannedMystery(players); change(m); assert.throws(() => validateMystery(m, players));
  }
});
test('AI retries once on malformed output and validates the successful retry', async () => {
  let calls = 0;
  const modelResult = { ...cannedMystery(players), killerPlayerId: 'p0' };
  const env = { AI: { run: async (_model, input) => {
    assert.equal(input.response_format.type, 'json_schema');
    assert.deepEqual(input.response_format.json_schema.properties.killerPlayerId.enum, players.map(p => p.id));
    return { response: ++calls === 1 ? '{}' : JSON.stringify(modelResult) };
  } } };
  assert.equal((await generateMystery(env, players)).characters.length, 4); assert.equal(calls, 2);
  calls = 0; env.AI.run = async () => { calls++; throw new Error('AI offline'); };
  await assert.rejects(generateMystery(env, players), /AI service could not complete/); assert.equal(calls, 2);
});
test('one authoritative killer identity overrides conflicting model flags', async () => {
  const result = { ...cannedMystery(players), killerPlayerId: 'p1' };
  Object.assign(result.characters[1], { motive: 'Inheritance', method: 'Poisoned port', tips: 'Deny entering the study' });
  result.characters.forEach(c => { c.killer = true; });
  const generated = await generateMystery({ AI: { run: async () => ({ response: result }) } }, players);
  assert.deepEqual(generated.characters.filter(c => c.killer).map(c => c.playerId), ['p1']);
});
test('missing or invalid killer identity falls back to one explicit flag or random assignment', async () => {
  for (const identity of [undefined, 'unknown']) for (const flagged of [true, false]) {
    const result = { ...cannedMystery(players), killerPlayerId: identity };
    if (!flagged) result.characters.forEach(c => { delete c.killer; delete c.motive; delete c.method; delete c.tips; });
    const generated = await generateMystery({ AI: { run: async () => ({ response: result }) } }, players);
    const killers = generated.characters.filter(c => c.killer); assert.equal(killers.length, 1);
    if (flagged) assert.equal(killers[0].playerId, 'p0');
    else { assert.ok(killers[0].motive); assert.ok(killers[0].method); assert.ok(killers[0].tips); assert.ok(generated.solution.includes(killers[0].name)); }
  }
});
test('missing players still fail after one retry', async () => {
  const result = { ...cannedMystery(players), killerPlayerId: 'p0' }; result.characters.pop(); let calls = 0;
  await assert.rejects(generateMystery({ AI: { run: async () => { calls++; return { response: result }; } } }, players)); assert.equal(calls, 2);
});
test('detective JSON schemas use small token budgets and reject malformed questions', async () => {
  const mystery = cannedMystery(players); let nextResponse = { questions: [{ playerId: 'p0', text: 'Where were you?' }, { playerId: 'p1', text: 'Who saw you?' }] };
  const env = { AI: { run: async (_model, input) => { assert.equal(input.response_format.type, 'json_schema'); assert.ok(input.max_tokens <= 700); return { response: nextResponse }; } } };
  assert.equal((await questions(env, mystery, 1)).length, 2);
  nextResponse = { questions: [{ playerId: 'missing', text: 'Where?' }] };
  await assert.rejects(questions(env, mystery, 1), /Invalid detective questions/);
  nextResponse = { text: 'Your story is convenient.' }; assert.equal(await reaction(env, mystery, {}), nextResponse.text);
});
test('model deadlines release callers instead of hanging the room indefinitely', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 5), /timed out/);
  assert.equal(await withDeadline(Promise.resolve('ready'), 5), 'ready');
});
test('model-added properties cannot smuggle other private cards into responses', () => {
  const m = cannedMystery(players); m.characters[0].otherSecrets = 'PRIVATE'; m.rawMystery = 'PRIVATE';
  const clean = validateMystery(m, players);
  assert.equal(clean.rawMystery, undefined); assert.equal(clean.characters[0].otherSecrets, undefined);
});
function context(storage) {
  const ctx = { storage: { get: async key => structuredClone(storage.get(key)), put: async (key, value) => storage.set(key, structuredClone(value)) }, getWebSockets: () => [], blockConcurrencyWhile: fn => { ctx.ready = Promise.resolve().then(fn); } };
  return ctx;
}
test('room status reports missing rooms without exposing existing room capabilities', async () => {
  for (const exists of [false, true]) {
    const ctx = context(new Map(exists ? [['room', { hostToken: 'private-host', players: [] }]] : []));
    const room = new Room(ctx, {}); await ctx.ready;
    const response = await room.fetch(new Request('https://room/status'));
    assert.equal(response.status, exists ? 200 : 404);
    if (exists) assert.deepEqual(await response.json(), { exists: true });
  }
});
test('Durable Object reload retains private role and clears interrupted busy flag', async () => {
  const storage = new Map([['room', { code: 'TEST', phase: 'intro', players, mystery: cannedMystery(players), busy: true }]]);
  const ctx = context(storage); const room = new Room(ctx, {}); await ctx.ready;
  assert.equal(room.room.busy, false); assert.equal(room.room.phase, 'intro');
  assert.equal(room.room.mystery.characters[0].secret, cannedMystery(players).characters[0].secret);
  assert.equal(storage.get('room').busy, false);
});
test('Workers AI TTS returns audio, caches text, rejects errors and invalid auth', async () => {
  const mystery = cannedMystery(players);
  const storage = new Map([['room', { code: 'TEST', hostToken: 'host', phase: 'intro', players, mystery, answers: {}, votes: {}, questions: [] }]]);
  let calls = 0;
  const ctx = context(storage); const room = new Room(ctx, { AI: { run: async (model, input) => { calls++; assert.equal(model, '@cf/deepgram/aura-1'); assert.equal(input.speaker, 'orion'); return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)); controller.close(); } }); } } }); await ctx.ready;
  const request = (token = 'host', text = mystery.intro) => new Request('https://room/api/tts', { method: 'POST', body: JSON.stringify({ token, text }) });
  assert.equal((await room.tts(request('wrong'))).status, 403);
  assert.equal((await room.tts(request('host', 'arbitrary'))).status, 400);
  assert.equal((await room.tts(request())).headers.get('Content-Type'), 'audio/mpeg');
  assert.equal((await room.tts(request())).status, 200); assert.equal(calls, 1);
  room.audioCache.clear(); room.env.AI.run = async () => { throw new Error('429'); };
  assert.equal((await room.tts(request())).status, 503);
  for (const invalid of [{ error: 'rate limited' }, new Uint8Array(), new Response('Bad gateway', { status: 502 })]) {
    room.env.AI.run = async () => invalid;
    assert.equal((await room.tts(request())).status, 503);
  }
});
