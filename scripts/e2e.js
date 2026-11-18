import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
const clients = [];
async function client(code) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/room/${code}/ws`);
  const c = { ws, messages: [], state: null, sequence: 0, pending: new Map() }; clients.push(c);
  ws.on('message', bytes => {
    const message = JSON.parse(bytes); c.messages.push(message);
    if (message.type === 'state') c.state = message.state;
    if (message.type === 'ack') { c.pending.get(message.id)?.(message); c.pending.delete(message.id); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  c.send = (type, data = {}) => new Promise((resolve, reject) => {
    const id = ++c.sequence;
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${type}`)), 30000);
    c.pending.set(id, result => { clearTimeout(timeout); resolve(result); });
    ws.send(JSON.stringify({ id, type, ...data }));
  });
  c.ok = async (type, data) => { const result = await c.send(type, data); assert.equal(result.ok, true, result.error); return result; };
  c.waitFor = predicate => new Promise((resolve, reject) => {
    const done = () => { if (predicate(c.state)) { clearTimeout(timer); ws.off('message', done); resolve(); } };
    const timer = setTimeout(() => { ws.off('message', done); reject(new Error('Timed out waiting for player state')); }, 30000);
    ws.on('message', done); done();
  });
  c.heartbeat = setInterval(() => { if (c.state && ws.readyState === WebSocket.OPEN) c.send('ping').catch(() => {}); }, 2000);
  return c;
}
const next = c => c.ok('next', { revision: c.state.revision });
function privacy(host, players) {
  const forbidden = ['secret', 'alibi', 'clues', 'personality', 'relationship', 'tips', 'method', 'motive', 'killer'];
  assert.equal(host.state.role, undefined);
  for (const character of host.state.characters) for (const key of forbidden) assert.equal(character[key], undefined);
  assert.equal(host.state.reveal, undefined);
  for (const p of players) {
    assert.equal(p.state.role.playerId, p.state.me);
    for (const character of p.state.characters) for (const key of forbidden) assert.equal(character[key], undefined);
    assert.equal(p.state.reveal, undefined);
    assert.equal(JSON.stringify(p.state).includes('hostToken'), false);
  }
}
try {
  const health = await (await fetch(`${base}/health`)).json(); assert.equal(health.mock, true, 'E2E must use MOCK_AI=1');
  const page = await (await fetch(base)).text(); assert.ok(page.includes('Dead of Night')); assert.ok(!page.includes('__APP__'));
  const invitation = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json(); assert.match(invitation.code, /^[A-Z]{4}$/);
  let host = await client(invitation.code); await host.ok('host', { token: invitation.token });
  assert.equal((await host.send('next', { revision: 0 })).ok, false, 'Cannot start without enough players');
  const intruder = await client(invitation.code);
  assert.equal((await intruder.send('host', { token: 'invalid' })).ok, false);
  assert.equal(intruder.state, null, 'Unauthenticated socket gets no game state');
  assert.equal((await intruder.send('join', { name: '' })).ok, false);
  let players = [];
  for (const name of ['Ada', 'Basil', 'Cleo', 'Dorian']) {
    const p = await client(invitation.code); p.identity = await p.ok('join', { name }); players.push(p);
  }
  assert.equal(host.state.players.length, 4);
  assert.equal((await intruder.send('join', { name: '  aDA  ' })).ok, false, 'Duplicate names are rejected case-insensitively');
  assert.equal((await players[0].send('next', { revision: 0 })).ok, false);
  console.log('PASS lobby: 4 players, room code, auth, empty-name and minimum-player guards');
  const started = Date.now(); await next(host); console.log(`Mock case ready in ${Date.now() - started} ms`); assert.equal(host.state.phase, 'intro'); privacy(host, players);
  assert.equal(players.filter(p => p.state.role.killer).length, 1);
  assert.deepEqual(host.state.evidence, []);
  assert.ok(players.every(p => p.state.role.clues.length === 0), 'Intro role cards keep all evidence sealed');
  assert.equal((await intruder.send('join', { name: 'Late' })).ok, false);
  const roleBefore = players[0].state.role;
  players[0].ws.close(); const rejoined = await client(invitation.code); rejoined.identity = players[0].identity;
  await rejoined.ok('join', { token: rejoined.identity.token }); players[0] = rejoined;
  assert.deepEqual(players[0].state.role, roleBefore);
  host.ws.close(); host = await client(invitation.code); await host.ok('host', { token: invitation.token });
  assert.equal(host.state.phase, 'intro'); privacy(host, players);
  const tts = await fetch(`${base}/api/tts?code=${invitation.code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid', text: 'anything' }) }); assert.equal(tts.status, 403);
  const mockTts = await fetch(`${base}/api/tts?code=${invitation.code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitation.token, text: host.state.public.intro }) }); assert.equal(mockTts.status, 503);
  console.log('PASS roles: exactly one killer, per-socket privacy, host/player refresh, late-join guard, TTS auth/fallback');
  async function rounds() {
    const asked = [], counts = Object.fromEntries(players.map(p => [p.state.me, 0])), published = new Map();
    for (let round = 1; round <= 3; round++) {
      await next(host); assert.equal(host.state.phase, 'questions'); assert.equal(host.state.round, round);
      const fresh = host.state.evidence.filter(clue => clue.unlockRound === round);
      assert.ok(fresh.length > 0, 'Every round publishes fresh evidence');
      for (const clue of host.state.evidence) { assert.ok(clue.unlockRound <= round); published.set(clue.id, clue.text); }
      for (const p of players) {
        assert.ok(p.state.role.clues.every(clue => clue.unlockRound <= round && published.get(clue.id) === clue.text));
        if (round === 1) assert.equal(p.state.role.clues.length, 1, 'Only an ambiguous lead is released initially');
      }
      assert.equal((await host.send('next', { revision: host.state.revision })).ok, false, 'Missing answers block advancement');
      for (const q of host.state.questions) {
        asked.push(q.text); counts[q.playerId]++;
        const p = players.find(p => p.state.me === q.playerId); assert.ok(p);
        assert.ok(p.state.role.clues.some(clue => q.text.includes(clue.id)), 'Questions cite only unlocked private clues');
        assert.equal((await p.send('answer', { text: '' })).ok, false);
        await p.ok('answer', { text: 'I was in the conservatory. Ask the others.' });
      }
      privacy(host, players); await next(host); assert.equal(host.state.phase, 'reaction'); assert.ok(host.state.reaction);
    }
    assert.equal(new Set(asked).size, 9, 'Questions never repeat');
    assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1, 'Questioning is balanced');
    await next(host); assert.equal(host.state.phase, 'voting');
    assert.ok(players.every(p => p.state.role.lockedClues === 0), 'All evidence is available before voting');
    return published;
  }
  const published = await rounds(); console.log('PASS detective: all 3 rounds, 3 questions per round, answers, reactions and transition guards');
  assert.equal((await players[0].send('vote', { playerId: players[0].state.me })).ok, false);
  assert.equal((await players[0].send('vote', { playerId: 'missing' })).ok, false);
  assert.equal((await host.send('next', { revision: host.state.revision })).ok, false);
  const killer = players.find(p => p.state.role.killer);
  for (const p of players) await p.ok('vote', { playerId: p === killer ? players.find(other => other !== killer).state.me : killer.state.me });
  privacy(host, players); assert.equal(host.state.votesCast, 4); await next(host);
  assert.equal(host.state.reveal.solution, undefined);
  assert.ok(players.every(p => p.state.reveal.solution === undefined && p.state.reveal.details === undefined && p.state.reveal.why === undefined));
  assert.equal((await players[0].send('open-solution')).ok, false, 'Guests cannot open the case file');
  await host.ok('open-solution');
  await Promise.all(players.map(p => p.waitFor(state => state?.reveal?.caseFileOpen)));
  assert.ok(players.every(p => p.state.reveal.caseFileOpen && p.state.reveal.why && p.state.reveal.details.length && p.state.reveal.solution === undefined));
  assert.equal(host.state.phase, 'reveal'); assert.equal(host.state.reveal.killerWins, false); assert.equal(host.state.reveal.tally[killer.state.me], 3); assert.ok(host.state.reveal.solution);
  for (const [, id] of host.state.reveal.solution.matchAll(/\[(C\d+)\]/g)) assert.ok(published.has(id) && host.state.reveal.solution.includes(published.get(id)), 'Reveal cites only evidence published before voting');
  console.log('PASS evidence pacing: sealed intro, fresh clues in each round, no early question leaks, every reveal citation published');
  console.log('PASS reveal pacing: host-only case-file opening, server withholds explanation, compact phone details after opening');
  console.log('PASS voting/reveal: no self/invalid votes, secret progress, 3–1 majority catches killer, narrated solution present');
  if (process.env.MYSTERY_ARTIFACT) await writeFile(process.env.MYSTERY_ARTIFACT, JSON.stringify({ source: 'mock (live check cancelled: AI quota exhausted)', public: host.state.public, characters: players.map(p => p.state.role), reveal: host.state.reveal }, null, 2));
  await next(host); assert.equal(host.state.phase, 'lobby'); assert.equal(host.state.players.length, 4); assert.equal(players[0].state.role, undefined);
  await next(host); await rounds();
  // Two votes for the killer is a tie, not an absolute majority.
  const ids = players.map(p => p.state.me);
  for (let i = 0; i < 4; i++) await players[i].ok('vote', { playerId: i < 2 ? ids[2] : ids[0] });
  await next(host); assert.equal(host.state.reveal.killerWins, true);
  console.log('PASS replay: same players, cleared roles/votes, second full game, 2–2 split lets killer escape');
  const large = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
  host = await client(large.code); await host.ok('host', { token: large.token }); players = [];
  for (let i = 0; i < 8; i++) { const p = await client(large.code); p.identity = await p.ok('join', { name: `Suspect ${i + 1}` }); players.push(p); }
  await next(host); await rounds();
  const culprit = players.find(p => p.state.role.killer);
  for (const p of players) await p.ok('vote', { playerId: p === culprit ? players.find(o => o !== culprit).state.me : culprit.state.me });
  await next(host); assert.equal(host.state.phase, 'reveal'); assert.equal(host.state.reveal.killerWins, false);
  console.log('PASS eight guests: nine unique balanced questions, final reaction, voting and reveal complete without AI');
  console.log('E2E PASS — lobby → private roles → 3 rounds → voting → reveal → replay (mock Workers AI)');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { for (const c of clients) { clearInterval(c.heartbeat); c.ws.terminate(); } }
