// Vercel serverless function: relays the "Question?" chat and theory-answer feedback to Gemini.
// The API key is read from the GEMINI_API_KEY environment variable on Vercel. It is never sent to the browser.
const MODEL = 'gemini-3.5-flash-lite';
const PER_MINUTE = 15;          // free-tier requests per minute (check AI Studio)
const PER_VISITOR_DAY = 40;     // requests per visitor per day (chat + feedback)
const PER_TOTAL_DAY = 400;      // requests per day, all visitors
const MAX_TURNS = 12, MAX_TURN_CHARS = 4000, MAX_CONTEXT_CHARS = 6000;

const RULES = `You are a patient Python tutor inside a study site for an EDHEC MSc Data Analytics & AI exam called "Python Programming" (course 6074, R. Hoogervorst). The course covers: print, comments, variables, input(), types (str, int, float, bool) and conversions, arithmetic, f-strings and formatting (:.2f), booleans and comparisons, if/elif/else, for loops with range, while loops, break and continue, modules and imports, functions with parameters and return, type hints, local and global scope, lists, dictionaries, tuples, looping over collections, pandas (DataFrame from dict or read_csv, dtypes, columns as Series, mean/min/max/describe, filtering with & and |, set_index, head/tail, iloc/loc, isna/fillna/dropna, groupby with an aggregation), statsmodels (smf.ols formula, sm.OLS with add_constant, fit, params, pvalues, kstest_normal), matplotlib (plt.subplots, plot, hist, scatter, bar, set_title, set_xlabel, set_ylabel, show, savefig), objects (functions vs methods vs attributes, mutable objects passed to functions) and debugging (syntax, runtime and logic errors, reading tracebacks, print debugging, breakpoints). The exam is 2 hours, 100 points, no documents: an input-loop interface with two helper functions, a list or dictionary algorithm, a pandas exercise with a plot, and theory questions (is this code correct, explain a concept in at most 10 sentences, explain a pandas error).

How to answer:
- Start from what they actually asked. Plain words first, then the code. Keep it short: usually under 150 words plus code.
- Use small, runnable code examples in fenced \`\`\`python blocks, and show what they print when that helps.
- Only use what the course teaches. Avoid list comprehensions, lambda, classes, try/except and other advanced syntax unless the student asks.
- If they ask you to solve an exercise, give the approach and a hint first; give the full solution only if they explicitly ask for it.
- If their question or code shows a misconception, say so directly and correct it. When they paste code with an error, point to the line and explain the error message.
- Use **bold** sparingly and short "- " bullet lists only when listing steps. No headings, no tables, no em dashes, no praise or filler.
- When it fits, end with one short check question they can try, or say which exam exercise type this concept appears in.
- If the question is outside this course, answer briefly and steer back.`;

const GRADER = `You are a strict but fair grader for an EDHEC MSc exam in Python Programming. Grade the student's answer against the rubric only. Give credit for correct ideas even if worded differently; give no credit for vague statements, and none for a point stated wrongly. Award 1 (fully met), 0.5 (partly met or imprecise) or 0 (missing or wrong) per rubric item. Reply with JSON only: {"items":[{"score":1,"comment":"short reason"}],"feedback":"2 to 3 sentences telling the student exactly what to add or fix to get full marks. Address them as 'you'. No praise padding. No em dashes."}. The items array must have exactly one entry per rubric item, in order.`;

// Counters live in this function instance. Vercel can start new instances, which resets them, so they are approximate.
const state = { day: '', visitors: new Map(), total: 0, minute: [] };
function resetDay(day) { if (state.day !== day) { state.day = day; state.visitors = new Map(); state.total = 0; } }
function minuteOk() {
  const now = Date.now();
  state.minute = state.minute.filter(t => now - t < 60000);
  if (state.minute.length >= PER_MINUTE) return false;
  state.minute.push(now);
  return true;
}
function clean(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const turns = messages.slice(-MAX_TURNS)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== 'user') return null;
  return turns;
}
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

async function gemini(payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(payload) });
  if (r.status === 429) return { error: 'busy', status: 429 };
  if (!r.ok) return { error: 'upstream', status: 502 };
  const data = await r.json();
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
  if (!text) return { error: 'empty', status: 502 };
  return { text, truncated: cand.finishReason === 'MAX_TOKENS' };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'upstream' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return res.status(400).json({ error: 'bad_request' });

  const isGrade = body.mode === 'grade';
  let payload;
  if (isGrade) {
    const rubric = Array.isArray(body.rubric) ? body.rubric.slice(0, 12).map(x => str(x, 400)) : [];
    const answer = str(body.answer, 4000);
    if (!rubric.length || !answer.trim()) return res.status(400).json({ error: 'bad_request' });
    const prompt = `QUESTION:\n${str(body.question, 4000)}\n\nRUBRIC:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nSAMPLE ANSWER (for reference):\n${str(body.model, 3000)}\n\nSTUDENT ANSWER:\n${answer}`;
    payload = {
      systemInstruction: { parts: [{ text: GRADER }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 800, temperature: 0.2, responseMimeType: 'application/json' },
    };
  } else {
    const turns = clean(body.messages);
    if (!turns) return res.status(400).json({ error: 'bad_request' });
    const context = str(body.context, MAX_CONTEXT_CHARS);
    const system = RULES + (context ? `\n\nThe student is looking at this page right now (use it as context, do not repeat it back):\n${context}` : '');
    payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
      generationConfig: { maxOutputTokens: 900, temperature: 0.4 },
    };
  }

  const day = new Date().toISOString().slice(0, 10);
  resetDay(day);
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
  const visitorCount = state.visitors.get(ip) || 0;
  if (visitorCount >= PER_VISITOR_DAY) return res.status(429).json({ error: 'visitor_limit' });
  if (state.total >= PER_TOTAL_DAY) return res.status(429).json({ error: 'daily_limit' });
  if (!minuteOk()) return res.status(429).json({ error: 'busy' });

  let out;
  try { out = await gemini(payload); } catch { return res.status(502).json({ error: 'upstream' }); }
  if (out.error) return res.status(out.status).json({ error: out.error });

  state.visitors.set(ip, visitorCount + 1);
  state.total += 1;

  if (isGrade) {
    let parsed = null;
    try { parsed = JSON.parse(out.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.items)) return res.status(502).json({ error: 'upstream' });
    return res.status(200).json({ items: parsed.items, feedback: String(parsed.feedback || '') });
  }
  return res.status(200).json({ text: out.text, truncated: !!out.truncated });
};
