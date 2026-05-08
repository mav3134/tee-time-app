const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { scrapeCourse } = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 3000;

// Use /data volume if available (Railway persistent volume), else local data dir
const DATA_DIR     = process.env.DATA_DIR || path.join(__dirname, 'data');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COURSES_FILE)) fs.writeFileSync(COURSES_FILE, '[]');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Courses API ───────────────────────────────────────────────

function readCourses() {
  try { return JSON.parse(fs.readFileSync(COURSES_FILE, 'utf8')); }
  catch { return []; }
}

function writeCourses(courses) {
  fs.writeFileSync(COURSES_FILE, JSON.stringify(courses, null, 2));
}

app.get('/api/courses', (req, res) => {
  res.json(readCourses());
});

app.post('/api/courses', (req, res) => {
  const { name, url, state } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const courses   = readCourses();
  const newCourse = { id: Date.now(), name: name.trim(), url: url.trim(), state: state || 'Michigan' };
  courses.push(newCourse);
  writeCourses(courses);
  res.json(newCourse);
});

app.delete('/api/courses/:id', (req, res) => {
  const courses = readCourses().filter(c => c.id !== parseInt(req.params.id));
  writeCourses(courses);
  res.json({ success: true });
});

app.patch('/api/courses/:id', (req, res) => {
  const { name, url } = req.body;
  const courses = readCourses();
  const course  = courses.find(c => c.id === parseInt(req.params.id));
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (name) course.name = name.trim();
  if (url)  course.url  = url.trim();
  writeCourses(courses);
  res.json(course);
});

// ── States API ────────────────────────────────────────────────

const STATES_FILE = path.join(DATA_DIR, 'states.json');
if (!fs.existsSync(STATES_FILE)) fs.writeFileSync(STATES_FILE, '["Michigan"]');

function readStates() {
  try { return JSON.parse(fs.readFileSync(STATES_FILE, 'utf8')); }
  catch { return ['Michigan']; }
}

app.get('/api/states', (req, res) => res.json(readStates()));

app.post('/api/states', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const states = readStates();
  if (!states.includes(name.trim())) {
    states.push(name.trim());
    states.sort();
    fs.writeFileSync(STATES_FILE, JSON.stringify(states, null, 2));
  }
  res.json(states);
});

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
  console.log(`   Data directory: ${DATA_DIR}\n`);
});
