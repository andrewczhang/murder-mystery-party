import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildCase, evidenceAtRound } from '../cases.js';
import { narrationChunks } from '../public/narration.js';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
function ui() {
  const listeners = {}, saved = new Map(), app = { innerHTML: '', addEventListener: (type, fn) => { listeners[type] = fn; } };
  const label = { textContent: '' };
  let voiceCalls = 0;
  const context = vm.createContext({
    document: { activeElement: null, querySelector: selector => selector === '#app' ? app : label },
    location: { pathname: '/', search: '', origin: 'http://localhost' }, URLSearchParams, narrationChunks,
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    window: { addEventListener() {}, speechSynthesis: { cancel() {}, getVoices() { voiceCalls++; throw new Error('No device voice'); } } },
    setTimeout, clearTimeout
  });
  const run = expression => vm.runInContext(expression, context);
  run(source);
  const players = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `Guest ${i}` }));
  const m = buildCase(players, { seed: 'ui' });
  context.initial = { code: 'TEST', phase: 'intro', round: 0, public: { title: m.title, victim: m.victim, timeOfDeath: m.timeOfDeath, intro: m.intro }, players, characters: m.characters.map(({ playerId, playerName, name, role }) => ({ playerId, playerName, name, role })), role: { ...m.characters[3], clues: [] }, questions: [], answered: [], evidence: [], mock: true };
  run('session = { host: true }; state = initial; render();');
  return { app, run, context, listeners, saved, label, mystery: m, voiceCalls: () => voiceCalls };
}
test('host progression and case-file buttons are text-first, separate from optional narration', () => {
  const { app, run } = ui();
  assert.match(app.innerHTML, /Next: the detective’s questions/);
  assert.match(app.innerHTML, /id="mute" aria-pressed="true"/);
  run("state.phase = 'questions'; render();");
  assert.match(app.innerHTML, /Next: the detective’s observations/);
  assert.doesNotMatch(app.innerHTML, /Hear the detective/);
  run("state.phase = 'reveal'; state.reveal = { killer: 'Suspect', tally: {}, solution: 'The printed solution.' }; render();");
  assert.match(app.innerHTML, /Open the case file ↗/);
  assert.doesNotMatch(app.innerHTML, /case file &amp; narrate|case file & narrate/);
});
test('unavailable speech enters text-only mode once and does not attempt narration every scene', async () => {
  const { app, run, voiceCalls } = ui();
  await run("speak('The case begins.')");
  assert.equal(voiceCalls(), 1);
  assert.equal((app.innerHTML.match(/Text-only mode/g) || []).length, 1);
  assert.match(app.innerHTML, /Speech is unavailable on this device/);
  assert.match(app.innerHTML, /id="mute"[^>]*disabled/);
  run("state.phase = 'reaction'; state.reaction = 'All the evidence remains printed.'; state.round = 1; autoNarrate(); render();");
  await run("speak('Another scene.')");
  assert.equal(voiceCalls(), 1);
  assert.match(app.innerHTML, /All the evidence remains printed/);
});
test('sitting-out phones get a private round note, safe empty cards, fresh clues and shared evidence', () => {
  const { app, run, context, listeners, saved, mystery } = ui();
  run("session.host = false; state.me = 'p3'; render();");
  assert.match(app.innerHTML, /Your first clue opens in Round 1/);
  context.visible = evidenceAtRound(mystery, 1);
  context.ownClues = mystery.characters[3].clues.filter(c => c.unlockRound === 1);
  run("state.phase = 'questions'; state.round = 1; state.evidence = visible; state.role.clues = ownClues; state.role.shareableClueId = ownClues[0].id; render();");
  assert.match(app.innerHTML, /Your side of the investigation/);
  assert.match(app.innerHTML, /Read your newly unlocked clue aloud/);
  assert.match(app.innerHTML, /Saved only on this phone/);
  assert.match(app.innerHTML, /New evidence · Round 1/);
  listeners.input({ target: { id: 'theory', value: '<My private suspect>' } });
  assert.equal(saved.size, 1);
  run('render();'); assert.match(app.innerHTML, /&lt;My private suspect&gt;/);
  run("state.round = 2; render();");
  assert.doesNotMatch(app.innerHTML, /&lt;My private suspect&gt;/);
  assert.match(app.innerHTML, /What has changed/);
  run("state.evidence = []; render();");
  assert.doesNotMatch(app.innerHTML, /Open shared evidence/);
});
test('phone reveal waits for the host then shows a short why with collapsed details, not the TV narrative', () => {
  const { app, run } = ui();
  run("session.host = false; state.phase = 'reveal'; state.reveal = { killer: 'The culprit', tally: {}, caseFileOpen: false }; render();");
  assert.match(app.innerHTML, /The host will open the case file shortly/);
  assert.doesNotMatch(app.innerHTML, /Why this suspect/);
  run("state.reveal.caseFileOpen = true; state.reveal.why = 'The entry record contradicts the alibi.'; state.reveal.details = [{ id: 'C2', text: 'The printed evidence.', explanation: 'The clue explained.' }]; state.reveal.solution = 'TV narrative only'; render();");
  assert.match(app.innerHTML, /The entry record contradicts the alibi/);
  assert.match(app.innerHTML, /<details><summary>How the clues fit/);
  assert.doesNotMatch(app.innerHTML, /<details[^>]*open|TV narrative only/);
});
test('statements show a live 600-character limit and reject oversized pastes and dictation without losing the draft', async () => {
  const { app, run, listeners, label, context } = ui();
  run("session.host = false; state.me = 'p3'; state.questions = [{ playerId: 'p3', text: 'Your alibi?' }]; state.phase = 'questions'; render();");
  assert.match(app.innerHTML, /maxlength="600" aria-describedby="answer-counter answer-limit"/);
  assert.match(app.innerHTML, /0\/600 characters/);
  listeners.input({ target: { id: 'answer', value: 'My intact statement.' } });
  assert.equal(label.textContent, '20/600 characters');
  let prevented = false;
  const paste = text => listeners.paste({ target: { id: 'answer', value: 'My intact statement.', selectionStart: 20, selectionEnd: 20 }, clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } });
  paste('x'.repeat(601)); assert.equal(prevented, true);
  assert.match(label.textContent, /Paste not inserted/);
  assert.equal(run('draft'), 'My intact statement.');
  prevented = false; paste(' More.'); assert.equal(prevented, false);
  context.window.SpeechRecognition = class { start() { this.onresult({ results: [[{ transcript: 'x'.repeat(601) }]] }); } };
  await listeners.click({ target: { closest: () => ({ id: 'dictate', dataset: {} }) } });
  assert.equal(run('draft'), 'My intact statement.'); assert.match(label.textContent, /Dictation exceeds 600/);
  listeners.input({ target: { id: 'answer', value: 'x'.repeat(600) } });
  assert.equal(label.textContent, '600/600 characters · Limit reached');
});
