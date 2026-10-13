// A scripted Anthropic Messages API (and a Jev System One endpoint) for end-to-end tests: e2e.mjs
// points OpenCode 2's built-in `anthropic` provider at it, and components' Jev calls at
// `/v1/systemone` through TYPESAFE_ENDPOINT. Every request is appended to a JSONL log (method,
// path, headers, body). The script is either an array of model replies or
// `{ "model": [...], "jev": [...] }`; each reply is the next entry, else a plain text reply (and
// for Jev, a middling answer to every question: score 1, noul 0.1, the first choice). A model
// entry is one of
//   { "text": "..." }                                   a text reply
//   { "tool": "name", "input": { ... }, "text"?: "..." } a tool call (with optional text first)
//   { "status": 529, "error": "overloaded" }             an error response
//   { "headers": { ... }, ...one of the above }          extra response headers
//
//   node scripts/mock-anthropic.mjs --port 0 --log requests.jsonl --script script.json
// prints `listening <port>` once ready.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const log = arg('log', 'mock-requests.jsonl');
const scriptFile = arg('script');
const raw = scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, 'utf8')) : [];
const script = Array.isArray(raw) ? raw : (raw.model ?? []);
const jevScript = Array.isArray(raw) ? [] : (raw.jev ?? []);
let calls = 0;
let jevCalls = 0;

function jevAnswer(questions) {
  const scripted = jevScript[jevCalls++];
  const answers = {};
  for (const [id, q] of Object.entries(questions ?? {})) {
    if (scripted?.[id]) answers[id] = scripted[id];
    else if (q.type === 'score') answers[id] = { type: 'score', score: 1, confidence: 0.9 };
    else if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.1 };
    else if (q.type === 'choice') {
      const first = Object.keys(q.criteria ?? {})[0] ?? '';
      answers[id] = { type: 'choice', choice: first, probabilities: { [first]: 1 }, confidence: 1 };
    }
  }
  return { model: 'jev-mock', answers, usage: { input_tokens: 100 } };
}

function sse(res, events) {
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), method: req.method, path: req.url, headers: req.headers, body: parsed })}\n`);
    if (req.method === 'POST' && req.url?.includes('/systemone')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(jevAnswer(parsed?.questions)));
    }
    if (req.method !== 'POST' || !req.url?.includes('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: unknown route' } }));
    }
    const step = script[calls++] ?? { text: 'mock reply' };
    const extra = step.headers ?? {};
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json', ...extra });
      return res.end(JSON.stringify({ type: 'error', error: { type: step.error ?? 'api_error', message: step.error ?? 'mock error' } }));
    }
    const model = typeof parsed === 'object' && parsed?.model ? parsed.model : 'mock';
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: step.cacheRead ?? 0, cache_creation_input_tokens: step.cacheWrite ?? 0 };
    const events = [['message_start', { type: 'message_start', message: { id: `msg_${calls}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage } }]];
    let index = 0;
    if (step.text) {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: step.text } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
      index++;
    }
    if (step.tool) {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${calls}`, name: step.tool, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input ?? {}) } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    }
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }]);
    events.push(['message_stop', { type: 'message_stop' }]);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...extra });
    sse(res, events);
  });
});

server.listen(Number(arg('port', '0')), '127.0.0.1', () => console.log(`listening ${server.address().port}`));
