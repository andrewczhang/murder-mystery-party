import page from './public/index.html';
import { isMock, generateMystery, questions, reaction, withDeadline } from './ai.js';

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fresh = () => ({ phase: 'lobby', players: [], round: 0, answers: {}, votes: {}, questions: [], revision: 0 });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return reply({ ok: true, mock: isMock(env) });
    const statusCode = url.pathname.match(/^\/api\/rooms\/([A-Z]{4})$/);
    if (statusCode && request.method === 'GET') return env.ROOMS.get(env.ROOMS.idFromName(statusCode[1])).fetch(new Request('https://room/status'));
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let i = 0; i < 5; i++) {
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        const code = [...bytes].map(b => String.fromCharCode(65 + b % 26)).join('');
        const response = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(`https://room/create?code=${code}`, { method: 'POST' }));
        if (response.status !== 409) return response;
      }
      return reply({ error: 'Please try again.' }, 503);
    }
    const match = url.pathname.match(/^\/api\/room\/([A-Z]{4})\/(ws|tts)$/);
    if (match) {
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: 'Invalid origin' }, 403);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname === '/api/tts' && request.method === 'POST') {
      const code = url.searchParams.get('code') || '';
      if (!/^[A-Z]{4}$/.test(code)) return reply({ error: 'Invalid room' }, 400);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: 'Invalid origin' }, 403);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    if (url.pathname === '/' || url.pathname === '/join') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
    return new Response('Not found', { status: 404 });
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.audioCache = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get('room');
      if (this.room?.busy) { this.room.busy = false; await ctx.storage.put('room', this.room); }
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') {
      if (this.room) return reply({ error: 'Already exists' }, 409);
      this.room = { ...fresh(), code: url.searchParams.get('code'), hostToken: crypto.randomUUID() };
      await this.ctx.storage.put('room', this.room);
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      return reply({ code: this.room.code, token: this.room.hostToken });
    }
    if (!this.room) return reply({ error: 'Room not found or expired.' }, 404);
    if (url.pathname === '/status') return reply({ exists: true });
    if (url.pathname.endsWith('/tts')) return this.tts(request);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 40) return new Response('Room connection limit reached', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({});
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  view(auth) {
    const r = this.room, m = r.mystery;
    const data = { code: r.code, phase: r.phase, round: r.round, busy: !!r.busy, revision: r.revision, mock: isMock(this.env), players: r.players.map(p => ({ id: p.id, name: p.name, online: this.ctx.getWebSockets().some(ws => ws.deserializeAttachment()?.playerId === p.id) })), public: m && { title: m.title, setting: m.setting, victim: m.victim, causeOfDeath: m.causeOfDeath, timeOfDeath: m.timeOfDeath, intro: m.intro }, characters: m?.characters.map(c => ({ playerId: c.playerId, name: c.name, role: c.role })), questions: r.questions, answered: Object.keys(r.answers), reaction: r.reaction, votesCast: Object.keys(r.votes).length };
    if (auth.playerId) { data.me = auth.playerId; data.role = m?.characters.find(c => c.playerId === auth.playerId); data.myAnswer = r.answers[auth.playerId]; data.myVote = r.votes[auth.playerId]; }
    if (r.phase === 'reveal') {
      const tally = Object.fromEntries(r.players.map(p => [p.id, Object.values(r.votes).filter(id => id === p.id).length]));
      const killer = m.characters.find(c => c.killer);
      data.reveal = { killer: killer.name, killerId: killer.playerId, solution: m.solution, tally, killerWins: tally[killer.playerId] <= r.players.length / 2 };
    }
    return data;
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const auth = ws.deserializeAttachment();
      if (auth?.host || auth?.playerId) { try { ws.send(JSON.stringify({ type: 'state', state: this.view(auth) })); } catch { /* Socket may have closed. */ } }
    }
  }
  async save() { await this.ctx.storage.put('room', this.room); this.broadcast(); }
  async webSocketMessage(ws, message) {
    let id;
    try {
      if (typeof message !== 'string' || message.length > 4000) throw new Error('Message too large.');
      const data = JSON.parse(message); id = data.id;
      const r = this.room, auth = ws.deserializeAttachment() || {};
      if (!r) throw new Error('Room expired. Create another game.');
      let result = {};
      if (data.type === 'host') {
        if (data.token !== r.hostToken) throw new Error('Host session expired.');
        ws.serializeAttachment({ host: true }); this.broadcast();
      } else if (data.type === 'join') {
        let player = r.players.find(p => p.token === data.token);
        if (!player) {
          if (r.phase !== 'lobby' || r.busy) throw new Error('This game has already started.');
          if (r.players.length >= 8) throw new Error('Room is full (8 players).');
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!name || name.length > 24) throw new Error('Use a name of 1–24 characters.');
          player = { id: crypto.randomUUID(), token: crypto.randomUUID(), name }; r.players.push(player);
        }
        ws.serializeAttachment({ playerId: player.id }); result = { token: player.token, code: r.code };
        await this.save();
      } else if (data.type === 'next') {
        if (!auth.host) throw new Error('Only the host can advance the game.');
        if (r.busy) throw new Error('The detective is thinking.');
        if (data.revision !== r.revision) throw new Error('The scene has changed. Try again.');
        r.busy = true; await this.save();
        try { await this.advance(); r.revision++; }
        finally { r.busy = false; await this.save(); }
      } else if (data.type === 'answer') {
        if (!auth.playerId || r.phase !== 'questions' || r.busy || !r.questions.some(q => q.playerId === auth.playerId)) throw new Error('No question for you right now.');
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 600) throw new Error('Answer in 1–600 characters.');
        r.answers[auth.playerId] = data.text.trim(); await this.save();
      } else if (data.type === 'vote') {
        if (!auth.playerId || r.phase !== 'voting' || r.busy || auth.playerId === data.playerId || !r.players.some(p => p.id === data.playerId)) throw new Error('Choose another character during voting.');
        r.votes[auth.playerId] = data.playerId; await this.save();
      } else throw new Error('Unknown action.');
      ws.send(JSON.stringify({ type: 'ack', id, ok: true, ...result }));
    } catch (e) { ws.send(JSON.stringify({ type: 'ack', id, ok: false, error: e.message || 'Please try again.' })); }
  }
  async advance() {
    const r = this.room;
    if (r.phase === 'lobby') {
      if (r.players.length < 3) throw new Error('You need 3–8 players.');
      r.mystery = await generateMystery(this.env, r.players.map(({ id, name }) => ({ id, name }))); r.phase = 'intro';
    } else if (r.phase === 'intro' || (r.phase === 'reaction' && r.round < 3)) {
      const qs = await questions(this.env, r.mystery, r.round + 1);
      r.round++; r.questions = qs; r.answers = {}; r.phase = 'questions';
    } else if (r.phase === 'questions') {
      if (r.questions.some(q => !r.answers[q.playerId])) throw new Error('Wait for the questioned players to submit answers.');
      r.reaction = await reaction(this.env, r.mystery, r.answers); r.phase = 'reaction';
    } else if (r.phase === 'reaction') { r.phase = 'voting'; r.questions = []; }
    else if (r.phase === 'voting') {
      if (Object.keys(r.votes).length !== r.players.length) throw new Error('Wait for every vote.');
      r.phase = 'reveal';
    } else if (r.phase === 'reveal') {
      Object.assign(r, { phase: 'lobby', mystery: undefined, round: 0, questions: [], answers: {}, votes: {}, reaction: '' });
    }
  }
  async tts(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (Number(request.headers.get('Content-Length')) > 20000) return new Response('Too large', { status: 413 });
    let data;
    try { data = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (data.token !== this.room.hostToken) return new Response('Forbidden', { status: 403 });
    const state = this.view({ host: true });
    const allowed = [state.public?.intro, state.reaction, state.reveal?.solution, state.questions.map(q => q.text).join(' ')].filter(Boolean);
    if (typeof data.text !== 'string' || !allowed.includes(data.text) || data.text.length > 10000) return new Response('Invalid narration', { status: 400 });
    if (isMock(this.env)) return new Response('Use browser voice', { status: 503 });
    if (this.audioCache.has(data.text)) return new Response(this.audioCache.get(data.text), { headers: { 'Content-Type': 'audio/mpeg' } });
    if (this.speaking) return new Response('Please use browser voice', { status: 429 });
    this.speaking = true;
    try {
      const bytes = await withDeadline((async () => {
        const audio = await this.env.AI.run('@cf/deepgram/aura-1', { text: data.text, speaker: 'orion', encoding: 'mp3' });
        if (audio instanceof Response) {
          if (!audio.ok || !audio.headers.get('Content-Type')?.startsWith('audio/')) throw new Error('Invalid audio response');
          return audio.arrayBuffer();
        }
        if (!(audio instanceof ReadableStream) && !(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) throw new Error('Invalid audio response');
        return new Response(audio).arrayBuffer();
      })(), 25000);
      if (bytes.byteLength < 128) throw new Error('Empty or invalid audio');
      if (this.audioCache.size >= 12) this.audioCache.delete(this.audioCache.keys().next().value);
      this.audioCache.set(data.text, bytes);
      return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    } catch { return new Response('Use browser voice', { status: 503 }); }
    finally { this.speaking = false; }
  }
  webSocketClose(ws, code, reason) { ws.close(code, reason); this.broadcast(); }
  webSocketError(ws) { ws.close(1011, 'Reconnect'); }
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'Room expired after 24 hours');
    await this.ctx.storage.deleteAll(); this.room = undefined;
  }
}
