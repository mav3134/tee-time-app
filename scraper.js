const { chromium } = require('playwright');

const START_H = 6;
const END_H   = 18;

async function scrapeCourse(course, dateStr, filterByName = false) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const interceptedResponses = [];
  let kennaRequestHeaders = null;
  let kennaBaseUrl        = null;

  page.on('request', (request) => {
    if (request.url().includes('kenna.io/v2/tee-times')) {
      kennaRequestHeaders = request.headers();
      kennaBaseUrl        = request.url();
    }
  });

  page.on('response', async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (response.status() !== 200) return;
      if (!contentType.includes('json')) return;
      const url = response.url();
      if (/google|facebook|analytics|gtm|pixel|ads|doubleclick/i.test(url)) return;
      const text = await response.text();
      if (!text || text.length < 30) return;
      if (/\d{1,2}:\d{2}|tee.?time|teetime|slot|available|facilities/i.test(text)) {
        interceptedResponses.push({ url, text });
      }
    } catch { /* ignore */ }
  });

  try {
    const fetchUrl = buildUrl(course.url, dateStr);
    await page.goto(fetchUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(6000);

    const facilityMap = {};
    for (const r of interceptedResponses) {
      if (r.url.includes('/facilities')) {
        try {
          const facilities = JSON.parse(r.text);
          if (Array.isArray(facilities)) {
            facilities.forEach(f => { if (f.courseId && f.name) facilityMap[f.courseId] = f.name; });
          }
        } catch { /* ignore */ }
      }
    }

    if (kennaBaseUrl && dateStr) {
      const correctedUrl = kennaBaseUrl.replace(/date=[^&]*/i, 'date=' + dateStr);
      console.log(`  [${course.name}] Re-firing Kenna with date ${dateStr}: ${correctedUrl.substring(0, 120)}`);
      try {
        const response = await context.request.fetch(correctedUrl, {
          headers: kennaRequestHeaders || {}
        });
        if (response.ok()) {
          const refiredText = await response.text();
          console.log(`  [${course.name}] Re-fired preview: ${refiredText.substring(0, 800)}`);
          const kennaTimes = parseKennaJson(refiredText, course.name, facilityMap, filterByName);
          if (kennaTimes !== null && kennaTimes.length > 0) {
            console.log(`  [${course.name}] ✓ Found ${kennaTimes.length} times`);
            await browser.close();
            return kennaTimes;
          }
          const genericTimes = parseGenericJson(refiredText, filterByName ? course.name : null);
          if (genericTimes !== null && genericTimes.length > 0) {
            console.log(`  [${course.name}] ✓ Found ${genericTimes.length} times (generic)`);
            await browser.close();
            return genericTimes;
          }
          console.log(`  [${course.name}] Parsed 0 times from re-fired response`);
        } else {
          console.log(`  [${course.name}] Re-fire HTTP ${response.status()}`);
        }
      } catch (e) {
        console.log(`  [${course.name}] Re-fire error: ${e.message}`);
      }
    }

    for (const r of interceptedResponses) {
      if (r.url.includes('/facilities') || r.url.includes('launchdarkly')) continue;
      const kennaTimes = parseKennaJson(r.text, course.name, facilityMap, filterByName);
      if (kennaTimes !== null && kennaTimes.length > 0) {
        await browser.close(); return kennaTimes;
      }
      const genericTimes = parseGenericJson(r.text, filterByName ? course.name : null);
      if (genericTimes !== null && genericTimes.length > 0) {
        await browser.close(); return genericTimes;
      }
    }

    const teeTimes = await extractTeeTimes(page, course.url, filterByName ? course.name : null);
    console.log(`  [${course.name}] Text scrape found ${teeTimes.length} times`);
    await browser.close();
    return teeTimes;

  } catch (err) {
    await browser.close();
    throw new Error(err.message);
  }
}

function buildUrl(url, dateStr) {
  if (!dateStr) return url;
  if (/clubcaddie\.com/i.test(url)) {
    const [y, m, d] = dateStr.split('-');
    const slashDate = `${m}/${d}/${y}`;
    if (url.includes('date=')) return url.replace(/date=[^&]*/i, 'date=' + encodeURIComponent(slashDate));
    return url + (url.includes('?') ? '&' : '?') + 'date=' + encodeURIComponent(slashDate);
  }
  if (/foreup/i.test(url)) {
    const [y, m, d] = dateStr.split('-');
    const fDate = `${m}-${d}-${y}`;
    if (url.includes('date=')) return url.replace(/date=[^&]*/i, 'date=' + fDate);
    return url + (url.includes('?') ? '&' : '?') + 'date=' + fDate;
  }
  if (!url.includes('date=')) return url + (url.includes('?') ? '&' : '?') + 'date=' + dateStr;
  return url.replace(/date=[^&]*/i, 'date=' + dateStr);
}

async function extractTeeTimes(page, originalUrl, courseName) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.trim().startsWith('[') || bodyText.trim().startsWith('{')) {
    const jsonTimes = parseGenericJson(bodyText, courseName);
    if (jsonTimes !== null && jsonTimes.length > 0) return jsonTimes;
  }
  const textToSearch = courseName ? extractCourseSection(bodyText, courseName) : bodyText;
  return scrapeVisibleText(textToSearch);
}

function extractCourseSection(text, courseName) {
  const nameLower = courseName.toLowerCase();
  const textLower = text.toLowerCase();
  const startIdx  = textLower.indexOf(nameLower);
  if (startIdx === -1) return text;
  const chunk  = text.substring(startIdx, startIdx + 8000);
  const lines  = chunk.split('\n');
  const result = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    const hasTimes = result.join('\n').match(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    if (hasTimes && line.length > 3 && line.length < 80 &&
        !/\d{1,2}:\d{2}/.test(line) && !/\$|#|\d{2,}/.test(line) &&
        /^[A-Z][a-zA-Z\s\-']+$/.test(line) && line.toLowerCase() !== nameLower) {
      const afterThis = textLower.indexOf(line.toLowerCase(), startIdx + nameLower.length + 10);
      if (afterThis !== -1 && afterThis < startIdx + 8000) break;
    }
    result.push(lines[i]);
  }
  return result.join('\n');
}

function parseKennaJson(raw, courseName, facilityMap, filterByName) {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    if (!data[0] || (!('teetimes' in data[0]) && !('teeTimes' in data[0]))) return null;

    const times = [];
    for (const courseBlock of data) {
      const slots = courseBlock.teetimes || courseBlock.teeTimes || [];
      if (!Array.isArray(slots)) continue;

      if (filterByName) {
        const blockCourseId   = courseBlock.courseId || '';
        const blockCourseName = facilityMap[blockCourseId] || courseBlock.courseName || '';
        if (blockCourseName && !blockCourseName.toLowerCase().includes(courseName.toLowerCase())) continue;
      }

      for (const slot of slots) {
        if (typeof slot !== 'object' || !slot) continue;
        if (slot.status === 'closed' || slot.status === 'unavailable') continue;

        const rawTime = slot.teetime || slot.TeeTime || slot.time || slot.Time ||
                        slot.startTime || slot.start || '';
        const avail   = slot.maxPlayers ?? slot.MaxPlayers ?? slot.openSlots ??
                        slot.available  ?? slot.Available  ?? null;

        // greenFeeCart is in cents (4500 = $45)
        let price = slot.price ?? slot.Price ?? slot.rate ?? slot.Rate ?? null;
        if (price === null && Array.isArray(slot.rates) && slot.rates.length > 0) {
          const r   = slot.rates[0];
          const raw = r.greenFeeCart ?? r.greenFee ?? r.price ?? r.Price ?? r.rate ?? r.total ?? null;
          if (raw !== null) price = (r.greenFeeCart !== undefined) ? raw / 100 : raw;
        }

        const normalized = parseAnyTime(rawTime);
        if (normalized) {
          times.push({
            time:  normalized,
            spots: avail !== null ? parseInt(avail) : null,
            price: price !== null ? parseFloat(price) : null
          });
        }
      }
    }
    return times.length > 0 ? times : null;
  } catch {
    return null;
  }
}

function parseGenericJson(raw, courseName) {
  try {
    const data  = JSON.parse(raw);
    const slots = (
      Array.isArray(data)                   ? data :
      Array.isArray(data.slots)             ? data.slots :
      Array.isArray(data.Slots)             ? data.Slots :
      Array.isArray(data.data)              ? data.data :
      Array.isArray(data.teeTimes)          ? data.teeTimes :
      Array.isArray(data.tee_times)         ? data.tee_times :
      Array.isArray(data.results)           ? data.results :
      Array.isArray(data.availableTeeTimes) ? data.availableTeeTimes :
      null
    );
    if (!slots) return null;

    const times = [];
    for (const slot of slots) {
      if (typeof slot !== 'object' || !slot) continue;
      if (courseName) {
        const sc = slot.CourseName || slot.courseName || slot.Course || slot.course || '';
        if (sc && !sc.toLowerCase().includes(courseName.toLowerCase())) continue;
      }
      const rawTime = slot.Time || slot.time || slot.TeeTime || slot.teetime ||
                      slot.StartTime || slot.startTime || slot.start_time || '';
      const avail   = slot.Available ?? slot.available ?? slot.OpenSpots ??
                      slot.openSpots ?? slot.Players   ?? slot.players   ?? null;
      const price   = slot.price ?? slot.Price ?? slot.rate ?? slot.Rate ??
                      slot.greenFee ?? slot.green_fee ?? slot.cost ?? null;
      const isAvail = slot.IsAvailable ?? slot.isAvailable ?? slot.status;
      if (isAvail === false || isAvail === 0 || isAvail === 'unavailable') continue;

      const normalized = parseAnyTime(rawTime);
      if (normalized) {
        times.push({ time: normalized, spots: avail !== null ? parseInt(avail) : null, price: price !== null ? parseFloat(price) : null });
      }
    }
    return times.length > 0 ? times : null;
  } catch {
    return null;
  }
}

function parseAnyTime(rawTime) {
  if (!rawTime) return null;
  const t = String(rawTime).trim();
if (t.includes('T') && t.includes('-')) {
    try {
      const d = new Date(t);
      if (isNaN(d)) return null;
      // Convert UTC to Eastern Time (Detroit) — Railway server runs in UTC
      const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/Detroit' }));
      let h      = eastern.getHours();
      const m    = eastern.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12  = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      if (h < START_H || h > END_H) return null;
      return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
    } catch { return null; }
  }
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m) return `${parseInt(m[1])}:${m[2]} ${m[3].toUpperCase()}`;
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    let h      = parseInt(m[1]);
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m[2]} ${ampm}`;
  }
  return null;
}

function scrapeVisibleText(text) {
  const seen  = {};
  const times = [];
  const re    = /\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const h = parseInt(match[1]), min = parseInt(match[2]), ampm = match[3].toUpperCase();
    let h24 = h;
    if (ampm === 'PM' && h !== 12) h24 = h + 12;
    if (ampm === 'AM' && h === 12) h24 = 0;
    if (h24 < START_H || h24 > END_H) continue;
    const key = `${h}:${String(min).padStart(2,'0')} ${ampm}`;
    if (seen[key]) continue;
    seen[key] = true;
    const ctx   = text.substring(Math.max(0, match.index - 200), match.index + 200);
    const spots = extractSpots(ctx);
    times.push({ time: key, spots });
  }
  return times;
}

function extractSpots(ctx) {
  const text = ctx.replace(/<[^>]+>/g, ' ');
  for (const p of [/(\d)\s*player/i, /(\d)\s*spot/i, /(\d)\s*available/i,
                   /available[:\s]+(\d)/i, /opening[s]?[:\s]+(\d)/i, /remaining[:\s]+(\d)/i]) {
    const m = text.match(p);
    if (m) { const n = parseInt(m[1]); if (n >= 0 && n <= 4) return n; }
  }
  return null;
}

function normalizeTime(t) { return parseAnyTime(t); }

module.exports = { scrapeCourse };
