// omp (Oh My Pi, the `omp` command) sessions shown as the same call as Claude Code sessions.
// omp keeps one JSONL file per session: <agent dir>/sessions/<encoded cwd>/<time>_<session id>.jsonl. The first line is a fixed-width title slot
// ({type:"title"}), the second the session header ({type:"session", cwd, id, parentSession}). Every other line is a SessionEntry: a message (user,
// assistant, toolResult), a compaction, a title change… An assistant message carries its thinking, its text and its tool calls in one record; the
// result of each call is a toolResult message that names the call. A sub-agent is a session of its own, in the folder named after the lead's file
// (<file without .jsonl>/<name>.jsonl), its header naming the lead in parentSession. Nothing is ever written there.
// server.js reads the files with its own incremental reader and hands each record to parser() below, which turns it into the events a Claude Code
// record gives, so everything after that is shared. All omp sessions are listed under one made-up project, PROJ.
const fs = require('fs'), os = require('os'), path = require('path');
const PROJ = '_omp', SOURCE = 'omp';
// Where omp keeps its sessions: AGENT_STANDUP_OMP (the agent folder, the one that holds sessions/; "0" or "off" turns omp sessions off),
// else $PI_CODING_AGENT_DIR, else $XDG_DATA_HOME/omp once `omp config init-xdg` has moved them there, else ~/.omp/agent.
// When AGENT_STANDUP_PROJECTS points the app at one folder of Claude Code sessions (--projects, the tests), omp is only read if it is asked for too.
function agentDirs() {   // every agent folder whose sessions are read: the default profile, and the ones `omp --profile` keeps beside it
  const v = process.env.AGENT_STANDUP_OMP;
  if (v != null) return /^(0|off|no|false)?$/i.test(v.trim()) ? [] : [path.resolve(v)];
  if (process.env.AGENT_STANDUP_PROJECTS) return [];
  if (process.env.PI_CODING_AGENT_DIR) return [path.resolve(process.env.PI_CODING_AGENT_DIR)];
  if (process.platform === 'linux' || process.platform === 'darwin') {   // `omp config init-xdg` moves the folders there
    const x = process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'omp');
    if (x && stat(x)) return [x];
  }
  const base = path.join(os.homedir(), '.omp'), out = [path.join(base, 'agent')];
  try { for (const d of fs.readdirSync(path.join(base, 'profiles'), { withFileTypes: true })) if (d.isDirectory() && /^[\w.\-]+$/.test(d.name)) out.push(path.join(base, 'profiles', d.name, 'agent')); } catch {}
  return out;
}
const home = () => agentDirs()[0] || null;
const dirKey = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');   // the name Claude Code gives the same folder: how "this project" is asked for everywhere else
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };

// ---- the first lines of a file: the current title and the header
const headCache = new Map();   // file → { sig, v } (a rename rewrites the title slot in place, size unchanged, so the signature holds the date too)
const NO_HEAD = { ok: false, id: '', cwd: '', title: '', parent: '', lines: 0 };
function head(file, st) {
  const sig = st ? st.mtimeMs + ':' + st.size : '', c = headCache.get(file); if (c && c.sig === sig) return c.v;
  let text = ''; try { const fd = fs.openSync(file, 'r'); try { const buf = Buffer.alloc(Math.min(32 * 1024, st ? Math.max(1, st.size) : 32 * 1024)), n = fs.readSync(fd, buf, 0, buf.length, 0); text = buf.toString('utf8', 0, n); } finally { fs.closeSync(fd); } } catch {}
  const v = { ...NO_HEAD }; let header = null, title = '';
  for (const l of text.split('\n')) {
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch { break; }   // a line still being written: the header may not be there yet
    if (!j || typeof j !== 'object') break;
    if (j.type === 'title') { if (typeof j.title === 'string') title = j.title.trim(); v.lines++; continue; }
    if (j.type === 'session') { header = j; break; }
    v.lines++; if (v.lines > 8) break;
  }
  if (header && typeof header.id === 'string' && header.id) v.ok = true, v.id = header.id, v.cwd = typeof header.cwd === 'string' ? header.cwd : '', v.parent = typeof header.parentSession === 'string' ? header.parentSession : '', v.title = title || (typeof header.title === 'string' ? header.title.trim() : '');
  if (v.ok || st == null) { if (headCache.size > 5000) headCache.clear(); headCache.set(file, { sig, v }); }   // a file still being written is looked at again
  return v;
}

// ---- finding the sessions
let memo = { at: 0, home: undefined, rows: [], byId: new Map() };
function scan() {   // every session file with the date and size of its journal, newest first; shared by all the polls of two seconds
  const h = home(), now = Date.now(); if (memo.home === h && now - memo.at < 2000) return memo;
  const byId = new Map();
  for (const dir of agentDirs()) {
    const root = path.join(dir, 'sessions');
    let buckets = []; try { buckets = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const b of buckets) {
      if (!b.isDirectory() || b.name.startsWith('.')) continue;   // a session's own folder sits inside its file's name, never in the bucket itself
      let names = []; try { names = fs.readdirSync(path.join(root, b.name), { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;   // a lock, a rewrite in progress (.name.jsonl.<id>.tmp)
        const file = path.join(root, b.name, e.name), st = stat(file); if (!st) continue;
        const hd = head(file, st); if (!hd.ok) continue;
        const row = { id: hd.id, file, home: dir, dir: b.name, mtime: st.mtimeMs, size: st.size, cwd: hd.cwd };
        const was = byId.get(row.id); if (was) { if (was.mtime >= row.mtime) continue; }   // a copy of one session in two files: the one being written
        byId.set(row.id, row);
      }
    }
  }
  const rows = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
  memo = { at: now, home: h, rows, byId }; return memo;
}
const row = (id) => scan().byId.get(String(id)) || null;
const fileOf = (id) => { let r = row(id); if (r && !stat(r.file)) { memo.at = 0; r = row(id); } return r ? r.file : null; };   // a file that is gone (omp moved a session to a sibling): looked for again at once
const cwd = (id) => { const r = row(id); return r ? r.cwd : ''; };
const under = (cwd, key) => { for (let d = String(cwd || ''); d;) { if (dirKey(d) === key) return true; const up = path.dirname(d); if (up === d) return false; d = up; } return false; };   // key is the folder itself or one above it: a dashed name alone cannot tell app/old (inside app) from app-old (beside it)
const inProject = (id, key) => { const r = row(id); if (!r || !key) return false; if (key === PROJ) return true; const d = dirKey(r.cwd); return d === key || (d.startsWith(key + '-') && under(r.cwd, key)); };
const projectLabel = (cwd) => { const h = os.homedir(), rel = cwd && cwd.startsWith(h + path.sep) ? cwd.slice(h.length + 1) : cwd; return 'omp' + (rel ? ' · ' + rel.split(path.sep).join('/') : ''); };
// The sessions a person started, newest first, each with the folder it was started in.
const sessions = (limit = 80) => scan().rows.slice(0, limit).map((r) => ({ ...r, key: dirKey(r.cwd) }));

// ---- names: the title omp shows (the fixed-width slot, else the header), else the first thing the person typed
const promptCache = new Map();   // file → the first prompt ('' = looked for in the first megabyte and not there)
const typed = (m) => (Array.isArray(m && m.content) ? m.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
function firstPrompt(r) {
  const hit = promptCache.get(r.file); if (hit != null) return hit;
  let text = ''; try { const fd = fs.openSync(r.file, 'r'); try { const buf = Buffer.alloc(Math.min(1024 * 1024, r.size)); fs.readSync(fd, buf, 0, buf.length, 0); text = buf.toString('utf8'); } finally { fs.closeSync(fd); } } catch {}
  let out = '';
  for (const l of text.split('\n')) {
    if (!l.includes('"role":"user"') || l.includes('"attribution":"agent"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j && j.type === 'message' && j.message && j.message.role === 'user') { const t = typed(j.message); if (t && t[0] !== '<') { out = t.replace(/\s+/g, ' ').slice(0, 90); break; } }
  }
  if (out || r.size > 64 * 1024) { if (promptCache.size > 2000) promptCache.clear(); promptCache.set(r.file, out); }   // a file that has just been created is looked at again
  return out;
}
const title = (r) => head(r.file, { mtimeMs: r.mtime, size: r.size }).title || firstPrompt(r) || r.id;

// ---- sub-agents: the sessions in <file without .jsonl>/, each tied to the task call that spawned it
const linkCache = new Map();   // main file → { sig, offset, tail, calls, spawned, map }: read once, then by what was appended
function linkTasks(st, id) {   // a task call and the answer that named its agents ("Spawned agent `Name`") say which folder is whose
  const tasks = st.calls.get(id), names = st.spawned.get(id); if (!tasks || !names) return;
  tasks.forEach((text, i) => { const name = names[i]; if (name) st.map.set(name, { toolId: i ? id + ':' + i : id, text: text || '' }); });
}
function collect(line, st) {
  if (line.includes('"name":"task"') && line.includes('"toolCall"')) {
    let j; try { j = JSON.parse(line); } catch { return; }
    const m = j && j.message; if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b || b.type !== 'toolCall' || b.name !== 'task' || typeof b.id !== 'string') continue;
      const tasks = b.arguments && Array.isArray(b.arguments.tasks) ? b.arguments.tasks : [];
      st.calls.set(b.id, tasks.map((t) => (t && typeof t.task === 'string' ? t.task : ''))); linkTasks(st, b.id);
    }
    return;
  }
  if (line.includes('"role":"toolResult"') && line.includes('Spawned agent')) {
    let j; try { j = JSON.parse(line); } catch { return; }
    const m = j && j.message; if (!m || m.role !== 'toolResult' || typeof m.toolCallId !== 'string' || !Array.isArray(m.content)) return;
    const text = m.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    const names = [...text.matchAll(/Spawned agent `([^`\n]+)`/g)].map((x) => x[1]); if (!names.length) return;
    st.spawned.set(m.toolCallId, names); linkTasks(st, m.toolCallId);
  }
}
function taskLinks(r) {   // name of a sub-agent's session folder → the call that launched it, and what it was asked
  const sig = r.mtime + ':' + r.size, hit = linkCache.get(r.file); if (hit && hit.sig === sig) return hit.map;
  const st = hit && r.size >= hit.offset ? hit : { sig: '', offset: 0, tail: Buffer.alloc(0), calls: new Map(), spawned: new Map(), map: new Map() };
  while (st.offset < r.size) {
    let buf; try { const fd = fs.openSync(r.file, 'r'); try { buf = Buffer.alloc(Math.min(8 * 1024 * 1024, r.size - st.offset)); fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { fs.closeSync(fd); } } catch { break; }
    if (!buf.length) break;
    st.offset += buf.length;
    const all = st.tail.length ? Buffer.concat([st.tail, buf]) : buf, cut = all.lastIndexOf(10);
    if (cut < 0) { st.tail = all; continue; }
    st.tail = Buffer.from(all.subarray(cut + 1));
    for (const line of all.subarray(0, cut).toString('utf8').split('\n')) if (line) collect(line, st);
  }
  st.sig = sig; if (linkCache.size > 200) linkCache.clear(); linkCache.set(r.file, st); return st.map;
}
const brief = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); const m = /^(.{8,70}?)[.!?](\s|$)/.exec(t); if (m) return m[1]; if (t.length <= 56) return t; const cut = t.slice(0, 56), sp = cut.lastIndexOf(' '); return (sp > 30 ? cut.slice(0, sp) : cut) + '…'; };
function subFiles(id) {
  const out = []; out.dirs = []; out.journals = []; const r = row(id); if (!r) return out;
  const folder = r.file.replace(/\.jsonl$/, ''); if (!stat(folder)) return out;
  out.dirs.push(folder);
  let names = []; try { names = fs.readdirSync(folder, { withFileTypes: true }); } catch { return out; }
  const links = taskLinks(r);
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;
    const file = path.join(folder, e.name), st = stat(file); if (!st) continue;
    const aid = e.name.slice(0, -6), link = links.get(aid);
    out.push({ file, aid, id0: aid, run: '', mtime: st.mtimeMs, meta: { agentType: aid, description: brief(link && link.text) || aid, ...(link ? { toolUseId: link.toolId } : {}) } });   // omp names its agents; the folder carries the name
  }
  return out;
}

// ---- the board: is the agent in the middle of a turn, or is it the person's turn? Read from the end of the file, as omp's own session list does.
const TOOL_NAME = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', grep: 'Grep', glob: 'Glob', todo: 'TodoWrite', ask: 'AskUserQuestion', web_search: 'WebSearch', fetch_content: 'WebFetch', task: 'Task' };
const TAIL = 256 * 1024, tailCache = new Map();
function askedIn(text) {   // the newest order in a window of a file
  let out = 0;
  for (const l of text.split('\n')) {
    if (!l.includes('"role":"user"') || l.includes('"attribution":"agent"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(j && j.timestamp) || 0; if (j && j.message && j.message.role === 'user' && ts > out) out = ts;
  }
  return out;
}
function lastTyped(r, max = 4 * 1024 * 1024) {   // the last order: read backwards, a few megabytes at most, once
  let fd; try { fd = fs.openSync(r.file, 'r'); } catch { return 0; }
  try {
    for (let end = r.size; end > 0 && r.size - end < max;) {
      const start = Math.max(0, end - 512 * 1024), buf = Buffer.alloc(end - start), text = (fs.readSync(fd, buf, 0, buf.length, start), buf.toString('utf8'));
      const ts = askedIn(start ? text.slice(Math.max(0, text.indexOf('\n') + 1)) : text);   // the first line of a chunk may be cut: skipped
      if (ts) return ts; end = start;
    }
  } finally { fs.closeSync(fd); }
  return 0;
}
function classify(m, calls, at) {   // a call still out (or an answer cut short) is at work; anything else gives the turn back
  const stop = String(m.stopReason || ''), c = calls[calls.length - 1];
  const ask = c && c.name === 'ask' && c.arguments && Array.isArray(c.arguments.questions) && c.arguments.questions[0] ? String(c.arguments.questions[0].question || c.arguments.questions[0].title || '').slice(0, 200) : '';
  return { last: stop === 'aborted' || stop === 'error' ? 'turn' : calls.length || stop === 'length' ? 'working' : 'turn', tool: c ? (TOOL_NAME[c.name] || String(c.name || '')) : '', ...(ask ? { ask, since: at } : {}) };   // ask: omp's question tool waits for the person, like Claude Code's menu
}
function turnIn(text) {   // the last message that can be read whole in a window; a single output can be megabytes long and only its own line holds it
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]; if (!l.includes('"type":"message"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const m = j && j.message; if (!m || typeof m !== 'object') continue;
    const calls = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'toolCall') : [];
    if (m.role === 'assistant') return classify(m, calls, Date.parse(j.timestamp) || 0);
    if (m.role === 'toolResult') return { last: 'working', tool: TOOL_NAME[m.toolName] || (typeof m.toolName === 'string' ? m.toolName : '') };
    if (m.role === 'user' && m.attribution !== 'agent') return { last: 'working', tool: '' };
  }
  return null;
}
function lastTurn(r, asked, max = 2 * 1024 * 1024) {   // the same, reading backwards, for a tail that holds only the middle of a long output
  let fd; try { fd = fs.openSync(r.file, 'r'); } catch { return null; }
  try {
    let turn = null;
    for (let end = r.size; end > 0 && r.size - end < max;) {
      const start = Math.max(0, end - 512 * 1024), buf = Buffer.alloc(end - start), text = (fs.readSync(fd, buf, 0, buf.length, start), buf.toString('utf8'));
      if (!asked) { const ts = askedIn(text); if (ts) asked = ts; }
      if (!turn) turn = turnIn(text);
      if (turn && asked) return turn;
      end = start;
    }
    return turn;
  } finally { fs.closeSync(fd); }
}
function boardRow(r, now) {
  const sig = r.mtime + ':' + r.size; let t = tailCache.get(r.file);
  if (!t || t.sig !== sig) {
    t = { sig, asked: (t && t.asked) || 0, last: '', tool: '' };   // asked is kept: a long session's last order may be long out of the tail
    let text = ''; try { const fd = fs.openSync(r.file, 'r'); try { const n = Math.min(TAIL, r.size), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, r.size - n); text = buf.toString('utf8'); } finally { fs.closeSync(fd); } } catch {}
    const near = askedIn(text); if (near > t.asked) t.asked = near;
    const turn = turnIn(text) || lastTurn(r, t.asked); if (turn) { t.last = turn.last; t.tool = turn.tool; if (turn.ask) { t.ask = turn.ask; t.since = turn.since; } }
    if (!t.asked) t.asked = lastTyped(r);
    if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value); tailCache.set(r.file, t);
  }
  const age = now - r.mtime, asking = !!t.ask && age < 4 * 3600e3, state = asking ? 'blocked' : age >= 30 * 60e3 ? 'idle' : t.last === 'turn' ? 'turn' : t.last === 'working' && age < 10 * 60e3 ? 'working' : 'idle';   // a question left open is still open: four hours, as a Mistral Vibe one
  let subTotal = 0, subActive = 0;
  for (const x of subFiles(r.id)) { subTotal++; if (now - (x.mtime || 0) < 90e3) subActive++; }
  return { proj: PROJ, id: r.id, title: title(r), mtime: r.mtime, state, tool: state === 'working' ? t.tool : '', ageMs: age, subActive, subTotal, asked: t.asked || 0, dir: dirKey(r.cwd), source: SOURCE, ...(asking ? { ask: t.ask, since: t.since || r.mtime, sure: 1 } : {}) };
}

// ---- one record of a session file → the events of the call
function parser({ toolLabel, clip, clipOut = clip, resultMax = {} }) {
  const NO_RESULT = new Set(['Task', 'TodoWrite', 'Wait', 'wait']);
  const pathOf = (p) => { const s = String(p == null ? '' : p); const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s); return m ? { file_path: m[1], offset: +m[2], limit: m[3] ? +m[3] - +m[2] + 1 : undefined } : { file_path: s }; };   // omp names a slice of a file as "path:12-40"
  const edited = (input, fallback) => { const m = /^\[(.*?)#[0-9A-Fa-f]+\]/.exec(String(input || '')); return m ? m[1] : String(fallback || ''); };   // an edit's own header names the file: [src/a.ts#4F1C]
  const mapped = (name, a) => {   // the call as the screen knows it (toolLabel)
    const args = a && typeof a === 'object' ? a : {};
    switch (name) {
      case 'bash': return ['Bash', { command: args.command, description: args.i }];
      case 'read': return ['Read', pathOf(args.path)];
      case 'write': return ['Write', { file_path: args.path, content: typeof args.content === 'string' ? args.content : JSON.stringify(args.content) }];   // a device written with an object (a JSON body, a call) shows its text
      case 'edit': return ['Edit', { file_path: edited(args.input, args.path), old_string: '', new_string: typeof args.input === 'string' ? args.input : '' }];
      case 'grep': return ['Grep', { pattern: args.pattern, path: args.path }];
      case 'glob': return ['Glob', { pattern: args.path }];
      case 'ask': return ['AskUserQuestion', { questions: Array.isArray(args.questions) ? args.questions.map((q) => ({ question: (q && (q.question || q.title)) || '', options: (q && Array.isArray(q.options) && q.options) || [] })) : [] }];
      case 'web_search': return ['WebSearch', { query: args.query || (Array.isArray(args.queries) ? args.queries[0] : '') }];
      case 'fetch_content': return ['WebFetch', { url: args.url || (Array.isArray(args.urls) ? args.urls[0] : '') }];
      case 'todo': {   // the whole list, or the items an update names: TodoWrite shows it
        const items = [];
        for (const l of Array.isArray(args.list) ? args.list : []) for (const it of Array.isArray(l && l.items) ? l.items : []) items.push({ content: String(it), status: 'pending' });
        for (const it of Array.isArray(args.items) ? args.items : []) items.push({ content: String(it), status: 'pending' });
        if (typeof args.task === 'string' && !items.some((x) => x.content === args.task)) items.push({ content: args.task, status: /^(init|start|done|update|remove)$/.test(String(args.op)) ? ({ done: 'completed', start: 'in_progress' }[args.op] || 'pending') : 'pending' });
        return ['TodoWrite', { todos: items.slice(0, 20) }];
      }
      default: return [name, args];
    }
  };
  return function record(st, r) {
    if (!r || typeof r !== 'object') return;
    const agent = st.agent, cx = st.cx || (st.cx = { last: 0 });
    const at = r.message && Number(r.message.timestamp);
    const ts = Math.max(Date.parse(r.timestamp) || 0, Number.isFinite(at) ? at : 0, st.lastTs || 0); st.lastTs = ts;   // a line without a time takes the last one
    const push = (e) => { e.k = agent + ':' + st.raw.length; st.raw.push(e); if (e.ts > cx.last) cx.last = e.ts; return e; };
    const th = () => { const t = st.th; st.th = ''; return t ? { th: t } : {}; };
    if (r.type === 'compaction') { push({ ts, agent, kind: 'compact' }); return; }
    if (r.type !== 'message' || !r.message || typeof r.message !== 'object') return;
    const m = r.message, content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    if (m.role === 'user' || m.role === 'fileMention' || m.role === 'developer') {
      if (m.role !== 'user' || (m.attribution && m.attribution !== 'user')) return;
      const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
      if (!text || /^<(system-reminder|system-notice|system-directive|command-|local-command|task-notification)/.test(text)) return;
      if (agent !== 'main') { if (!st.prompt) st.prompt = { ts, text }; return; }   // a sub-agent's first user message is its assignment, shown from the call that launched it
      if (st.out) st.out.clear();
      const pics = content.filter((b) => b && b.type === 'image').length;
      push({ ts, agent: 'user', kind: 'user', text, ...(pics && typeof r.id === 'string' && /^[\w.\-]{6,200}$/.test(r.id) ? { img: pics, iid: r.id } : {}) });
      return;
    }
    if (m.role === 'toolResult') {
      const id = String(m.toolCallId || ''), n = id && st.toolName[id];
      if (n === 'TodoWrite' && m.details && Array.isArray(m.details.phases)) {   // omp's own answer holds the whole todo list, phases and all: the screen shows it as it stands
        const items = [];
        for (const ph of m.details.phases) for (const t of Array.isArray(ph && ph.tasks) ? ph.tasks : []) items.push({ id: String(items.length), c: clip(t && t.content, 120), s: clip((t && t.status) || 'pending', 20) });
        if (items.length) push({ ts, agent, kind: 'tasks', items: items.slice(0, 50) });
      }
      if (!n || NO_RESULT.has(n)) return;
      const out = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trimEnd();
      const img = content.filter((b) => b && b.type === 'image').length;
      push({ ts, agent, kind: 'results', items: [{ id, err: !!m.isError, out: clipOut(out, resultMax[n] || (/^mcp__/.test(n) ? 900 : 600)), ...(img ? { img } : {}) }] });
      return;
    }
    if (m.role !== 'assistant') return;
    if (m.usage && typeof m.usage === 'object') {   // what each model call used: one entry per call, under the provider's own id
      const u = m.usage, mid = String(m.responseId || r.id || 'o' + st.raw.length);
      st.msgUsage.set(mid, { ts, u: { i: +u.input || 0, o: +u.output || 0, r: +u.cacheRead || 0, w: +u.cacheWrite || 0 }, model: typeof m.model === 'string' ? m.model : '' });
    }
    let said = null;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) st.th = clip(b.thinking.replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\n ]*/g, '\n').trim(), 900);
      else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { said = push({ ts, agent, kind: 'say', text: b.text.trim(), ...th() }); st.act = st.raw.length - 1; }
      else if (b.type === 'toolCall' && typeof b.id === 'string') {
        const name = String(b.name || ''), args = b.arguments && typeof b.arguments === 'object' ? b.arguments : {};
        if (name === 'task') {   // one order per agent it starts: the folder of the sub-agent sessions names them
          const tasks = Array.isArray(args.tasks) ? args.tasks : [];
          if (!tasks.length) { st.toolName[b.id] = 'Task'; push({ ts, agent, kind: 'agentcall', toolId: b.id, bg: true, text: String(args.context || ''), title: String(args.i || 'task'), ...th() }); }
          tasks.forEach((t, i) => { const tid = i ? b.id + ':' + i : b.id; st.toolName[tid] = 'Task'; push({ ts, agent, kind: 'agentcall', toolId: tid, bg: true, text: String((t && t.task) || ''), title: String((t && t.name) || args.i || 'task'), ...(t && typeof t.name === 'string' && t.name ? { nm: t.name } : {}), ...th() }); });
          st.act = st.raw.length - 1; continue;
        }
        const [label, input] = mapped(name, args), tool = toolLabel({ id: b.id, name: label, input }, ts);
        st.toolName[b.id] = label;
        if (name === 'eval' || name === 'hub' || name === 'wait') {   // the tools Claude Code has no name for: a line of their own, with what they were asked
          tool.d = { kind: 'text', what: 'mcp', v: 'omp · ' + name, text: clip((args.title ? args.title + '\n' : '') + String(args.code || args.op || ''), 400) };
          tool.arg = clip(args.title || args.i || args.op || (Array.isArray(args.ids) ? args.ids.join(', ') : ''), 90);
        }
        push({ ts, agent, kind: 'tool', tool, ...th() }); st.act = st.raw.length - 1;
      }
    }
    const stop = String(m.stopReason || '');
    if (agent === 'main' && (stop === 'stop' || stop === 'aborted' || stop === 'error') && !content.some((b) => b && b.type === 'toolCall')) {   // the turn is over: the last thing said (or done) closes it
      if (!said && st.act != null && st.raw[st.act]) said = st.raw[st.act];
      if (said) said.end = 1;
    } else if (stop === 'aborted' && st.act != null && st.raw[st.act]) st.raw[st.act].end = 1;
  };
}

// ---- /api/media: the n-th picture of a call (a toolResult with that call's id) or of a message the person sent (user: toolId is the entry's id).
// A picture lives in the record, base64 or as a blob reference (blob:sha256:<hash>) into <agent dir>/blobs.
const sniff = (b, type) => (b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.toString('latin1', 0, 4) === 'GIF8' ? 'image/gif' : b.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : type);
const MIME = /^image\/(png|jpeg|gif|webp)$/;
let imgBuf = { file: '', sig: '', buf: null, timer: null };
function sessionBuf(r) {
  const sig = r.mtime + ':' + r.size; if (imgBuf.file === r.file && imgBuf.sig === sig) return imgBuf.buf;
  let buf = null; try { buf = fs.readFileSync(r.file); } catch { return null; }
  clearTimeout(imgBuf.timer); imgBuf = { file: r.file, sig, buf, timer: setTimeout(() => { imgBuf = { file: '', sig: '', buf: null, timer: null }; }, 20e3) }; if (imgBuf.timer.unref) imgBuf.timer.unref();
  return buf;
}
const imgMemo = new Map();
function image(id, toolId, n, user) {
  const r = row(id); if (!r || typeof toolId !== 'string' || toolId.length < 4 || !(n >= 0)) return null;
  const key = r.file + '|' + r.mtime + '|' + toolId + '|' + n + (user ? '|u' : ''); if (imgMemo.has(key)) return imgMemo.get(key);
  let found = null;
  const buf = sessionBuf(r);
  if (buf) {   // only the lines that name the call are parsed
    const needle = Buffer.from('"' + toolId + '"');
    for (let a = 0; a < buf.length;) {
      let b = buf.indexOf(10, a); if (b < 0) b = buf.length; const line = buf.subarray(a, b); a = b + 1;
      if (line.indexOf(needle) < 0) continue;
      let j; try { j = JSON.parse(line.toString('utf8')); } catch { continue; }
      const m = j && j.message; if (!m || !Array.isArray(m.content)) continue;
      const mine = user ? m.role === 'user' && j.id === toolId : m.role === 'toolResult' && m.toolCallId === toolId;
      if (!mine) continue;
      const imgs = m.content.filter((x) => x && x.type === 'image' && typeof x.data === 'string');
      found = imgs[n] || null; break;
    }
  }
  let out = null;
  if (found) {
    const type = MIME.test(found.mimeType || '') ? found.mimeType : 'image/png'; let b = null;
    const b64 = /^data:image\/[a-z]+;base64,(.*)$/i.exec(found.data);
    const ref = /^blob:sha256:([0-9a-f]{64})$/i.exec(found.data);
    if (ref) { const h = r.home || home(); try { b = fs.readFileSync(path.join(h, 'blobs', ref[1])); } catch { try { b = fs.readFileSync(path.join(h, 'blobs', ref[1] + '.' + type.split('/')[1].replace('jpeg', 'jpg'))); } catch {} } }
    else if (b64 || found.data.length > 64) { try { b = Buffer.from(b64 ? b64[1] : found.data, 'base64'); } catch {} }
    if (b && b.length) out = { type: sniff(b, type), buf: b };
  }
  imgMemo.set(key, out); if (imgMemo.size > 12) imgMemo.delete(imgMemo.keys().next().value);
  return out;
}

module.exports = { PROJ, SOURCE, home, dirKey, sessions, row, fileOf, subFiles, cwd, inProject, projectLabel, title, boardRow, parser, image };
