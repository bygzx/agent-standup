// test/omp.test.js: omp (Oh My Pi) sessions (omp.js) read as a call, next to a Claude Code session that must stay exactly as it was. The files are made up in the
// shape omp writes them (title slot, header, messages with their tool calls and results, a sub-agent in the folder named after the lead's file), copied from a real
// session. A real server on a free port.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'as-omp-')), OMP = path.join(tmp, 'agent'), ROOT = path.join(OMP, 'sessions'), PROJECTS = path.join(tmp, 'projects');
process.env.AGENT_STANDUP_PREFS = path.join(tmp, 'prefs.json'); process.env.AGENT_STANDUP_KOKORO_DIR = path.join(tmp, 'kokoro'); process.env.AGENT_STANDUP_PROJECTS = PROJECTS; process.env.AGENT_STANDUP_OMP = OMP;
const get = (port, p) => new Promise((res, rej) => http.get({ port, path: p }, (x) => { const b = []; x.on('data', (d) => b.push(d)); x.on('end', () => res({ status: x.statusCode, buf: Buffer.concat(b), json: () => JSON.parse(Buffer.concat(b).toString()) })); }).on('error', rej));
const serve = async () => { const srv = require('../server.js').start(0); await new Promise((r) => srv.once('listening', r)); return { port: srv.address().port, stop: () => { srv.close(); require('../server.js').shutdown(); } }; };

// ---- the files. The session started ten minutes ago and was last written two minutes ago; its sub-agent ran in between.
const NOW = Date.now(), START = NOW - 10 * 60e3, ASK = START + 1000, END = NOW - 2 * 60e3, SUB_START = START + 6000, SUB_END = START + 9000, WORK = path.join(os.homedir(), 'work', 'omp-shop');
const SID = '019feab8-0000-7000-8000-000000000001', SID2 = '019feab8-0000-7000-8000-000000000002', SID3 = '019feab8-0000-7000-8000-000000000003', BUCKET = path.join(ROOT, '-work-omp-shop');
const iso = (ms) => new Date(ms).toISOString(), file = (id) => path.join(BUCKET, '2026-10-24T21-00-00-000Z_' + id + '.jsonl');
const title = (t) => ({ type: 'title', v: 1, title: t, updatedAt: iso(START), pad: ' '.repeat(200) });
const header = (id, at, more = {}) => ({ type: 'session', version: 3, id, timestamp: iso(at), cwd: WORK, ...more });
const usage = (i, o, r, w = 0) => ({ input: i, output: o, cacheRead: r, cacheWrite: w, totalTokens: i + o + r + w, cost: { total: 0 } });
const user = (text, at, more = {}) => ({ type: 'message', id: 'u' + at, parentId: null, timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: +at, ...more } });
const say = (text, at, more = {}) => ({ type: 'message', id: 'a' + at, parentId: null, timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }], model: 'kimi-code/k3-256k', stopReason: 'stop', usage: usage(1000, 100, 4000), ...more } });
const think = (text, calls, at, more = {}) => ({ type: 'message', id: 't' + at, parentId: null, timestamp: iso(at), message: { role: 'assistant', model: 'kimi-code/k3-256k', stopReason: calls.length ? 'toolUse' : 'stop', usage: usage(500, 50, 2000), content: [{ type: 'thinking', thinking: text }, ...calls.map(([id, name, args], i) => ({ type: 'toolCall', id, name, arguments: args, ...(i === 0 ? {} : {}) }))], ...more } });
const result = (id, name, text, at, more = {}) => ({ type: 'message', id: 'r' + at, parentId: null, timestamp: iso(at), message: { role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: [{ type: 'text', text }], ...more } });

const TASK_ID = 'tool_cart_task', PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), BLOB = 'c'.repeat(64);
fs.mkdirSync(path.join(OMP, 'blobs'), { recursive: true }); fs.writeFileSync(path.join(OMP, 'blobs', BLOB), PNG);
const mainLines = [
  title('Fix the cart total'),
  header(SID, START, { title: 'Fix the cart total' }),
  { type: 'model_change', id: 'm1', parentId: null, timestamp: iso(START), model: 'kimi-code/k3-256k' },
  user('Why is the cart total wrong?', ASK),
  think('The total is computed in cart.js.\nI should run the tests first.', [['tool_cart_bash', 'bash', { command: 'npm test', i: 'Running the tests' }]], ASK + 1000),
  result('tool_cart_bash', 'bash', '1 failing\nboom', ASK + 2000, { isError: true }),
  think('', [['tool_cart_read', 'read', { path: 'src/cart.js' }], ['tool_cart_edit', 'edit', { i: 'Fix the total', input: '[src/cart.js#4F1C]\nPUT >3:\n-const total = 0;\n+const total = sum(items);\n' }],
    ['tool_cart_todo', 'todo', { op: 'init', list: [{ phase: 'Cart', items: ['Fix the total'] }] }],
    [TASK_ID, 'task', { i: 'Finding the total', context: '# Goal\nFind every place the cart total is computed.', tasks: [{ task: 'Find every place the cart total is computed.\nReport the files.', tools: [] }] }]], ASK + 3000),
  result('tool_cart_read', 'read', 'const total = 0;', ASK + 4000),
  result('tool_cart_edit', 'edit', 'replaced 1 occurrence', ASK + 4100),
  result('tool_cart_todo', 'todo', 'Remaining items (1): Fix the total [in_progress]', ASK + 4200, { details: { op: 'init', phases: [{ name: 'Cart', tasks: [{ content: 'Fix the total', status: 'in_progress' }] }] } }),
  result(TASK_ID, 'task', 'Spawned agent `Kid` (job `Kid`). Its result auto-delivers on yield.', ASK + 4300),
  { type: 'compaction', id: 'c1', parentId: null, timestamp: iso(SUB_END + 2000), summary: 'never shown' },
  { type: 'message', id: 'a-pic', parentId: null, timestamp: iso(SUB_END + 2500), message: { role: 'assistant', model: 'kimi-code/k3-256k', stopReason: 'toolUse', usage: usage(600, 60, 3000), content: [{ type: 'toolCall', id: 'tool_cart_pic', name: 'read', arguments: { path: 'shot.png' } }] } },
  result('tool_cart_pic', 'read', 'a picture', SUB_END + 3000, { content: [{ type: 'text', text: 'a picture' }, { type: 'image', data: 'blob:sha256:' + BLOB, mimeType: 'image/png' }] }),
  say('The total is fixed: it now sums the items.', END),
  { type: 'custom', customType: 'todo_hud_state', id: 'x1', parentId: null, timestamp: iso(END + 1), data: { phases: [] } },
];
const mainFile = file(SID); fs.mkdirSync(BUCKET, { recursive: true });
fs.writeFileSync(mainFile, mainLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.utimesSync(mainFile, END / 1000, END / 1000);
// the sub-agent: a session of its own in the folder named after the lead's file
const KID = 'Kid', KDIR = mainFile.replace(/\.jsonl$/, '');
const kidFile = path.join(KDIR, KID + '.jsonl'), kidLines = [
  { type: 'title', v: 1, title: '', updatedAt: iso(SUB_START), pad: '' },
  header('01a0ce06-0000-7000-8000-000000000009', SUB_START, { parentSession: mainFile }),
  { type: 'session_init', id: 'si1', parentId: null, timestamp: iso(SUB_START), systemPrompt: 'never shown', task: 'Find every place the cart total is computed.\nReport the files.', agent: 'explore' },
  user('Complete assignment thoroughly:\n\nFind every place the cart total is computed.\nReport the files.', SUB_START + 100),
  think('', [['tool_kid_grep', 'grep', { pattern: 'total', path: 'src' }]], SUB_START + 1000),
  result('tool_kid_grep', 'grep', 'cart.js:1\ncheckout.js:9', SUB_START + 2000),
  say('Two places: cart.js and checkout.js.', SUB_END),
];
fs.mkdirSync(KDIR, { recursive: true }); fs.writeFileSync(kidFile, kidLines.map((l) => JSON.stringify(l)).join('\n') + '\n'); fs.utimesSync(kidFile, SUB_END / 1000, SUB_END / 1000);
// a session at work right now, and one of yesterday: the board reads their end
const S2_AT = NOW - 60e3, s2 = [title('A session at work'), header(SID2, S2_AT), user('Look at the API', S2_AT), think('', [['tool_live_bash', 'bash', { command: 'sleep 10' }]], S2_AT + 1000)];
fs.writeFileSync(file(SID2), s2.map((l) => JSON.stringify(l)).join('\n') + '\n'); fs.utimesSync(file(SID2), (S2_AT + 1000) / 1000, (S2_AT + 1000) / 1000);
const OLD = NOW - 30 * 3600e3, s3 = [title('An older question, with no title'), header(SID3, OLD), user('An older question.', OLD), say('An older answer.', OLD + 1000)];
fs.writeFileSync(file(SID3), s3.map((l) => JSON.stringify(l)).join('\n') + '\n'); fs.utimesSync(file(SID3), (OLD + 1000) / 1000, (OLD + 1000) / 1000);
// what else omp keeps around a session, and a file that is not one
fs.writeFileSync(path.join(KDIR, '.Kid.jsonl.lock.os'), ''); fs.writeFileSync(path.join(KDIR, '3.bash.log'), 'a log\n'); fs.writeFileSync(path.join(BUCKET, 'not-a-session.jsonl'), '{"type":"message"}\n');
const claudeDir = path.join(PROJECTS, '-c'); fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'cc.jsonl'), [{ type: 'user', timestamp: iso(NOW - 3600e3), message: { role: 'user', content: 'a Claude Code order' } }, { type: 'assistant', timestamp: iso(NOW - 3599e3), message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'A Claude Code answer.' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n');

test('omp sessions are listed with their titles, sub-agents and folder; the Claude Code session is still there', async () => {
  const { port, stop } = await serve();
  try {
    const rows = (await get(port, '/api/sessions')).json(), o = rows.filter((r) => r.proj === '_omp');
    assert.deepEqual(o.map((r) => [r.id, r.title, r.source, r.agents]), [[SID2, 'A session at work', 'omp', 0], [SID, 'Fix the cart total', 'omp', 1], [SID3, 'An older question, with no title', 'omp', 0]]);
    assert.equal(o[1].project, 'omp · work/omp-shop');
    assert.deepEqual(rows.filter((r) => r.proj === '-c').map((r) => [r.id, r.title, r.source]), [['cc', 'a Claude Code order', undefined]]);
    const board = (await get(port, '/api/board')).json(), b = board.find((r) => r.id === SID);
    assert.deepEqual([b.proj, b.state, b.subTotal, b.source, b.title, b.asked, b.dir], ['_omp', 'turn', 1, 'omp', 'Fix the cart total', ASK, WORK.replace(/[^a-zA-Z0-9]/g, '-')]);
    assert.ok(!board.some((r) => r.id === SID3), 'a session of yesterday is not on the board');
    assert.deepEqual((({ state, tool, source }) => [state, tool, source])(board.find((r) => r.id === SID2)), ['working', 'Bash', 'omp']);   // the last thing written is a call still out
  } finally { stop(); }
});

test('an omp session becomes the same events as a Claude Code one: lines, tools with their results, an inner thought, a sub-agent with its order and its report, usage', async () => {
  const { port, stop } = await serve();
  try {
    const tl = (await get(port, `/api/session?proj=_omp&id=${SID}`)).json(), ev = tl.events, real = ev.filter((e) => e.kind !== 'usage');
    assert.deepEqual(tl.agents.map((a) => [a.id, a.type, a.role, a.own, a.toolUseId]), [['main', 'main', 'Lead', undefined, undefined], [KID, 'Kid', 'Find every place the cart total is computed', 'Kid', TASK_ID]]);
    assert.deepEqual(real.map((e) => e.agent + ' ' + e.kind), ['user user', 'main tools', 'main results', 'main tools', 'main order', 'main results', 'main results', 'main tasks', KID + ' tools', KID + ' results', KID + ' report', 'main compact', 'main tools', 'main results', 'main say']);
    assert.deepEqual(real[7].items, [{ id: '0', c: 'Fix the total', s: 'in_progress' }]);   // the whole todo list as omp last showed it
    assert.equal(real[0].text, 'Why is the cart total wrong?');
    assert.equal(real[6].items[0].out, 'replaced 1 occurrence');
    assert.deepEqual(real[1].tools.map((t) => [t.name, t.arg]), [['Bash', 'npm test']]);
    assert.deepEqual(real[2].items, [{ id: 'tool_cart_bash', err: true, out: '1 failing\nboom' }]);
    const calls = real[3].tools.map((t) => [t.name, t.arg]);
    assert.deepEqual(calls, [['Read', 'src/cart.js'], ['Edit', 'src/cart.js'], ['TodoWrite', '']]);
    assert.deepEqual([real[4].to, real[4].toolId, real[4].text, real[4].title], [KID, TASK_ID, 'Find every place the cart total is computed.\nReport the files.', 'Finding the total']);
    assert.deepEqual([real[10].text, real[10].to], ['Two places: cart.js and checkout.js.', 'main']);
    assert.deepEqual([real[14].text, real[14].end], ['The total is fixed: it now sums the items.', 1]);
    assert.deepEqual([real[12].tools[0].name, real[13].items[0].img], ['Read', 1]);   // the picture came back: the page fetches it from /api/media
    const u = ev.filter((e) => e.kind === 'usage'), sum = (k) => u.reduce((n, e) => n + e.u[k], 0), last = u[u.length - 1];
    assert.deepEqual([sum('i'), sum('o'), sum('r'), last.model], [4100, 410, 17000, 'kimi-code/k3-256k']);
    // the thought that came with the first call is an inner thought on it
    assert.equal(real[1].th, 'The total is computed in cart.js.\nI should run the tests first.');
    // the times are the ones omp wrote: the sub-agent is at its own, its order when the lead called it
    assert.ok(ev.every((e, i) => e.ts >= START - 1 && e.ts <= END + 5 && (!i || e.ts >= ev[i - 1].ts)), 'in order, inside the session');
    assert.equal(real[4].ts, ASK + 3000); assert.equal(real[10].ts, SUB_END);
  } finally { stop(); }
});

test('the live call follows an omp session: a new step arrives alone and leaves the earlier times alone', async () => {
  const { port, stop } = await serve(), wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const add = (lines) => fs.appendFileSync(mainFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const first = (await get(port, `/api/session?proj=_omp&id=${SID}`)).json(), before = new Map(first.events.map((e) => [e.k, e.ts]));
    const at = Date.now(); add([user('And the tax?', at), think('Checking the tax.', [['tool_tax_bash', 'bash', { command: 'grep tax -r .' }]], at + 500)]);
    await wait(2100);   // the lists are remembered for two seconds
    const cur0 = (await get(port, '/api/current?proj=' + WORK.replace(/[^a-zA-Z0-9]/g, '-'))).json(); assert.deepEqual([cur0.proj, cur0.id], ['_omp', SID]);
    assert.equal((await get(port, '/api/board')).json().find((r) => r.id === SID).state, 'working');   // a call is out: the agent is at work
    const more = (await get(port, `/api/session?proj=_omp&id=${SID}&after=${first.seq}&ep=${first.ep}`)).json(), fresh = more.events.filter((e) => !before.has(e.k) && e.kind !== 'usage');
    assert.deepEqual(fresh.map((e) => e.agent + ' ' + e.kind + ' ' + (e.text || e.tools[0].name)), ['user user And the tax?', 'main tools Bash']);
    assert.ok(fresh.every((e) => e.ts >= at && e.ts <= Date.now() + 1000), 'the new step is dated when it was written');
    const again = (await get(port, `/api/session?proj=_omp&id=${SID}`)).json(); for (const e of again.events) if (before.has(e.k) && e.kind !== 'usage') assert.equal(e.ts, before.get(e.k), 'an event already shown keeps its time: ' + e.k);
  } finally { stop(); }
});

test('a picture of an omp session comes back from /api/media, from a blob in the agent folder', async () => {
  const { port, stop } = await serve();
  try {
    const im = await get(port, `/api/media?proj=_omp&id=${SID}&agent=tool_cart_pic&n=0&tool=tool_cart_pic`);
    assert.equal(im.status, 200); assert.equal(im.buf.toString('latin1', 1, 4), 'PNG'); assert.ok(im.buf.equals(PNG));
    assert.equal((await get(port, `/api/media?proj=_omp&id=${SID}&agent=tool_cart_pic&n=1&tool=tool_cart_pic`)).status, 404);
  } finally { stop(); }
});

test('an order megabytes back still dates the session: the board reads the end of a file backwards when it has to', async () => {
  const omp = require('../omp.js'), wait = (ms) => new Promise((r) => setTimeout(r, ms)), id = '019feab8-0000-7000-8000-000000000004', at = NOW - 5 * 60e3, f = path.join(BUCKET, '2026-10-24T23-00-00-000Z_' + id + '.jsonl');
  const big = 'x'.repeat(400 * 1024);
  fs.writeFileSync(f, [title('A long build'), header(id, at), user('Run the long build', at), think('', [['tool_big_bash', 'bash', { command: 'make' }]], at + 1000), result('tool_big_bash', 'bash', big, at + 2000)].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(f, (at + 2000) / 1000, (at + 2000) / 1000);
  try {
    await wait(2100);   // the list of files is remembered for two seconds
    const b = omp.boardRow(omp.row(id), Date.now());
    assert.deepEqual([b.state, b.tool, b.asked], ['working', 'Bash', at]);   // 400 KB of output after the order: still the order that dates the session
  } finally { fs.rmSync(f, { force: true }); await wait(2100); }
});

test('a session waiting on an omp question needs you on the board, with the question', async () => {
  const omp = require('../omp.js'), wait = (ms) => new Promise((r) => setTimeout(r, ms)), id = '019feab8-0000-7000-8000-000000000005', at = NOW - 2 * 60e3, f = path.join(BUCKET, '2026-10-25T00-00-00-000Z_' + id + '.jsonl');
  fs.writeFileSync(f, [title('Pick a database'), header(id, at - 180e3), user('Set up the database', at - 180e3), think('', [['tool_ask', 'ask', { i: 'Choosing a database', questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }]], at)].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(f, at / 1000, at / 1000);
  try {
    await wait(2100);   // the list of files is remembered for two seconds
    const b = omp.boardRow(omp.row(id), Date.now());
    assert.deepEqual([b.state, b.tool, b.sure, b.ask, b.since], ['blocked', '', 1, 'Which database?', at]);   // the question tool is still out: it needs you, as a Claude Code menu does
  } finally { fs.rmSync(f, { force: true }); await wait(2100); }
});

test('omp can be turned off, and is not looked for when the app is pointed at one folder of Claude Code sessions', () => {
  const omp = require('../omp.js'), keep = process.env.AGENT_STANDUP_OMP, wait = () => { const t = Date.now(); while (Date.now() - t < 2050) {} };
  try {
    assert.equal(omp.sessions().length, 3);
    process.env.AGENT_STANDUP_OMP = 'off'; wait(); assert.equal(omp.home(), null); assert.equal(omp.sessions().length, 0); assert.equal(omp.fileOf(SID), null);
    delete process.env.AGENT_STANDUP_OMP; wait(); assert.equal(omp.home(), null, 'AGENT_STANDUP_PROJECTS is set: only what is asked for is read');
    const projects = process.env.AGENT_STANDUP_PROJECTS; delete process.env.AGENT_STANDUP_PROJECTS; process.env.PI_CODING_AGENT_DIR = '/somewhere/agent'; assert.equal(omp.home(), '/somewhere/agent'); delete process.env.PI_CODING_AGENT_DIR; process.env.AGENT_STANDUP_PROJECTS = projects;
  } finally { process.env.AGENT_STANDUP_OMP = keep; }
});

test('a session of omp the reader does not expect costs that session at most: the other sessions, of every tool, are still listed', async () => {
  const odd = path.join(BUCKET, '2026-10-24T22-00-00-000Z_odd.jsonl');
  fs.writeFileSync(odd, [header('odd', NOW - 60e3), { type: 'message' }, { type: 'message', id: 1, message: null }, 'not json', { type: 'message', id: 'z', timestamp: iso(NOW - 60e3), message: { role: 'assistant', stopReason: 'stop', content: 'text instead of blocks' } }].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const { port, stop } = await serve(), wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(2100);
    const list = await get(port, '/api/sessions'), board = await get(port, '/api/board');
    assert.deepEqual([list.status, board.status], [200, 200]);
    const rows = list.json(); assert.ok(rows.some((r) => r.proj === '-c' && r.id === 'cc')); assert.ok(rows.some((r) => r.id === SID) && rows.some((r) => r.id === SID2), 'the sound omp sessions');
    const one = await get(port, '/api/session?proj=_omp&id=odd'); assert.equal(one.status, 200); assert.ok(Array.isArray(one.json().events), 'what can be read of a session with odd records is shown');
      } finally { stop(); fs.rmSync(odd, { force: true }); }
});
