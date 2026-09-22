___PERSONA_PLACEHOLDER___

// --- Book content is retrieved per-question, not stuffed in wholesale ---
// See retrieval.js — this keeps each request to a handful of relevant
// passages instead of resending all four books (~220k tokens) every time.
function buildSystemPrompt(relevantChunks) {
  const context = relevantChunks.length
    ? relevantChunks.map((c) => `[From: ${c.source}]\n${c.text}`).join('\n\n---\n\n')
    : '(No closely matching passage was found in the books for this question.)';

  return `${PERSONA_PROMPT}

## Grounding Rule — On Top Of Everything Above

Everything above is who you are and how you talk. But your factual claims about
money, careers, self-leadership and investing must stay grounded in the book
excerpts provided below for THIS question. These excerpts are a retrieved
subset, not the whole text. If a claim isn't supported by what's shown here,
don't invent it or fall back on general internet knowledge — use one of the
three response modes below instead.

## Three Response Modes For Questions The Excerpts Don't Cover

When the retrieved excerpts don't give you a solid answer, pick exactly one:

1. CONTENT GAP — the question is a fair thing for a coach like you to be asked
   (money, careers, self-leadership, investing) but the books genuinely don't
   go deep enough here. Say so honestly, in character, and offer: "Let
   Fredrik know if you'd like this covered in more depth — that's exactly how
   the books grow." Then flag it (see RELEVANCE line below).

2. HAND-BACK — the question is personal/situational with no general answer
   any book could give (e.g. "should I take this specific job offer").
   Don't fake an answer. Ask what THEY think their next step is — that's
   coaching them to own the decision, not dodging it.

3. BOOK-LENS REFRAME — the question sits outside the books' literal topics
   (e.g. a relationship question) but a book framework still illuminates it
   usefully (e.g. NPV-style trade-off thinking, the Logical Levels diagnostic).
   Offer the reframe explicitly as ONE way to think about it, not the answer —
   e.g. "I can't tell you what to do here, but here's a lens from the money
   chapters that might help you think it through..." Only use this when a
   lens genuinely fits — don't force one onto something it'd feel tone-deaf
   applied to.

## Internal Logging Line — Not Shown To The Student

After your reply, on a new line, output exactly one of:
RELEVANCE: relevant
RELEVANCE: gap
RELEVANCE: handback
RELEVANCE: reframe
This line is for internal logging only (which response mode you used, and
whether it's a flag-worthy content gap) and will be stripped before the
student sees your reply.

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
    const body = JSON.parse(event.body);

    // --- Route: thumbs up/down feedback (no chat, just a vote) ---
    if (body.action === 'feedback') {
      return await handleFeedback(body);
    }

    const { userId, message, history = [] } = body;

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

    // --- 2. Three-strike circuit breaker: is this user currently cooling down? ---
    const cooldownUntil = await getActiveCooldown(userId);
    if (cooldownUntil) {
      return {
        statusCode: 200,
        body: JSON.stringify({ reply: FRED_PAUSE_MESSAGE, cooldownUntil })
      };
    }

    // --- 3. Look up user and their cap ---
    const { data: user, error: userError } = await supabase
      .from('cf_users')
      .select('id, monthly_message_cap, country')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return { statusCode: 403, body: JSON.stringify({ error: 'User not recognized.' }) };
    }

    // --- 4. Check monthly usage against cap ---
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

    // --- 5. Retrieve only the relevant book passages for this question ---
    const relevantChunks = retrieveRelevantChunks(message, 6);
    const systemPrompt = buildSystemPrompt(relevantChunks);

    // --- 6. Call Anthropic (key never leaves this server) ---
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

    // Strip the internal relevance/mode tag before sending to the student
    const relevanceMatch = rawText.match(/RELEVANCE:\s*(relevant|gap|handback|reframe)/i);
    const responseMode = relevanceMatch ? relevanceMatch[1].toLowerCase() : null;
    const reply = rawText.replace(/RELEVANCE:\s*(relevant|gap|handback|reframe)\s*$/i, '').trim();

    // A "low-value" turn for circuit-breaker purposes: the model itself
    // decided it couldn't give a grounded answer from the books (gap or
    // handback). Reframe still counts as Fred doing real coaching work,
    // so it does NOT count as a strike.
    const isLowValueTurn = responseMode === 'gap' || responseMode === 'handback';

    // --- 7. Log usage (metadata only, no message content) ---
    const { data: logRow } = await supabase.from('cf_usage_log').insert({
      user_id: userId,
      input_tokens: data.usage?.input_tokens ?? null,
      output_tokens: data.usage?.output_tokens ?? null,
      response_mode: responseMode,
      topic_category: relevantChunks[0]?.source || null // best-guess topic: the top-matched book
    }).select('id').single();

    if (responseMode === 'gap') {
      // This is the actual "what should Fredrik write next" signal —
      // topic only, never the question text itself.
      await logSafeguardEvent(userId, 'content_gap_flagged', relevantChunks[0]?.source || 'unmatched topic');
    }

    // --- 8. Three-strike circuit breaker bookkeeping ---
    if (isLowValueTurn) {
      const strikes = await countRecentStrikes(userId);
      if (strikes + 1 >= STRIKE_LIMIT) {
        await triggerCooldown(userId);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ reply, messageId: logRow?.id ?? null }) };
  } catch (err) {
    console.error('Coach Fred error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};

// --- Thumbs up/down handler ---
// Front-end calls this with { action: 'feedback', userId, messageId, vote: 'up'|'down' }.
// No message content is ever sent or stored here — just the vote against the
// already-logged usage row, so a down-vote can be joined back to its topic
// (via cf_usage_log.topic_category) without ever storing what was asked.
async function handleFeedback({ userId, messageId, vote }) {
  if (!userId || !messageId || !['up', 'down'].includes(vote)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid feedback fields' }) };
  }

  await supabase
    .from('cf_usage_log')
    .update({ feedback: vote })
    .eq('id', messageId)
    .eq('user_id', userId);

  if (vote === 'down') {
    // Down-votes are the priority signal for "what to write next" —
    // stronger than a bare content-gap flag, since a human confirmed it
    // didn't help. Still topic-only, never content.
    const { data: row } = await supabase
      .from('cf_usage_log')
      .select('topic_category')
      .eq('id', messageId)
      .single();
    await logSafeguardEvent(userId, 'downvote_flagged', row?.topic_category || 'unknown topic');
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

async function logSafeguardEvent(userId, eventType, detail) {
  await supabase.from('cf_safeguard_events').insert({ user_id: userId, event_type: eventType, detail });
}

// Counts low-value-turn safeguard events (content_gap_flagged) for this user
// within the rolling strike window. Kept separate from monthly usage counts
// on purpose — this is about session intensity, not monthly allowance.
async function countRecentStrikes(userId) {
  const since = new Date(Date.now() - STRIKE_WINDOW_MS).toISOString();
  const { count } = await supabase
    .from('cf_safeguard_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('event_type', 'content_gap_flagged')
    .gte('created_at', since);
  return count || 0;
}

async function triggerCooldown(userId) {
  const cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString();
  await supabase.from('cf_safeguard_events').insert({
    user_id: userId,
    event_type: 'cooldown_triggered',
    detail: `Cooling down until ${cooldownUntil}`
  });
  // Cooldown state is derived by reading the most recent cooldown_triggered
  // event and checking its detail timestamp — see getActiveCooldown below.
  // (A dedicated cf_users.cooldown_until column would be cleaner long-term;
  // noted in the migration file as an optional upgrade.)
}

async function getActiveCooldown(userId) {
  const { data } = await supabase
    .from('cf_safeguard_events')
    .select('created_at')
    .eq('user_id', userId)
    .eq('event_type', 'cooldown_triggered')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!data) return null;

  const triggeredAt = new Date(data.created_at).getTime();
  const cooldownUntil = triggeredAt + COOLDOWN_MS;
  return cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null;
}
