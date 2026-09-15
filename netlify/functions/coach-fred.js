// Coach Fred backend function
//
// This runs ONLY on Netlify's servers. The Anthropic API key lives in an
// environment variable here and is NEVER sent to the browser. The browser
// only ever calls THIS function and receives back plain text — nothing else.
//
// Required environment variables (set in Netlify dashboard, never in code):
//   ANTHROPIC_API_KEY   - from an isolated Coach Fred-only workspace
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY - service role key (server-side only, never public)

const { createClient } = require('@supabase/supabase-js');
const { retrieveRelevantChunks } = require('./retrieval.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// --- Simple in-memory rate limiter (per function instance) ---
// For a small user base this is a reasonable first layer; if usage grows,
// move this to a Supabase-backed counter for consistency across instances.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 8;   // generous for a real user, tight for a script

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  rateLimitMap.set(userId, entry);
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

// --- Book content is retrieved per-question, not stuffed in wholesale ---
// See retrieval.js — this keeps each request to a handful of relevant
// passages instead of resending all four books (~220k tokens) every time.
function buildSystemPrompt(relevantChunks) {
  const context = relevantChunks.length
    ? relevantChunks.map((c) => `[From: ${c.source}]\n${c.text}`).join('\n\n---\n\n')
    : '(No closely matching passage was found in the books for this question.)';

  return `You are Coach Fred, a warm, direct coach for teenagers and young adults, in the voice of Per-Fredrik Emanuelsson, author of the Starts With You book series (Money, Careers, Self-Leadership, Investing).

STRICT RULE: Only answer using the book excerpts provided below. Never use outside knowledge, current events, or general facts not contained in these excerpts. These excerpts are a retrieved subset of the books, not the whole text — if the answer isn't in what's shown, say so honestly rather than guessing or filling the gap from general knowledge.

If a question is unrelated to the books entirely (sports scores, weather, other homework, celebrity gossip, general trivia), respond warmly but firmly that it's outside what you help with, and redirect to the books' themes. Keep it short and in character.

After your reply, on a new line, output exactly one of:
RELEVANCE: relevant
RELEVANCE: irrelevant
This line is for internal logging only and will be stripped before the student sees your reply.

RELEVANT BOOK EXCERPTS FOR THIS QUESTION:
"""
${context}
"""`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { userId, message, history = [] } = JSON.parse(event.body);

    if (!userId || !message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId or message' }) };
    }

    // --- 1. Rate limit check (fast, cheap, before touching the database) ---
    if (isRateLimited(userId)) {
      await logSafeguardEvent(userId, 'rate_limited', 'Exceeded requests per minute');
      return {
        statusCode: 429,
        body: JSON.stringify({ error: "You're sending messages a bit fast — give it a moment and try again." })
      };
    }

    // --- 2. Look up user and their cap ---
    const { data: user, error: userError } = await supabase
      .from('cf_users')
      .select('id, monthly_message_cap, country')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return { statusCode: 403, body: JSON.stringify({ error: 'User not recognized.' }) };
    }

    // --- 3. Check monthly usage against cap ---
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { count: usedThisMonth } = await supabase
      .from('cf_usage_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', monthStart.toISOString());

    if (usedThisMonth >= user.monthly_message_cap) {
      await logSafeguardEvent(userId, 'monthly_cap_hit', `Cap: ${user.monthly_message_cap}`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          reply: "You've used all your Coach Fred questions for this month — they reset at the start of next month. Thanks for using them well!"
        })
      };
    }

    // --- 4. Retrieve only the relevant book passages for this question ---
    const relevantChunks = retrieveRelevantChunks(message, 6);
    const systemPrompt = buildSystemPrompt(relevantChunks);

    // --- 5. Call Anthropic (key never leaves this server) ---
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt,
        messages: [...history, { role: 'user', content: message }]
      })
    });

    const data = await response.json();
    const rawText = data.content?.find((b) => b.type === 'text')?.text || '';

    // Strip the internal relevance tag before sending to the student
    const relevanceMatch = rawText.match(/RELEVANCE:\s*(relevant|irrelevant)/i);
    const wasRelevant = relevanceMatch ? relevanceMatch[1].toLowerCase() === 'relevant' : null;
    const reply = rawText.replace(/RELEVANCE:\s*(relevant|irrelevant)\s*$/i, '').trim();

    // --- 6. Log usage (metadata only, no message content) ---
    await supabase.from('cf_usage_log').insert({
      user_id: userId,
      input_tokens: data.usage?.input_tokens ?? null,
      output_tokens: data.usage?.output_tokens ?? null,
      was_relevant: wasRelevant,
      topic_category: relevantChunks[0]?.source || null // best-guess topic: the top-matched book
    });

    if (wasRelevant === false) {
      await logSafeguardEvent(userId, 'irrelevant_flagged', message.slice(0, 60)); // short excerpt only, not full text
    }

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error('Coach Fred error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};

async function logSafeguardEvent(userId, eventType, detail) {
  await supabase.from('cf_safeguard_events').insert({ user_id: userId, event_type: eventType, detail });
}
