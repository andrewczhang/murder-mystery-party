const settings = [
  { name: 'the Meridian night train', publicArea: 'dining carriage', scene: 'baggage carriage' },
  { name: 'the Glasswing museum', publicArea: 'portrait hall', scene: 'restoration room' },
  { name: 'the Halcyon polar observatory', publicArea: 'mess room', scene: 'instrument room' },
  { name: 'the Velvet Current floating theatre', publicArea: 'auditorium', scene: 'prop room' },
  { name: 'the Sunless Reef research station', publicArea: 'canteen', scene: 'survey room' },
  { name: 'the Copper Dial radio studio', publicArea: 'broadcast booth', scene: 'archive room' }
];
const eras = ['1938', '1956', '1978', '2006', '2041'];
const genres = ['closed-circle puzzle', 'espionage thriller', 'heist gone wrong', 'revenge drama', 'industrial noir'];
const methods = [
  { name: 'a fatal blow with a survey weight', item: 'the numbered brass survey weight', trace: 'a square-edged wound and brass residue', title: 'A Weight of Silence' },
  { name: 'strangulation with a stage cord', item: 'the blue braided stage cord', trace: 'a braided ligature mark with blue fibres', title: 'The Last Cue' },
  { name: 'a staged fall from a maintenance platform', item: 'the numbered release handle for the platform rail', trace: 'fatal fall injuries and a deliberately released platform rail', title: 'The Missing Rung' },
  { name: 'a fatal wound from a display blade', item: 'the blunt-backed ceremonial display blade', trace: 'a narrow wound matching the display blade and a chipped tip left at the scene', title: 'An Edge in the Dark' },
  { name: 'a deliberately released overhead counterweight', item: 'the numbered counterweight release lever', trace: 'crushing injuries and a deliberately released overhead counterweight', title: 'Dead Air Above' }
];
const names = ['Vera Quill', 'Idris Voss', 'Cleo Rook', 'Felix Sable', 'Nadia Wren', 'Otis Flint', 'Ada Mercer', 'Jules Pike', 'Ines Cobalt', 'Remy Fenn', 'Tess Lark', 'Noel Marlow', 'Lena Sloane', 'Hugo Penn', 'Mina Callow', 'Eli Moss', 'Sera Hollis', 'Bram Hale', 'Zora Keene', 'Kit Arden', 'Rhea Sol', 'Leon Finch', 'Esther Lune', 'Milo Crest'];
const roles = ['Patron', 'Archivist', 'Stage designer', 'Accounts clerk', 'Photographer', 'Courier', 'Engineer', 'Journalist'];
const motives = [
  { conceal: 'stolen relief funds', document: 'audit', finding: 'diverted relief funds' },
  { conceal: 'the sale of confidential route maps', document: 'shipping receipt', finding: 'sold confidential route maps to a rival' },
  { conceal: 'a forged professional identity', document: 'personnel report', finding: 'used a forged professional identity' },
  { conceal: 'the theft of an unpublished manuscript', document: 'copyright claim', finding: 'stole an unpublished manuscript' },
  { conceal: 'the sale of counterfeit artworks', document: 'provenance report', finding: 'sold counterfeit artworks' }
];
const distractions = [
  ['hid a sealed envelope', 'Its visible receipt identifies a private debt payment, not a purchase of equipment.', 'The envelope looked like a payoff, but the receipt explains a private debt.'],
  ['burned a letter', 'The surviving heading identifies a rejected love letter; its date is last month.', 'The burned letter concealed an embarrassment, not instructions for a crime.'],
  ['left the gathering without saying why', 'A signed parcel receipt records a delivery at the public entrance.', 'The unexplained departure was to collect a parcel, not proof of entry to the crime scene.'],
  ['hid ink-stained gloves', 'The printing job ticket lists those gloves as protection for a messy invitation run.', 'The stains came from printing invitations. They do not match the examiner’s physical findings.'],
  ['changed their jacket in a hurry', 'The cloakroom slip says a leaking ink bottle stained the old jacket.', 'The change concealed an ink spill. The cloakroom slip explains it without supplying a murder method.'],
  ['locked a small case when approached', 'Its inventory card lists pawn tickets for personal jewellery.', 'The locked case concealed money troubles, not the fatal object.'],
  ['pocketed an unlabelled key', 'The attached repair ticket identifies it as a broken desk key, unusable in the crime room.', 'The suspicious key belongs to a desk and does not supply access to the crime room.'],
  ['scraped a name off a silver medal', 'The presentation list records it as an unwanted gift from a former partner.', 'The scratched medal concealed a past relationship, not the cause of death.']
];
const secrets = [
  'You sold a private invitation to pay a debt. The victim threatened to dismiss you.',
  'You secretly copied the victim’s correspondence to protect a friend.',
  'You pawned a gift from the victim and replaced it with an imitation.',
  'You are leaving tonight to work for the victim’s rival.',
  'You claimed credit for work the victim actually commissioned from someone else.',
  'You intercepted a letter addressed to the victim because it mentioned your family.',
  'You concealed a costly bookkeeping mistake from the victim.',
  'You anonymously criticised the victim in print and feared being found out.'
];
export const banned = /\bmanor\b|blackstone|poison|torn fabric|mansion of deceit/i;
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
function random(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let x = h; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
export function buildCase(players, { seed = crypto.randomUUID(), previous = {} } = {}) {
  if (players.length < 3 || players.length > 8 || new Set(players.map(p => p.id)).size !== players.length) throw new Error('Use 3–8 distinct players.');
  const rng = random(seed);
  const pick = (list, last) => { const pool = list.filter(v => (v.name || v) !== last); return pool[Math.floor(rng() * pool.length)]; };
  const setting = pick(settings, previous.settingName), era = pick(eras, previous.era), genre = pick(genres, previous.genre), method = pick(methods, previous.methodName);
  const motive = pick(motives);
  const availableNames = names.filter(n => !players.some(p => p.name.toLowerCase() === n.toLowerCase()));
  const takeName = () => availableNames.splice(Math.floor(rng() * availableNames.length), 1)[0];
  const victim = takeName(), killerIndex = Math.floor(rng() * players.length), death = 20 * 60 + Math.floor(rng() * 45);
  const timeOfDeath = clock(death), before = clock(death - 12), discovery = clock(death + 7);
  const characters = players.map((p, i) => ({ playerId: p.id, playerName: p.name, name: takeName(), role: roles[i], personality: 'Polite as a closed door; sharp when your reputation is at stake.', relationship: `You work with ${victim}, who controls your next contract.`, secret: secrets[i], alibi: `At ${timeOfDeath}, you were in the ${setting.publicArea}.`, alibiTime: timeOfDeath, killer: i === killerIndex, clues: [] }));
  const killer = characters[killerIndex], witnesses = characters.filter(c => !c.killer);
  Object.assign(killer, { secret: `You killed ${victim} in the ${setting.scene} at ${timeOfDeath} to conceal ${motive.conceal}.`, motive: `The victim discovered you ${motive.finding} and would report it tonight.`, method: method.name, tips: `Your public alibi is the ${setting.publicArea} at ${timeOfDeath}. Do not volunteer that you entered the ${setting.scene}. Deflect toward the other guests’ genuine secrets.` });
  let number = 0;
  const add = (holder, subject, kind, clue, explanation) => { const c = { id: `C${++number}`, subjectId: subject.playerId, kind, text: clue, explanation }; holder.clues.push(c); return c; };
  const methodClue = add(witnesses[0], killer, 'method', `${killer.name} signed out ${method.item} at ${before}. The return box is empty. The examiner’s public report records ${method.trace}.`, 'The borrowed object matches the physical cause of death; access alone is suspicion, not proof.');
  const opportunity = add(witnesses[1], killer, 'opportunity', `The entry recorder prints ${killer.name}’s personal badge entering the ${setting.scene} at ${timeOfDeath}; you saw them wearing that badge. They claimed to be in the ${setting.publicArea} then.`, 'The badge record and your sighting contradict the claimed alibi at the exact time of death. This is the missing opportunity, not just a motive.');
  for (let i = 0; i < characters.length; i++) {
    const holder = characters[i], other = characters[(i + 1) % characters.length];
    const distraction = distractions[i];
    if (!holder.clues.length) add(holder, other, 'redHerring', `${other.name} ${distraction[0]} at ${before}. ${distraction[1]}`, `${distraction[2]} This explains the suspicious action, not the fatal object or the false alibi.`);
    holder.shareableClueId = holder.clues[0].id;
  }
  const motiveClue = add(witnesses[0], killer, 'motive', `${victim}’s signed ${motive.document} names ${killer.name} as the person who ${motive.finding}. A note on the document says it will be reported tonight.`, `The document supplies a specific motive: conceal ${motive.conceal}.`);
  for (let i = 0; i < characters.length; i++) {
    const holder = characters[i], other = characters[(i + 1) % characters.length];
    if (holder.clues.length < 2) add(holder, other, 'redHerring', `${other.name}’s argument with ${victim} at ${before} concerned an unpaid contract. The written contract confirms payment was postponed, not cancelled.`, 'An argument is not a murder method. The contract explains the dispute without accounting for the physical evidence or the false alibi.');
  }
  const m = { seed, settingName: setting.name, era, genre, methodName: method.name, title: method.title, setting: `${setting.name}, ${era} · ${genre}`, victim, causeOfDeath: method.name, timeOfDeath, intro: `${setting.name}, ${era}. A fundraising preview ends with ${victim} found in the ${setting.scene} at ${discovery}. The examiner fixes death at ${timeOfDeath}: ${method.trace}. Everyone claims the ${setting.publicArea} as an alibi. Read your shareable clue aloud; one false alibi will not survive the clock.`, timeline: [{ time: before, event: 'Equipment loan and private disputes' }, { time: timeOfDeath, event: `Death in the ${setting.scene}` }, { time: discovery, event: 'Body discovered' }], characters, methodClueId: methodClue.id, catchClueId: opportunity.id, motiveClueId: motiveClue.id };
  m.solutionClueIds = characters.flatMap(c => c.clues.map(clue => clue.id));
  m.solution = caseSolution(m);
  return m;
}
export function caseSolution(m) {
  const killer = m.characters.find(c => c.killer), clues = m.characters.flatMap(c => c.clues);
  return [`The room had plenty of shadows, but only one false alibi. ${killer.name} killed ${m.victim} by ${m.causeOfDeath} at ${m.timeOfDeath}.`, ...m.solutionClueIds.map(id => { const c = clues.find(c => c.id === id); return `[${id}] ${c.text} ${c.explanation}`; }), `The moment to catch the killer was when ${m.catchClueId} was read aloud: compare that entry time with ${killer.name}’s claimed alibi. Pair it with ${m.methodClueId}, then the motive in ${m.motiveClueId}. The other suspicions explain secrets, not this crime.`].join('\n\n');
}
