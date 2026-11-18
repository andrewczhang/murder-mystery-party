import test from 'node:test';
import assert from 'node:assert/strict';
import { cannedMystery, validateMystery, generateMystery, isMock } from '../ai.js';
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
  const env = { AI: { run: async () => ({ response: ++calls === 1 ? '{}' : JSON.stringify(cannedMystery(players)) }) } };
  assert.equal((await generateMystery(env, players)).characters.length, 4); assert.equal(calls, 2);
  calls = 0; env.AI.run = async () => { calls++; throw new Error('AI offline'); };
  await assert.rejects(generateMystery(env, players), /AI service could not complete/); assert.equal(calls, 2);
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
  const ctx = context(storage); const room = new Room(ctx, { AI: { run: async (model, input) => { calls++; assert.equal(model, '@cf/deepgram/aura-1'); assert.equal(input.speaker, 'orion'); return new Uint8Array([1, 2, 3]); } } }); await ctx.ready;
  const request = (token = 'host', text = mystery.intro) => new Request('https://room/api/tts', { method: 'POST', body: JSON.stringify({ token, text }) });
  assert.equal((await room.tts(request('wrong'))).status, 403);
  assert.equal((await room.tts(request('host', 'arbitrary'))).status, 400);
  assert.equal((await room.tts(request())).headers.get('Content-Type'), 'audio/mpeg');
  assert.equal((await room.tts(request())).status, 200); assert.equal(calls, 1);
  room.audioCache.clear(); room.env.AI.run = async () => { throw new Error('429'); };
  assert.equal((await room.tts(request())).status, 503);
});
