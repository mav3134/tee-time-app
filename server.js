const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const RENDER_SECRET = process.env.RENDER_SECRET;
if (!RENDER_SECRET) console.warn('RENDER_SECRET not set');

function requireSecret(req, res, next) {
  const token = req.headers['x-render-secret'];
  if (!RENDER_SECRET || token === RENDER_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

let companies    = [];
let comps        = [];
let jobs         = {};
let queuePaused  = false;

app.use(express.json());
app.use(express.static('public'));

// ── Companies ─────────────────────────────────────────────────────────────────
app.post('/api/companies', requireSecret, (req, res) => {
  companies = req.body.companies || [];
  console.log('Companies:', companies.map(c => c.name).join(', '));
  res.json({ success: true });
});
app.get('/api/companies', (req, res) => res.json({ success: true, companies }));

// ── Comps ─────────────────────────────────────────────────────────────────────
app.post('/api/comps', requireSecret, (req, res) => {
  comps = req.body.comps || [];
  console.log('Comps:', comps.join(', '));
  res.json({ success: true });
});
app.get('/api/comps', (req, res) => res.json({ success: true, comps }));

// ── Queue pause/resume (public — UI calls these) ──────────────────────────────
app.get('/api/queue/status',   (req, res) => res.json({ paused: queuePaused }));
app.post('/api/queue/pause',   (req, res) => { queuePaused = true;  res.json({ paused: true  }); });
app.post('/api/queue/resume',  (req, res) => { queuePaused = false; res.json({ paused: false }); });

// ── Jobs ──────────────────────────────────────────────────────────────────────

// List all jobs — sorted by status priority then createdAt
app.get('/api/jobs', (req, res) => {
  const priority = { rendering: 0, pending: 1, error: 2, done: 3 };
  const list = Object.values(jobs).sort((a, b) => {
    const pd = (priority[a.status] ?? 4) - (priority[b.status] ?? 4);
    if (pd !== 0) return pd;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
  res.json({ success: true, jobs: list });
});

// Create job
app.post('/api/jobs', (req, res) => {
  const { companyId, compName, swapLogo, swapVO, format } = req.body;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });
  if (!compName)  return res.status(400).json({ error: 'compName required' });
  const company = companies.find(c => c.id === companyId);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const jobId = crypto.randomBytes(6).toString('hex');
  jobs[jobId] = {
    id: jobId, company: company.name, companyId: company.id,
    compName, swapLogo: !!swapLogo, swapVO: !!swapVO,
    format: format || 'mp4',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [],
  };
  console.log(`Job created: ${jobId} | ${compName} | ${company.name} | ${format || 'mp4'}`);
  res.json({ success: true, jobId });
});

// Get single job
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true, job });
});

// Delete a pending job (called from UI — no secret needed)
app.delete('/api/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'pending') return res.status(400).json({ error: 'Only pending jobs can be deleted' });
  delete jobs[req.params.jobId];
  res.json({ success: true });
});

// Clear completed/error jobs (UI calls this)
app.delete('/api/jobs', (req, res) => {
  Object.keys(jobs).forEach(id => {
    if (jobs[id].status === 'done' || jobs[id].status === 'error') delete jobs[id];
  });
  res.json({ success: true });
});

// Agent polls for next pending job — respects pause
app.get('/api/jobs/pending/raw', requireSecret, (req, res) => {
  res.type('text');
  if (queuePaused) return res.send('');
  const pending = Object.values(jobs)
    .filter(j => j.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  if (!pending) return res.send('');
  res.send([
    pending.id, pending.companyId, pending.company,
    pending.compName,
    pending.swapLogo ? '1' : '0',
    pending.swapVO   ? '1' : '0',
    pending.format || 'mp4',
  ].join('|'));
});

// Agent updates job
app.patch('/api/jobs/:jobId', requireSecret, (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, log } = req.body;
  if (status) job.status = status;
  if (log)    job.log.push(...(Array.isArray(log) ? log : [log]));
  job.updatedAt = new Date().toISOString();
  res.json({ success: true, job });
});

// ── Agent info (local IP for direct uploads) ──────────────────────────────────
let agentInfo = null;

app.post('/api/agent/info', requireSecret, (req, res) => {
  agentInfo = req.body;
  console.log('Agent info registered:', agentInfo);
  res.json({ success: true });
});

app.get('/api/agent/info', (req, res) => {
  res.json({ agentInfo });
});

// ── Agent status ──────────────────────────────────────────────────────────────
let lastAgentPing = null;
app.post('/api/agent/ping', requireSecret, (req, res) => {
  lastAgentPing = new Date(); res.json({ success: true });
});
app.get('/api/agent/status', (req, res) => {
  res.json({ connected: !!(lastAgentPing && (Date.now() - lastAgentPing) < 10000) });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
