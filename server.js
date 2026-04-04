const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { scrapeCourse } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR     = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Results ───────────────────────────────────────────────────

let cachedResults = { results: [], lastRefresh: null };

function readResults() {
  try {
    if (fs.existsSync(RESULTS_FILE))
      return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return { results: [], lastRefresh: null };
}

function saveResults(data) {
  cachedResults = data;
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
}

cachedResults = readResults();

app.get('/api/results', (req, res) => res.json(cachedResults));

// ── Refresh ───────────────────────────────────────────────────
// Courses are passed from the browser (stored in localStorage there)

app.post('/api/refresh', async (req, res) => {
  const { date = '', courses = [] } = req.body;

  if (!courses.length) {
    return res.status(400).json({ error: 'No courses provided' });
  }

  const urlCount = {};
  courses.forEach(c => { urlCount[c.url] = (urlCount[c.url] || 0) + 1; });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send    = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const results = [];

  for (const course of courses) {
    const filterByName = urlCount[course.url] > 1;
    send({ type: 'progress', course: course.name, status: 'scraping' });
    try {
      const teeTimes = await scrapeCourse(course, date, filterByName);
      results.push({ courseId: course.id, course: course.name, url: course.url, teeTimes, error: null });
      send({ type: 'progress', course: course.name, status: 'done', count: teeTimes.length });
    } catch (err) {
      results.push({ courseId: course.id, course: course.name, url: course.url, teeTimes: [], error: err.message });
      send({ type: 'progress', course: course.name, status: 'error', error: err.message });
    }
  }

  const output = { results, lastRefresh: new Date().toISOString(), date };
  saveResults(output);

  send({ type: 'complete', lastRefresh: output.lastRefresh });
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n⛳  Tee Time App running at http://localhost:${PORT}\n`);
});
