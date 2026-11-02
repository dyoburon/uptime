// Checks afk.ai and its Modal rigger, and pushes to the phone (ntfy, topic NTFY_TOPIC) when one goes down, stays down,
// or comes back. Run every 5 minutes by .github/workflows/uptime.yml; what it last saw is kept in state.json.
// TEST=1 only sends a test alert.
import { readFileSync, writeFileSync } from 'node:fs';

const TOPIC = process.env.NTFY_TOPIC;
if (!TOPIC) throw new Error('NTFY_TOPIC is not set');
const STATE = new URL('./state.json', import.meta.url);
const TIMEOUT_MS = 20_000;
const RETRY_MS = 30_000; // a check that fails is tried again after this before it counts
const REMIND_MS = 60 * 60_000; // while something's down, a reminder this often
const HEARTBEAT_MS = 7 * 24 * 60 * 60_000; // "still watching", and a commit that keeps GitHub running the schedule

const CHECKS = [
  { id: 'site', name: 'afk.ai', url: 'https://afk.ai/' },
  { id: 'api', name: 'afk.ai API', url: 'https://afk.ai/api/region' },
  {
    id: 'modal', name: 'Modal rigger', url: 'https://burtndylan--afk-cloud-rigger-api.modal.run/status',
    // answering but not rigging: switched off ("off") or the month's free budget spent ("month")
    warn: (body) => {
      const s = JSON.parse(body);
      return s.available ? null : `cloud rigging unavailable (${s.reason ?? 'no reason given'})`;
    },
  },
];

async function probe(check) {
  try {
    const res = await fetch(check.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'afk-uptime' } });
    const body = await res.text();
    if (!res.ok) {
      const why = res.headers.get('x-vercel-error');
      return { status: 'down', detail: `HTTP ${res.status}${why ? ` ${why}` : ''}` };
    }
    const warning = check.warn?.(body);
    return warning ? { status: 'warn', detail: warning } : { status: 'up' };
  } catch (e) {
    return { status: 'down', detail: e.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000}s` : e.message };
  }
}

// ntfy's JSON publishing (UTF-8 throughout); priority 5 is urgent, 3 default, 2 low
async function push({ title, message, priority = 3, tags = [], click }) {
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    body: JSON.stringify({ topic: TOPIC, title, message, priority, tags, ...(click && { click }) }),
  });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
}

const minutes = (ms) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

if (process.env.TEST === '1') {
  await push({ title: 'Test alert', message: 'afk.ai uptime alerts reach this phone.', priority: 5, tags: ['test_tube'] });
  console.log('test alert sent');
  process.exit(0);
}

const before = JSON.parse(readFileSync(STATE, 'utf8'));
const state = structuredClone(before);
state.checks ??= {};

let results = await Promise.all(CHECKS.map(probe));
if (results.some((r) => r.status !== 'up')) {
  await new Promise((r) => setTimeout(r, RETRY_MS));
  results = await Promise.all(CHECKS.map((c, i) => (results[i].status === 'up' ? results[i] : probe(c))));
}

const now = Date.now();
for (const [i, check] of CHECKS.entries()) {
  const { status, detail } = results[i];
  const prev = state.checks[check.id];
  console.log(`${check.name}: ${status}${detail ? ` (${detail})` : ''}`);
  if (!prev) {
    state.checks[check.id] = { status, since: now, alerted: now };
    if (status !== 'up') await push({ title: `${check.name} is ${status === 'down' ? 'down' : 'degraded'}`, message: detail, priority: status === 'down' ? 5 : 3, tags: [status === 'down' ? 'rotating_light' : 'warning'], click: check.url });
    continue;
  }
  if (status === prev.status) {
    if (status === 'down' && now - prev.alerted >= REMIND_MS) {
      await push({ title: `${check.name} still down`, message: `Down for ${minutes(now - prev.since)}: ${detail}`, priority: 4, tags: ['rotating_light'], click: check.url });
      prev.alerted = now;
    }
    continue;
  }
  if (status === 'down') {
    await push({ title: `${check.name} is down`, message: detail, priority: 5, tags: ['rotating_light'], click: check.url });
  } else if (status === 'warn') {
    await push({ title: `${check.name} is degraded`, message: detail, priority: 3, tags: ['warning'], click: check.url });
  } else {
    await push({ title: `${check.name} is back up`, message: `It was ${prev.status === 'down' ? 'down' : 'degraded'} for ${minutes(now - prev.since)}.`, priority: 3, tags: ['white_check_mark'], click: check.url });
  }
  state.checks[check.id] = { status, since: now, alerted: now };
}

if (!state.heartbeat || now - state.heartbeat >= HEARTBEAT_MS) {
  const summary = CHECKS.map((c) => `${c.name}: ${state.checks[c.id].status}`).join('\n');
  await push({ title: state.heartbeat ? 'Uptime monitor is running' : 'Uptime monitor is set up', message: summary, priority: 2, tags: ['eyes'] });
  state.heartbeat = now;
}

if (JSON.stringify(state) !== JSON.stringify(before)) writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
