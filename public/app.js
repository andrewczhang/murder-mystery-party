import QRCode from 'qrcode';
import { narrationChunks } from './narration.js';

const app = document.querySelector('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const queryCode = new URLSearchParams(location.search).get('code')?.toUpperCase() || '';
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Storage is unavailable. Keep this tab open to retain your role.'); } }
};
let session, ws, state, joinMode = location.pathname === '/join', sound = true, speechKey = '', revealed = false, reconnectTimer, heartbeatTimer, heartbeatPending = false, toastTimer, audio, audioUrl, voiceGeneration = 0, draft = '', draftRound = 0, currentUtterance, cancelPlayback, voiceStatus = '', serverVoiceFailed = false;
const pending = new Map();
let sequence = 0;
function toast(message) { const box = document.querySelector('#toast'); box.textContent = message; box.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('visible'), 6500); }
function request(type, data = {}) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Connection lost. Reconnecting…'));
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Still waiting for the detective. Reconnect if needed.')); }, 150000);
    pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, type, ...data }));
  });
}
function saveSession() { store.set(session.host ? 'dn-host' : `dn-player-${session.code}`, session); }
function forgetSession(message) {
  if (session) store.remove(session.host ? 'dn-host' : `dn-player-${session.code}`);
  clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); session = null; state = null; speechKey = ''; stopVoice();
  document.querySelector('#connection').textContent = 'AN EVENING OF ALIBIS';
  render(); toast(message);
}
function interruptPending() {
  for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(Object.assign(new Error('Connection interrupted. Reconnecting…'), { interrupted: true })); }
  pending.clear();
}
function reconnectStalled(connection) {
  if (connection !== ws || !session) return;
  interruptPending(); connection.close(); connect();
}
function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  document.querySelector('#connection').textContent = 'CONNECTING TO THE CASE';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/room/${session.code}/ws`);
  ws.addEventListener('open', async () => {
    try {
      const result = await request(session.host ? 'host' : 'join', { token: session.token, name: session.name });
      if (result.token) {
        session.token = result.token; saveSession();
        if (!session.host) history.replaceState(null, '', `/join?code=${session.code}`);
      }
      document.querySelector('#connection').textContent = `LIVE · ROOM ${session.code}`;
      heartbeatPending = false;
      heartbeatTimer = setInterval(async () => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        const connection = ws;
        const watchdog = setTimeout(() => reconnectStalled(connection), 5000);
        try { await request('ping'); } catch { if (connection === ws) reconnectStalled(connection); }
        finally { clearTimeout(watchdog); heartbeatPending = false; }
      }, 2000);
    } catch (e) { if (e.interrupted) return; forgetSession(e.message); ws.close(); }
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'ack') {
      const entry = pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timeout); pending.delete(message.id);
      if (message.ok) entry.resolve(message); else entry.reject(new Error(message.error));
    } else if (message.type === 'state') {
      const sceneChanged = state?.phase !== message.state.phase || state?.round !== message.state.round;
      state = message.state;
      if (draftRound !== state.round) { draftRound = state.round; draft = ''; }
      if (state.phase === 'lobby') revealed = false;
      render(); if (sceneChanged) window.scrollTo(0, 0); autoNarrate();
    }
  });
  const connection = ws;
  ws.addEventListener('close', async event => {
    if (connection !== ws) return;
    clearInterval(heartbeatTimer);
    interruptPending();
    if (!session) return;
    document.querySelector('#connection').textContent = 'DISCONNECTED · RECONNECTING';
    if (event.reason.includes('expired')) return forgetSession('This room has expired. Start or join another game.');
    try {
      const response = await fetch(`/api/rooms/${session.code}`, { signal: AbortSignal.timeout(8000) });
      if (connection !== ws || !session) return;
      if (response.status === 404) return forgetSession('Room not found or expired. Check the code or start a new game.');
    } catch { /* Retry after transient network failures. */ }
    if (connection === ws && session) reconnectTimer = setTimeout(connect, 1800);
  });
  ws.addEventListener('error', () => toast('Cannot reach the case. Reconnecting automatically…'));
}
window.addEventListener('online', () => { if (session && ws?.readyState !== WebSocket.OPEN) connect(); });
function stopVoice() { voiceGeneration++; cancelPlayback?.(); cancelPlayback = null; if (audio) { audio.pause(); audio = null; } if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; } window.speechSynthesis?.cancel(); currentUtterance = null; }
function narration() {
  if (!state) return '';
  if (state.phase === 'intro') return state.public.intro;
  if (state.phase === 'questions') return state.questions.map(q => q.text).join(' ');
  if (state.phase === 'reaction') return state.reaction;
  if (state.phase === 'reveal' && (revealed || !session.host)) return state.reveal.solution;
  return '';
}
function setVoiceStatus(message) { voiceStatus = message; const label = document.querySelector('#voice-status'); if (label) label.textContent = message; }
async function browserVoice(text, generation) {
  const engine = window.speechSynthesis;
  if (!engine) throw new Error('No browser voice');
  if (!engine.getVoices().length) await new Promise(resolve => {
    const done = () => { clearTimeout(timer); engine.removeEventListener('voiceschanged', done); resolve(); };
    const timer = setTimeout(done, 1000); engine.addEventListener('voiceschanged', done);
  });
  if (generation !== voiceGeneration) return;
  await new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text); currentUtterance = utterance;
    utterance.voice = engine.getVoices().find(v => v.localService && /^en/i.test(v.lang)) || engine.getVoices().find(v => /^en/i.test(v.lang)) || null;
    utterance.rate = .9; utterance.pitch = .8;
    const timer = setTimeout(() => { engine.cancel(); reject(new Error('Browser voice timed out')); }, 45000);
    const finish = error => { clearTimeout(timer); cancelPlayback = null; if (currentUtterance === utterance) currentUtterance = null; error ? reject(error) : resolve(); };
    cancelPlayback = () => finish(); utterance.onend = () => finish(); utterance.onerror = event => finish(new Error(event.error));
    engine.resume(); engine.speak(utterance);
  });
}
async function speak(text) {
  stopVoice(); const generation = voiceGeneration;
  if (!text || !sound) return;
  let browserOnly = state.mock || !session.host || serverVoiceFailed;
  try {
    for (const chunk of narrationChunks(text)) {
      if (generation !== voiceGeneration) return;
      if (!browserOnly) {
        try {
          setVoiceStatus('Narration · preparing voice…');
          const response = await fetch(`/api/tts?code=${session.code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.token, text: chunk }), signal: AbortSignal.timeout(15000) });
          if (!response.ok || !response.headers.get('Content-Type')?.startsWith('audio/')) throw new Error('Browser fallback');
          const blob = await response.blob(); if (blob.size < 128) throw new Error('Empty audio');
          if (generation !== voiceGeneration) return;
          audioUrl = URL.createObjectURL(blob); audio = new Audio(audioUrl);
          setVoiceStatus('Narration · playing');
          await new Promise((resolve, reject) => { cancelPlayback = resolve; audio.onended = resolve; audio.onerror = reject; audio.play().catch(reject); });
          cancelPlayback = null; audio = null; URL.revokeObjectURL(audioUrl); audioUrl = null;
          continue;
        } catch { if (generation !== voiceGeneration) return; browserOnly = true; serverVoiceFailed = true; }
      }
      if (generation !== voiceGeneration) return;
      setVoiceStatus('Narration · device voice');
      await browserVoice(chunk, generation);
    }
    if (generation === voiceGeneration) setVoiceStatus('Narration finished');
  } catch { if (generation === voiceGeneration) setVoiceStatus('This device could not play its voice. Read along below, or try another browser with a speech voice installed.'); }
}
function autoNarrate() {
  if (!session?.host || !state) return;
  const key = `${state.phase}-${state.round}-${revealed}`;
  if (key === speechKey) return; speechKey = key;
  speak(narration());
}
const detective = () => '<div class="detective"><span class="detective-icon">M</span><div><span class="eyebrow" style="margin:0">YOUR DETECTIVE</span><p>Inspector August Marlowe · No detail escapes him.</p></div></div>';
function playerList() { return `<ul class="players">${state.players.map((p, i) => `<li><span class="avatar">${String(i + 1).padStart(2, '0')}</span><span>${esc(p.name)}</span><span class="small ${p.online ? 'dot' : ''}">${p.online ? '● Ready' : '○ Offline'}</span></li>`).join('') || '<li class="small">The guest list is waiting for its first suspect.</li>'}</ul>`; }
const classicNote = () => state.source === 'classic' ? '<p class="status small" role="status">Classic case · The AI writer is unavailable. Your complete, evidence-checked case is ready to play. No retry needed.</p>' : '';
const progress = () => state.busy ? '<div class="status writing" role="status"><p class="eyebrow">THE DETECTIVE IS WRITING THE CASE…</p><p>Usually ready within 25 seconds. A classic case is standing by if the AI is unavailable.</p><p class="small">While you wait: choose a character voice. Read your clue aloud when it arrives, but keep your secret private.</p></div>' : state.preparationNotice ? `<p class="status" role="status">${esc(state.preparationNotice)}</p>` : '';
const voiceControls = () => `<p id="voice-status" class="small" role="status">${esc(voiceStatus)}</p>`;
function landing() {
  return `<div class="hero fade"><section><p class="eyebrow">AN AI MURDER MYSTERY PARTY</p><h1>A perfect night.<br>A <em>perfect crime.</em></h1><p class="lead">Gather your friends. Step into character. Uncover a killer hiding in plain sight.</p><p class="lead">One of you did it. All of you have secrets.</p><div class="actions"><button class="btn" id="host">Host a game <span aria-hidden="true">↗</span></button><button class="btn secondary" id="show-join">Join a room</button></div><p class="small">No downloads. No scripts. Just a very good alibi.</p><div class="meta"><span>3–8 PLAYERS</span><span>20–40 MINUTES</span><span>ONE SHARED SCREEN</span></div></section><div class="scene" aria-label="A moonlit manor in the rain"><span class="scene-stamp">THE NIGHT IS YOUNG. SOMEONE ISN’T.</span><div class="moon"></div><div class="manor"></div><div class="windows"></div><span class="case-tag">CASE FILE / 001</span><div class="scene-line"><span>BLACKTHORN MANOR</span><span>11:45 PM</span></div></div></div><section class="how"><div><strong><span>01</span>Assemble the suspects</strong><p>Put the host screen on a TV. Everyone joins on their phone.</p></div><div><strong><span>02</span>Keep your secrets close</strong><p>A fresh case. A private character. A detective asking questions.</p></div><div><strong><span>03</span>Make your accusation</strong><p>Trade clues, expose the lies, and cast your vote. Choose wisely.</p></div></section>`;
}
function joinForm() {
  return `<section class="narrow panel fade"><p class="eyebrow">YOUR INVITATION AWAITS</p><h2>Enter the manor.</h2><p class="small">Your host has a four-letter room code. Your secrets will stay on this phone.</p><form id="join-form"><div class="form-row"><label for="join-code">Room code</label><input id="join-code" name="code" value="${esc(queryCode)}" maxlength="4" minlength="4" pattern="[A-Za-z]{4}" placeholder="ABCD" required autocomplete="off" autocapitalize="characters"></div><div class="form-row"><label for="join-name">Your name</label><input id="join-name" name="name" maxlength="24" placeholder="What should we call you?" required autocomplete="given-name"></div><button class="btn wide">Take your place ↗</button></form><button class="back" id="back">← Back to the entrance</button></section>`;
}
function lobby() {
  if (!session.host) return `<section class="narrow fade"><p class="eyebrow">ROOM ${esc(state.code)}</p><h2>${state.busy ? 'A case is taking shape.' : 'You’re on<br>the guest list.'}</h2>${progress() || '<div class="status">Keep this phone close. Your private character card will appear when the host begins.</div>'}<div class="panel"><span class="label gold">THE SUSPECTS · ${state.players.length}/8</span>${playerList()}</div><p class="small" style="margin-top:20px">Look up. Get comfortable. Try not to look guilty.</p></section>`;
  const url = `${location.origin}/join?code=${state.code}`;
  return `<div class="section-head"><div><p class="eyebrow">THE GUEST LIST IS OPEN</p><h2>Every guest has a secret.</h2></div><span class="badge">${state.mock ? 'Classic rehearsal' : 'A fresh case'}</span></div>${progress()}<div class="grid"><section class="panel"><span class="label gold">JOIN ON YOUR PHONE</span><div class="code">${esc(state.code)}</div><a class="join-url" href="${esc(url)}">${esc(url)}</a><div class="qr-wrap"><img id="qr" alt="Scan to join this room"><div><p>Scan the code.<br>Enter your name.<br>Keep your alibi ready.</p><button class="btn secondary" id="copy">Copy link</button></div></div></section><section class="panel"><span class="label gold">SUSPECTS ARRIVING · ${state.players.length}/8</span>${playerList()}<p class="small">3–8 players · Host does not need a character.<br>Playing too? Join on a separate phone.<br>Offline lobby seats are released after 15 seconds.</p><button id="next" class="btn wide" ${state.players.length < 3 || state.busy ? 'disabled' : ''}>${state.busy ? 'Writing your mystery…' : 'Begin the mystery ↗'}</button><p class="small" style="margin:14px 0 0">${state.mock ? 'Rehearsal mode: varied classic cases and device narration.' : 'AI atmosphere, an evidence-checked plot, and a classic case always on standby.'}</p></section></div>`;
}
function roleCard() {
  const c = state.role;
  if (!c) return '';
  const shareable = c.clues.find(clue => clue.id === c.shareableClueId);
  return `<section class="panel"><div class="role-head"><span class="secret-label">PRIVATE DOSSIER · FOR YOUR EYES ONLY</span><h2>${esc(c.name)}</h2><p class="small">Played by ${esc(c.playerName)} · ${esc(c.role)}</p><span class="badge ${c.killer ? 'killer' : ''}">${c.killer ? 'YOU ARE THE KILLER' : esc(c.role)}</span></div><div class="status"><h3>Read this aloud · ${esc(shareable.id)}</h3><p>${esc(shareable.text)}</p><p class="small">This clue matters in the final explanation. Share it with the table.</p></div>${[['Your character', c.personality], ['Connection to the victim', c.relationship], ['Your secret', c.secret], ['Your alibi', c.alibi], ...(c.killer ? [['Your motive', c.motive], ['Your method', c.method], ['Keep your cover', c.tips]] : [])].map(([title, text]) => `<div class="role-section"><h3>${title}</h3><p>${esc(text)}</p></div>`).join('')}<div class="role-section"><h3>Your other evidence</h3><ul>${c.clues.filter(clue => clue.id !== c.shareableClueId).map(clue => `<li><strong>${esc(clue.id)}</strong> · ${esc(clue.text)}</li>`).join('')}</ul></div></section>`;
}
function playerGame() {
  let action = '';
  const q = state.questions.find(q => q.playerId === state.me);
  if (state.phase === 'questions' && q) action = `<section class="panel"><p class="eyebrow">THE DETECTIVE IS ASKING YOU…</p><p class="question">“${esc(q.text)}”</p><p class="small">Answer out loud, then leave a short statement below.</p><form id="answer-form"><label for="answer">Your statement</label><textarea id="answer" maxlength="600" required placeholder="I can explain…">${esc(draft || state.myAnswer || '')}</textarea><div class="actions"><button class="btn">${state.myAnswer ? 'Update answer' : 'Submit answer'}</button><button class="btn secondary" type="button" id="dictate">Dictate</button></div></form>${state.myAnswer ? '<span class="small dot">✓ Statement received. You may edit it until the host continues.</span>' : ''}</section>`;
  else if (state.phase === 'voting') action = `<section class="panel"><p class="eyebrow">MAKE YOUR ACCUSATION</p><h3>Who killed ${esc(state.public.victim)}?</h3><p class="small">No voting for yourself. You can change your vote until the host reveals the case.</p><div class="vote-grid">${state.characters.filter(c => c.playerId !== state.me).map(c => `<button class="vote ${state.myVote === c.playerId ? 'selected' : ''}" data-vote="${esc(c.playerId)}"><strong>${esc(c.name)}</strong><span>${esc(c.role)} ${state.myVote === c.playerId ? '· ✓ Your vote' : ''}</span></button>`).join('')}</div><p class="small">${state.votesCast} of ${state.players.length} votes cast.</p></section>`;
  else action = `<div class="status">${state.phase === 'intro' ? 'The scene is set. Read your role in private, then listen to the host screen.' : state.phase === 'questions' ? 'The detective is questioning other guests. Listen carefully. Your moment may be next.' : 'Listen to Detective Marlowe. Discuss the evidence with your fellow suspects.'}</div>`;
  return `<div class="section-head"><p class="eyebrow" style="margin:0">${esc(state.public.title)}</p><span class="badge">${state.round ? `Round ${state.round}/3` : 'Your role'}</span></div>${classicNote()}<div class="grid"><div>${action}<button id="hear" class="btn secondary">Read the public scene aloud</button>${voiceControls()}</div><div>${roleCard()}</div></div>`;
}
function hostGame() {
  let body = '';
  const m = state.public;
  if (state.phase === 'intro') body = `<p class="eyebrow">THE CASE BEGINS</p><h2>${esc(m.title)}</h2><p class="lead" style="max-width:none">${esc(m.setting)}</p><div class="facts"><div><span class="label">THE VICTIM</span>${esc(m.victim)}</div><div><span class="label">CAUSE OF DEATH</span>${esc(m.causeOfDeath)}</div><div><span class="label">TIME OF DEATH</span>${esc(m.timeOfDeath)}</div></div><div class="rule"></div><p class="story">${esc(m.intro)}</p><div class="status">Everyone: read your private role card. Introduce your character, but keep your secrets to yourself.</div>`;
  if (state.phase === 'questions') body = `${detective()}<h2>Let’s hear your alibis.</h2><p class="small">Take turns in the order below. Read your shareable clue aloud, then submit a short statement on your phone.</p>${state.questions.map((q, i) => { const c = state.characters.find(c => c.playerId === q.playerId); return `<div class="question-card"><h3>${i + 1}. ${esc(c.playerName)} <span class="small">as ${esc(c.name)}</span></h3><span class="badge">${state.answered.includes(q.playerId) ? '✓ Statement received' : 'Waiting for ' + esc(c.playerName)}</span><p class="question">“${esc(q.text)}”</p></div>`; }).join('')}`;
  if (state.phase === 'reaction') body = `${detective()}<p class="eyebrow">MARLOWE’S OBSERVATIONS</p><p class="story">“${esc(state.reaction)}”</p><div class="status">Take a moment to compare clues. Someone’s story doesn’t add up.</div>`;
  if (state.phase === 'voting') body = `<p class="eyebrow">THE FINAL ACCUSATION</p><h2>One killer.<br>No more hiding.</h2><p class="lead">Cast your vote on your phone. The killer is caught only if more than half of all players vote for them.</p><div class="panel"><h3>${state.votesCast} of ${state.players.length} votes cast</h3><div class="progress"><i style="width:${state.votesCast / state.players.length * 100}%"></i></div><p class="small">Votes stay secret until the reveal. A tie or split vote lets the killer escape.</p></div>`;
  const blocked = state.busy || (state.phase === 'questions' && state.answered.length < state.questions.length) || (state.phase === 'voting' && state.votesCast < state.players.length);
  const label = { intro: 'Begin questioning', questions: 'Hear the detective', reaction: state.round < 3 ? 'Next round' : 'Open the vote', voting: 'Reveal the truth' }[state.phase];
  return `<div class="section-head"><span class="stage-label">ROOM ${esc(state.code)} / ${state.round ? `ROUND ${state.round} OF 3` : 'ACT I · THE ARRIVAL'}</span><span class="badge">${state.source === 'ai' ? 'AI-edited case' : 'Classic case'}</span></div>${classicNote()}<section class="panel">${body}</section><div class="controls"><div class="actions"><button class="btn secondary" id="hear">Hear again</button><button class="btn secondary" id="mute">${sound ? 'Sound on' : 'Sound off'}</button></div><button class="btn" id="next" ${blocked ? 'disabled' : ''}>${state.busy ? 'The detective is thinking…' : `${label} ↗`}</button></div>${voiceControls()}`;
}
function reveal() {
  const r = state.reveal;
  return `<section class="narrow fade" style="max-width:860px"><p class="eyebrow">THE VERDICT IS IN</p><h2>${r.killerWins ? 'The killer walks free.' : 'The mask comes off.'}</h2><div class="panel"><p class="label gold">THE TABLE’S ACCUSATIONS</p>${state.characters.map(c => `<div class="tally"><span class="tally-name">${esc(c.name)}<br><small>${esc(c.playerName)}</small></span><span class="bar"><i style="width:${r.tally[c.playerId] / state.players.length * 100}%"></i></span><span>${r.tally[c.playerId]}</span></div>`).join('')}<div class="rule"></div><p class="eyebrow">THE KILLER WAS</p><h2>${esc(r.killer)}</h2><span class="badge ${r.killerWins ? 'killer' : ''}">${r.killerWins ? 'Killer wins · No absolute majority' : 'Guests win · Killer caught'}</span>${revealed || !session.host ? `<div class="rule"></div>${r.solution.split('\n\n').map(paragraph => `<p class="story" style="font-size:22px">${esc(paragraph)}</p>`).join('')}` : '<div class="actions"><button class="btn" id="solution">Open the case file & narrate ↗</button></div>'}</div>${session.host ? '<div class="controls"><div class="actions"><button class="btn secondary" id="hear">Hear again</button><button class="btn secondary" id="mute">' + (sound ? 'Sound on' : 'Sound off') + '</button></div><button class="btn" id="next">Play again · Same guests ↗</button></div>' : '<button class="btn secondary" id="hear">Read the reveal aloud</button><p class="small" style="margin-top:20px">Stay here. Your host can start a new mystery with the same guests.</p>'}${voiceControls()}</section>`;
}
function render() {
  const focused = document.activeElement?.id;
  const cursor = focused === 'answer' ? document.activeElement.selectionStart : null;
  app.innerHTML = !state ? (session ? '<section class="narrow"><p class="eyebrow">OPENING THE CASE FILE</p><h2>Just a moment…</h2></section>' : joinMode ? joinForm() : landing()) : state.phase === 'lobby' ? lobby() : state.phase === 'reveal' ? reveal() : session.host ? hostGame() : playerGame();
  if (focused === 'answer') { const input = document.querySelector('#answer'); input?.focus(); input?.setSelectionRange(cursor, cursor); }
  if (state?.phase === 'lobby' && session.host) QRCode.toDataURL(`${location.origin}/join?code=${state.code}`, { margin: 1, width: 256 }).then(url => { const img = document.querySelector('#qr'); if (img) img.src = url; }).catch(() => {});
}
app.addEventListener('input', event => { if (event.target.id === 'answer') draft = event.target.value; });
app.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    if (event.target.id === 'join-form') {
      const code = document.querySelector('#join-code').value.toUpperCase().trim();
      const previous = store.get(`dn-player-${code}`);
      session = previous || { code, name: document.querySelector('#join-name').value.trim(), host: false };
      render(); connect();
    } else if (event.target.id === 'answer-form') await request('answer', { text: document.querySelector('#answer').value });
  } catch (e) { toast(e.message); } finally { button.disabled = false; }
});
app.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.id === 'host') {
      button.disabled = true;
      const response = await fetch('/api/rooms', { method: 'POST' });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      session = { ...result, host: true }; saveSession(); render(); connect();
    } else if (button.id === 'show-join') { joinMode = true; render(); }
    else if (button.id === 'back') { joinMode = false; render(); }
    else if (button.id === 'next') { stopVoice(); await request('next', { revision: state.revision }); }
    else if (button.id === 'copy') { await navigator.clipboard.writeText(`${location.origin}/join?code=${state.code}`); toast('Invitation link copied.'); }
    else if (button.id === 'hear') speak(narration());
    else if (button.id === 'mute') { sound = !sound; if (!sound) stopVoice(); else speak(narration()); render(); }
    else if (button.id === 'solution') { revealed = true; render(); autoNarrate(); }
    else if (button.dataset.vote) await request('vote', { playerId: button.dataset.vote });
    else if (button.id === 'dictate') {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) return toast('Dictation isn’t supported here. Use your keyboard’s microphone or type your answer.');
      const recognition = new Recognition(); recognition.lang = 'en-US';
      recognition.onresult = e => { draft = e.results[0][0].transcript.slice(0, 600); const field = document.querySelector('#answer'); if (field) field.value = draft; };
      recognition.onerror = () => toast('Microphone unavailable. Please type your statement.'); recognition.start();
    }
  } catch (e) { toast(e.message); } finally { if (button.id === 'host') button.disabled = false; }
});
if (joinMode && queryCode) session = store.get(`dn-player-${queryCode}`);
else if (!joinMode) session = store.get('dn-host');
render(); if (session) connect();
