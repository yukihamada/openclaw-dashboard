const express = require('express');
const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');

const app = express();
const db = new Database('/data/dashboard.db');
const API_KEY = process.env.API_KEY || 'openclaw2026';
const ADMIN_PASS = process.env.ADMIN_PASS || 'openclaw-admin-2026';
const sessions = new Map(); // token -> expiry

const cw = new CloudWatchClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
  credentials: process.env.AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  } : undefined,
});
let metricsCache = null;
let metricsCachedAt = 0;

// Init tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_status (
    agent TEXT PRIMARY KEY,
    ip TEXT,
    emoji TEXT,
    task TEXT,
    memory TEXT,
    last_seen INTEGER
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    assignee TEXT,
    status TEXT DEFAULT 'todo',
    notes TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS blogs (
    id TEXT PRIMARY KEY,
    author TEXT,
    author_emoji TEXT,
    title TEXT,
    body TEXT,
    created_at INTEGER
  );
`);

// Seed initial tasks if empty
const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get();
if (taskCount.c === 0) {
  const insert = db.prepare('INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  insert.run('task-1', 'enablerdao.com ブログ更新', 'Saku', 'in_progress', 'リサーチ→blog_seed.json→git push', now);
  insert.run('task-2', 'Twitterマーケティングアイデア10個', 'Saku', 'todo', '@Enabler_fun アカウント使用', now);
  insert.run('task-3', 'インフラ監視設定', 'Miru', 'in_progress', '全VPS・Lambda・Fly.io', now);
  insert.run('task-4', 'chatweb.ai 改善提案', 'Depu', 'todo', 'UX改善・バグ発見', now);
  insert.run('task-5', 'enablerdao.com デプロイ', 'Depu', 'in_progress', 'コミット済み', now);
}

// Health check cache: { url -> { status, latency, checked_at } }
const healthCache = {};

function checkUrl(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      resolve({ status: res.statusCode < 400 ? 'up' : 'down', latency: Date.now() - start });
    });
    req.on('error', () => resolve({ status: 'down', latency: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', latency: 5000 }); });
  });
}

const PROJECTS_TO_MONITOR = [
  'https://chatweb.ai',
  'https://teai.io',
  'https://enablerdao.com',
  'https://jiuflow.art',
  'https://stayflowapp.com',
  'https://misebanai.com',
  'https://banto.work',
  'https://solun.art',
  'https://elio.love',
];

async function refreshHealth() {
  await Promise.all(PROJECTS_TO_MONITOR.map(async (url) => {
    const result = await checkUrl(url);
    healthCache[url] = { ...result, checked_at: Date.now() };
  }));
}

// Initial check + refresh every 5min
refreshHealth();
setInterval(refreshHealth, 5 * 60 * 1000);

app.use(express.json());
app.use(express.static('public'));

function requireKey(req, res, next) {
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && sessions.has(token) && sessions.get(token) > Date.now()) return next();
  res.status(401).json({ error: 'admin auth required' });
}

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 8 * 3600 * 1000); // 8h
  res.json({ token });
});

// GET /api/lambda-metrics
app.get('/api/lambda-metrics', async (req, res) => {
  const now = Date.now();
  if (metricsCache && now - metricsCachedAt < 5 * 60 * 1000) return res.json(metricsCache);

  const end = new Date();
  const start = new Date(end - 24 * 3600 * 1000);
  const fns = ['nanobot-prod'];
  const metricNames = ['Invocations', 'Errors', 'Duration', 'Throttles'];

  try {
    const results = {};
    await Promise.all(fns.flatMap(fn => metricNames.map(async metric => {
      const cmd = new GetMetricStatisticsCommand({
        Namespace: 'AWS/Lambda',
        MetricName: metric,
        Dimensions: [{ Name: 'FunctionName', Value: fn }],
        StartTime: start,
        EndTime: end,
        Period: 3600,
        Statistics: metric === 'Duration' ? ['Average', 'p99'] : ['Sum'],
      });
      const data = await cw.send(cmd);
      if (!results[fn]) results[fn] = {};
      results[fn][metric] = data.Datapoints.sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp));
    })));
    metricsCache = results;
    metricsCachedAt = now;
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json(healthCache);
});

// POST /api/status
app.post('/api/status', requireKey, (req, res) => {
  const { agent, ip, emoji, task, memory } = req.body;
  db.prepare('INSERT OR REPLACE INTO agent_status VALUES (?, ?, ?, ?, ?, ?)').run(
    agent, ip, emoji || '🤖', task || '', memory || '', Date.now()
  );
  res.json({ ok: true });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json(db.prepare('SELECT * FROM agent_status ORDER BY last_seen DESC').all());
});

// POST /api/tasks
app.post('/api/tasks', requireKey, (req, res) => {
  const { id, title, assignee, status, notes } = req.body;
  db.prepare('INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?, ?, ?)').run(
    id, title, assignee, status || 'todo', notes || '', Date.now()
  );
  res.json({ ok: true });
});

// GET /api/tasks
app.get('/api/tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all());
});

// POST /api/blogs
app.post('/api/blogs', requireKey, (req, res) => {
  const { id, author, author_emoji, title, body } = req.body;
  const blogId = id || `blog-${Date.now()}`;
  db.prepare('INSERT OR REPLACE INTO blogs VALUES (?, ?, ?, ?, ?, ?)').run(
    blogId, author, author_emoji || '🤖', title, body, Date.now()
  );
  res.json({ ok: true, id: blogId });
});

// GET /api/blogs
app.get('/api/blogs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.prepare('SELECT * FROM blogs ORDER BY created_at DESC LIMIT ?').all(limit));
});

app.listen(3000, () => console.log('Dashboard running on :3000'));
