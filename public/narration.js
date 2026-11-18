export function narrationChunks(text, limit = 260) {
  const chunks = [];
  for (const sentence of String(text).match(/[^.!?]+[.!?]+[”"’]?|[^.!?]+$/g) || []) {
    for (const word of sentence.trim().split(/\s+/)) {
      if (!word) continue;
      if (!chunks.length || chunks.at(-1).length + word.length + 1 > limit) chunks.push('');
      chunks[chunks.length - 1] += `${chunks.at(-1) ? ' ' : ''}${word}`;
    }
    if (chunks.at(-1)) chunks.push('');
  }
  return chunks.filter(Boolean);
}
