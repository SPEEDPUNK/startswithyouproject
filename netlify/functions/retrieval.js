// Simple BM25 keyword retrieval over the pre-chunked book content.
// No external embeddings API needed — this runs entirely server-side,
// in-memory, using classic term-frequency scoring. Good enough for
// coaching-style questions where the student's own words (resilience,
// budget, motivation, compounding...) tend to overlap with the book text.
//
// Upgrade path (noted in README): swap this for a real embeddings-based
// vector search (e.g. via Supabase pgvector) if keyword matching proves
// too literal once we see real usage.

const chunks = require('./book_chunks.json'); // [{ source, text }]

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','to','of','in','on','for',
  'and','or','but','with','as','at','by','this','that','it','you','your','i',
  'me','my','do','does','did','can','could','should','would','will','what',
  'how','why','when','where','who','which','not','no','so','if','about'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Precompute document tokens + term frequencies once per cold start.
const docs = chunks.map((c) => {
  const tokens = tokenize(c.text);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return { ...c, tokens, tf, length: tokens.length };
});

const avgDocLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;

// Document frequency per term (for IDF)
const df = {};
for (const d of docs) {
  for (const term of new Set(d.tokens)) {
    df[term] = (df[term] || 0) + 1;
  }
}
const N = docs.length;

function idf(term) {
  const n = df[term] || 0;
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

const K1 = 1.5;
const B = 0.75;

function bm25Score(queryTerms, doc) {
  let score = 0;
  for (const term of queryTerms) {
    const f = doc.tf[term] || 0;
    if (f === 0) continue;
    const numerator = f * (K1 + 1);
    const denominator = f + K1 * (1 - B + B * (doc.length / avgDocLength));
    score += idf(term) * (numerator / denominator);
  }
  return score;
}

/**
 * Returns the top-K most relevant chunks for a given question.
 * @param {string} query
 * @param {number} topK
 */
function retrieveRelevantChunks(query, topK = 6) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const scored = docs.map((d) => ({ doc: d, score: bm25Score(queryTerms, d) }));
  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, topK)
    .filter((s) => s.score > 0)
    .map((s) => s.doc);
}

module.exports = { retrieveRelevantChunks };
