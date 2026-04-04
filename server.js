const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { scrapeCourse } = require('./scraper');

const app  = express();
const PORT = 3000;

const DATA_DIR      = path.join(__dirname, 'data');
const COURSES_FILE  = path.join(DATA_DIR, 'courses.json');
const RESULTS_FILE  = path.join(DATA_DIR, 'results.json');

if (!fs.existsSync(DATA_DIR))     fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(COURSES_FILE)) fs.writeFileSync(COURSES_FILE, '[]');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────

function readCourses()         { return JSON.parse(fs.readFileSync(COURSES_FILE, 'utf8')); }
function writeCourses(courses) { fs.writeFileSync(COURSES_FILE, JSON.stringify(courses, null, 2)); }
function readResults()         {
  if (!fs.existsSync(RESULTS_FILE)) return { results: [], lastRefresh: null };
  return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
}

// ── Courses API ───────────────────────────────────────────────

app.get('/api/courses', (req, res) => res.json(readCourses()));

app.post('/api/courses', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const courses   = readCourses();
  const newCourse = { id: Date.now(), name: name.trim(), url: url.trim() };
  courses.push(newCourse);
  writeCourses(courses);
  res.json(newCourse);
});

app.delete('/api/courses/:id', (req, res) => {
  const courses = readCourses().filter(c => c.id !== parseInt(req.params.id));
  writeCourses(courses);
  res.json({ success: true });
});

// ── Results API ───────────────────────────────────────────────

app.get('/api/results', (req, res) => res.json(readResults()));

// ── Refresh (SSE stream for live progress) ────────────────────

app.post('/api/refresh', async (req, res) => {
  const courses    = readCourses();
  const dateStr    = req.body.date || '';
  const enabledIds = req.body.enabledIds || null;
  const toScrape   = enabledIds ? courses.filter(c => enabledIds.includes(c.id)) : courses;

  if (toScrape.length === 0) {
    return res.status(400).json({ error: 'No courses to scrape' });
  }

  // Count how many times each URL appears — if more than once, filter by course name
  const urlCount = {};
  toScrape.forEach(c => { urlCount[c.url] = (urlCount[c.url] || 0) + 1; });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const results = [];

  for (const course of toScrape) {
    const filterByName = urlCount[course.url] > 1;
    send({ type: 'progress', course: course.name, status: 'scraping' });
    try {
      const teeTimes = await scrapeCourse(course, dateStr, filterByName);
      results.push({ courseId: course.id, course: course.name, url: course.url, teeTimes, error: null });
      send({ type: 'progress', course: course.name, status: 'done', count: teeTimes.length });
    } catch (err) {
      results.push({ courseId: course.id, course: course.name, url: course.url, teeTimes: [], error: err.message });
      send({ type: 'progress', course: course.name, status: 'error', error: err.message });
    }
  }

  const output = { results, lastRefresh: new Date().toISOString(), date: dateStr };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));

  send({ type: 'complete', lastRefresh: output.lastRefresh });
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n⛳  Tee Time App running at http://localhost:${PORT}\n`);
});
