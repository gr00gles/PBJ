// PBJ Daily Nurse Staffing — pure-static frontend.
// Calls data.cms.gov directly (CORS is allowed). No backend required.

const $ = (sel) => document.querySelector(sel);
const form = $('#report-form');
const runBtn = $('#run');
const statusEl = $('#status');
const resultsEl = $('#results');
const coverageEl = $('#coverage');
const tableEl = $('#daily-table');
const splitToggle = $('#split-emp-ctr');
const csvBtn = $('#csv');

// ---------- config ----------

const CATALOG_URL = 'https://data.cms.gov/data.json';
const DATASET_TITLE = 'Payroll Based Journal Daily Nurse Staffing';
const CATALOG_CACHE_KEY = 'pbj.catalog.v1';
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
const HARD_MIN_DATE = '2017-07-01'; // earliest date users are allowed to query

let latestQuarterURL = null;
let latestQuarterKey = null;

// State & federal minimum staffing requirements — editable per-state in the UI.
const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',
  WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'D.C.',
};
const STATE_MIN_DEFAULTS = {
  NY: { cna: 2.20, lpnRn: 1.10, total: 3.50, statute: '10 NYCRR 415.13' },
};
const FEDERAL_MIN = { cna: 2.45, lpnRn: 0.55, total: 3.00, statute: '42 CFR 483.35 (2024 final rule)' };
function getStateMinDefaults(state) { return STATE_MIN_DEFAULTS[state] || FEDERAL_MIN; }
function minCacheKey(state) { return `pbj.minimums.${state || 'default'}.v1`; }
function loadMinimums(state) {
  const d = getStateMinDefaults(state);
  try {
    const raw = localStorage.getItem(minCacheKey(state));
    if (raw) {
      const m = JSON.parse(raw);
      return {
        cna:   Number.isFinite(+m.cna)   ? +m.cna   : d.cna,
        lpnRn: Number.isFinite(+m.lpnRn) ? +m.lpnRn : d.lpnRn,
        total: Number.isFinite(+m.total) ? +m.total : d.total,
      };
    }
  } catch {}
  return { cna: d.cna, lpnRn: d.lpnRn, total: d.total };
}
function saveMinimums(state, m) {
  try { localStorage.setItem(minCacheKey(state), JSON.stringify(m)); } catch {}
}
let currentFacilityState = null;
let nysMinimums = loadMinimums(null);

// ---------- field schema ----------

const STAFF_GROUPS = [
  { key: 'RN',      label: 'RN',         field: 'Hrs_RN' },
  { key: 'RNDON',   label: 'RN DON',     field: 'Hrs_RNDON' },
  { key: 'RNadm',   label: 'RN Admin',   field: 'Hrs_RNadmin' },
  { key: 'LPN',     label: 'LPN',        field: 'Hrs_LPN' },
  { key: 'LPNadm',  label: 'LPN Admin',  field: 'Hrs_LPNadmin' },
  { key: 'CNA',     label: 'CNA',        field: 'Hrs_CNA' },
  { key: 'NAtrn',   label: 'NA Trainee', field: 'Hrs_NAtrn' },
  { key: 'MedAide', label: 'Med Aide',   field: 'Hrs_MedAide' },
];

// ---------- formatters ----------

const fmt1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const workDateToISO = (d) => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
const isoToCompact = (d) => d.replaceAll('-', '');

function setStatus(kind, text) {
  if (!text) { statusEl.hidden = true; statusEl.textContent = ''; return; }
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

// ---------- quarter helpers ----------

function quarterFromISO(iso) {
  const [y, m] = iso.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return { year: y, q };
}

function quartersInRange(startISO, endISO) {
  const start = quarterFromISO(startISO);
  const end = quarterFromISO(endISO);
  const out = [];
  let y = start.year, q = start.q;
  while (y < end.year || (y === end.year && q <= end.q)) {
    out.push(`${y}Q${q}`);
    q += 1;
    if (q > 4) { q = 1; y += 1; }
  }
  return out;
}

function titleToQuarter(title) {
  const m = (title || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}Q${q}`;
}

function quarterToISO(q, side) {
  const [y, qn] = q.split('Q').map(Number);
  const startMonth = (qn - 1) * 3 + 1;
  if (side === 'start') return `${y}-${String(startMonth).padStart(2,'0')}-01`;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  return `${y}-${String(endMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
}

// ---------- CMS catalog ----------

async function loadCatalog() {
  // Try cache first
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (raw) {
      const { fetchedAt, quarters } = JSON.parse(raw);
      if (Date.now() - fetchedAt < CATALOG_TTL_MS && quarters && Object.keys(quarters).length) {
        return quarters;
      }
    }
  } catch {}

  const res = await fetch(CATALOG_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CMS catalog HTTP ${res.status}`);
  const catalog = await res.json();
  const ds = (catalog.dataset || []).find(d => d.title === DATASET_TITLE);
  if (!ds) throw new Error(`Dataset "${DATASET_TITLE}" not found in CMS catalog`);

  const quarters = {};
  for (const dist of ds.distribution || []) {
    if (dist.format !== 'API') continue;
    const q = titleToQuarter(dist.title || '');
    const accessURL = dist.accessURL;
    if (q && accessURL && !quarters[q]) quarters[q] = accessURL;
  }

  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), quarters }));
  } catch {}

  return quarters;
}

async function fetchQuarterForProvider(accessURL, providerId) {
  const u = new URL(accessURL);
  u.searchParams.set('filter[PROVNUM]', providerId);
  u.searchParams.set('size', '500');
  const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u.toString()}`);
  return res.json();
}

// ---------- state benchmark ----------

const STATE_PAGE_SIZE = 6500;
const STATE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function stateCacheKey(state, quarterKey) { return `pbj.state.${state}.${quarterKey}.v1`; }

function readStateCache(state, quarterKey) {
  try {
    const raw = localStorage.getItem(stateCacheKey(state, quarterKey));
    if (!raw) return null;
    const { fetchedAt, byDate } = JSON.parse(raw);
    if (Date.now() - fetchedAt > STATE_CACHE_TTL_MS) return null;
    return byDate;
  } catch { return null; }
}

function writeStateCache(state, quarterKey, byDate) {
  try {
    localStorage.setItem(stateCacheKey(state, quarterKey), JSON.stringify({ fetchedAt: Date.now(), byDate }));
  } catch {}
}

async function fetchStateQuarterAggregated(accessURL, quarterKey, state, onProgress) {
  const cached = readStateCache(state, quarterKey);
  if (cached) return cached;

  const byDate = {};
  let offset = 0;
  let pageIndex = 0;
  const HARD_CAP = 200000;
  while (offset < HARD_CAP) {
    const u = new URL(accessURL);
    u.searchParams.set('filter[STATE]', state);
    u.searchParams.set('size', String(STATE_PAGE_SIZE));
    u.searchParams.set('offset', String(offset));
    const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${state} HTTP ${res.status} at offset ${offset}`);
    const rows = await res.json();
    for (const r of rows) {
      const d = r.WorkDate;
      const t = byDate[d] || (byDate[d] = {
        census: 0, cna: 0, lpn: 0, rn: 0, lpnAdmin: 0, naTrn: 0, rows: 0,
      });
      t.census   += num(r.MDScensus);
      t.cna      += num(r.Hrs_CNA) + num(r.Hrs_MedAide);
      t.lpn      += num(r.Hrs_LPN);
      t.rn       += num(r.Hrs_RN) + num(r.Hrs_RNDON) + num(r.Hrs_RNadmin);
      t.lpnAdmin += num(r.Hrs_LPNadmin);
      t.naTrn    += num(r.Hrs_NAtrn);
      t.rows     += 1;
    }
    pageIndex += 1;
    if (onProgress) onProgress(quarterKey, pageIndex, rows.length);
    if (rows.length < STATE_PAGE_SIZE) break;
    offset += STATE_PAGE_SIZE;
  }

  writeStateCache(state, quarterKey, byDate);
  return byDate;
}

// Given per-day NY totals across quarters, summarize to the selected date range.
function summarizeNy(byDateMaps, startCompact, endCompact) {
  let census = 0, cna = 0, lpn = 0, rn = 0, lpnAdmin = 0, naTrn = 0, days = 0, rows = 0;
  for (const byDate of byDateMaps) {
    for (const [d, t] of Object.entries(byDate)) {
      if (d < startCompact || d > endCompact) continue;
      census   += t.census;
      cna      += t.cna;
      lpn      += t.lpn;
      rn       += t.rn;
      lpnAdmin += t.lpnAdmin;
      naTrn    += t.naTrn;
      rows     += t.rows;
      days     += 1;
    }
  }
  const lpnRn = lpn + rn;
  const total = cna + lpnRn;
  const hprd = (s) => census > 0 ? s / census : 0;
  return {
    census, rows, distinctDates: days,
    hours: { cna, lpn, rn, lpnRn, total, lpnAdmin, naTrn },
    hprd: {
      cna:   hprd(cna),
      lpn:   hprd(lpn),
      rn:    hprd(rn),
      lpnRn: hprd(lpnRn),
      total: hprd(total),
    },
  };
}

function summarizeNyFromFlat(nyByDate, startCompact, endCompact) {
  let census = 0, cna = 0, lpn = 0, rn = 0, lpnAdmin = 0, naTrn = 0, days = 0, rows = 0;
  for (const [d, t] of Object.entries(nyByDate)) {
    if (d < startCompact || d > endCompact) continue;
    census += t.census; cna += t.cna; lpn += t.lpn; rn += t.rn;
    lpnAdmin += t.lpnAdmin; naTrn += t.naTrn; rows += t.rows; days += 1;
  }
  const lpnRn = lpn + rn, total = cna + lpnRn;
  const hprd = (s) => census > 0 ? s / census : 0;
  return {
    census, rows, distinctDates: days,
    hours: { cna, lpn, rn, lpnRn, total, lpnAdmin, naTrn },
    hprd: { cna: hprd(cna), lpn: hprd(lpn), rn: hprd(rn), lpnRn: hprd(lpnRn), total: hprd(total) },
  };
}

// ---------- summary ----------

// Aggregations matching user-requested stats:
//   CNA (CNA_AND_MEDAIDE) = Hrs_CNA + Hrs_MedAide
//   LPN (LPN_NON_ADMIN)   = Hrs_LPN
//   RN  (RN_ALL)          = Hrs_RN + Hrs_RNDON + Hrs_RNadmin
//   LPN+RN                = LPN + RN
//   Total                 = CNA + LPN + RN
// Note: Hrs_LPNadmin and Hrs_NAtrn are intentionally excluded.
const cnaHoursRow   = (r) => num(r.Hrs_CNA) + num(r.Hrs_MedAide);
const lpnHoursRow   = (r) => num(r.Hrs_LPN);
const rnHoursRow    = (r) => num(r.Hrs_RN) + num(r.Hrs_RNDON) + num(r.Hrs_RNadmin);
const lpnRnHoursRow = (r) => lpnHoursRow(r) + rnHoursRow(r);
const totalHoursRow = (r) => cnaHoursRow(r) + lpnRnHoursRow(r);

// Every raw Hrs_* field, so the breakdown panel can show what's in the data
// (including the fields we intentionally exclude from the totals).
const RAW_HOUR_FIELDS = [
  'Hrs_RN', 'Hrs_RNDON', 'Hrs_RNadmin',
  'Hrs_LPN', 'Hrs_LPNadmin',
  'Hrs_CNA', 'Hrs_NAtrn', 'Hrs_MedAide',
];

function summarize(rows) {
  let totalCensus = 0, censusDays = 0;
  const fieldTotals = Object.fromEntries(RAW_HOUR_FIELDS.map(f => [f, 0]));
  for (const r of rows) {
    const c = num(r.MDScensus);
    totalCensus += c;
    if (c > 0) censusDays += 1;
    for (const f of RAW_HOUR_FIELDS) fieldTotals[f] += num(r[f]);
  }
  const cnaHours   = fieldTotals.Hrs_CNA + fieldTotals.Hrs_MedAide;
  const lpnHours   = fieldTotals.Hrs_LPN;
  const rnHours    = fieldTotals.Hrs_RN + fieldTotals.Hrs_RNDON + fieldTotals.Hrs_RNadmin;
  const lpnRnHours = lpnHours + rnHours;
  const totalNurseHours = cnaHours + lpnRnHours;
  const excludedHours = fieldTotals.Hrs_LPNadmin + fieldTotals.Hrs_NAtrn;
  const hprd = (s) => totalCensus > 0 ? s / totalCensus : 0;
  return {
    days: rows.length,
    censusDays,
    totalCensus,
    avgDailyCensus: censusDays > 0 ? totalCensus / censusDays : 0,
    fieldTotals,
    hours: { cna: cnaHours, lpn: lpnHours, rn: rnHours, lpnRn: lpnRnHours, total: totalNurseHours, excluded: excludedHours },
    hprd: {
      cna:   hprd(cnaHours),
      lpn:   hprd(lpnHours),
      rn:    hprd(rnHours),
      lpnRn: hprd(lpnRnHours),
      total: hprd(totalNurseHours),
    },
  };
}

// ---------- coverage (for initial date defaults) ----------

async function loadCoverage() {
  try {
    const quarters = await loadCatalog();
    const keys = Object.keys(quarters).sort();
    if (!keys.length) { coverageEl.textContent = 'No quarters available.'; return; }
    const earliest = keys[0], latest = keys[keys.length - 1];
    coverageEl.textContent = `Data available: ${earliest} – ${latest} (${keys.length} quarters)`;
    const startEl = $('#startDate');
    const endEl = $('#endDate');
    const earliestISO = quarterToISO(earliest, 'start');
    const latestISO = quarterToISO(latest, 'end');
    latestQuarterURL = quarters[latest];
    latestQuarterKey = latest;
    getFacilityIndex(); // start building search index in background
    const effectiveMin = earliestISO > HARD_MIN_DATE ? earliestISO : HARD_MIN_DATE;
    startEl.min = effectiveMin; startEl.max = latestISO;
    endEl.min = effectiveMin; endEl.max = latestISO;
    const clampToMin = (el) => {
      if (!el.value || el.value >= effectiveMin) return;
      el.value = effectiveMin;
      // Flash the input border
      el.classList.remove('date-flash');
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add('date-flash');
      el.addEventListener('animationend', () => el.classList.remove('date-flash'), { once: true });
      // Show hint popup below the field
      const field = el.closest('.field');
      if (field) {
        field.querySelector('.date-hint')?.remove();
        const hint = document.createElement('div');
        hint.className = 'date-hint';
        hint.textContent = 'Date adjusted to July 1, 2017';
        field.appendChild(hint);
        hint.addEventListener('animationend', () => hint.remove(), { once: true });
      }
    };
    startEl.addEventListener('change', () => clampToMin(startEl));
    endEl.addEventListener('change', () => clampToMin(endEl));
    if (!startEl.value) startEl.value = quarterToISO(latest, 'start');
    if (!endEl.value) endEl.value = latestISO;
  } catch (e) {
    coverageEl.textContent = `Could not load coverage info: ${e.message}`;
  }
}

// ---------- report generation (client-side) ----------

async function generateReport({ providerId, startDate, endDate, onProgress }) {
  const catalog = await loadCatalog();
  const wanted = quartersInRange(startDate, endDate);
  const available = wanted.filter(q => catalog[q]);
  const missing = wanted.filter(q => !catalog[q]);

  const startCompact = isoToCompact(startDate);
  const endCompact = isoToCompact(endDate);

  // Phase 1: fetch facility data to detect state.
  onProgress?.(`Fetching staffing data for facility ${providerId}…`);
  const facilityResults = await Promise.allSettled(
    available.map(q => fetchQuarterForProvider(catalog[q], providerId).then(rows => ({ q, rows })))
  );

  // Detect facility state from first available row.
  let facilityState = null;
  for (const r of facilityResults) {
    if (r.status === 'fulfilled') {
      for (const row of (r.value.rows || [])) {
        if (row.STATE) { facilityState = row.STATE; break; }
      }
      if (facilityState) break;
    }
  }

  // Phase 2: fetch state-wide benchmark using detected state.
  const nyResults = facilityState ? await Promise.allSettled(
    available.map(async (q) => {
      const byDate = await fetchStateQuarterAggregated(catalog[q], q, facilityState, (qk, page, count) => {
        onProgress?.(`Loading ${facilityState} state benchmark ${qk} (page ${page}, ${count} rows)…`);
      });
      return { q, byDate };
    })
  ) : [];

  const errors = [];
  const rowsByQuarter = {};
  for (let i = 0; i < facilityResults.length; i++) {
    const r = facilityResults[i];
    const q = available[i];
    if (r.status === 'rejected') {
      errors.push({ quarter: q, error: String(r.reason && r.reason.message || r.reason) });
    } else {
      rowsByQuarter[q] = r.value.rows;
    }
  }

  const nyByDateMaps = [];
  const nyErrors = [];
  for (let i = 0; i < nyResults.length; i++) {
    const r = nyResults[i];
    const q = available[i];
    if (r.status === 'rejected') {
      nyErrors.push({ quarter: q, error: String(r.reason && r.reason.message || r.reason) });
    } else {
      nyByDateMaps.push(r.value.byDate);
    }
  }

  const allRows = [];
  let facility = null;
  for (const q of available) {
    for (const row of (rowsByQuarter[q] || [])) {
      if (row.WorkDate >= startCompact && row.WorkDate <= endCompact) {
        allRows.push(row);
        if (!facility) {
          facility = {
            provnum: row.PROVNUM,
            provname: row.PROVNAME,
            city: row.CITY,
            state: row.STATE,
            county: row.COUNTY_NAME,
          };
        }
      }
    }
  }
  allRows.sort((a, b) => a.WorkDate.localeCompare(b.WorkDate));

  const nySummary = summarizeNy(nyByDateMaps, startCompact, endCompact);

  // Flatten per-day NY maps so monthly charts can look up any WorkDate directly.
  const nyByDate = Object.assign({}, ...nyByDateMaps);

  return {
    providerId, startDate, endDate,
    facility,
    facilityState,
    quartersQueried: available,
    quartersMissing: missing,
    errors,
    nyErrors,
    rowCount: allRows.length,
    summary: summarize(allRows),
    nySummary,
    nyByDate,
    rows: allRows,
  };
}

// ---------- submit handler ----------

let currentReport = null;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const providerId = $('#providerId').value.trim();
  const startDate = $('#startDate').value;
  const endDate = $('#endDate').value;

  if (!/^\d{6}$/.test(providerId)) {
    setStatus('error', 'Facility ID (CCN) must be exactly 6 digits.');
    return;
  }
  if (!startDate || !endDate) {
    setStatus('error', 'Please pick both a start and end date.');
    return;
  }
  if (endDate < startDate) {
    setStatus('error', 'End date must be on or after start date.');
    return;
  }

  runBtn.disabled = true;
  runBtn.textContent = 'Generating…';
  setStatus('info', `Fetching staffing data for facility ${providerId}…`);
  resultsEl.hidden = true;

  try {
    const data = await generateReport({
      providerId, startDate, endDate,
      onProgress: (msg) => setStatus('info', msg),
    });
    if (data.rowCount === 0) {
      setStatus('error', `No staffing rows found for facility ${providerId} in that range. ` +
                `Double-check the CCN and make sure the range overlaps available quarters.`);
      return;
    }
    currentReport = data;
    renderReport(data);
    setStatus('', '');
    // Fetch star ratings async — don't block report display
    renderStarsDebug('Loading star ratings…');
    fetchStarRatings(data.providerId).then(renderStars).catch((err) => renderStarsDebug(`Error: ${err.message}`));
  } catch (err) {
    console.error(err);
    setStatus('error', `Error: ${err.message}`);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Generate report';
  }
});

// ---------- star ratings ----------

const STARS_CACHE_TTL = 24 * 60 * 60 * 1000;
const STARS_API = 'https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0';

async function fetchStarRatings(provnum) {
  const cacheKey = `pbj.stars.${provnum}.v1`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && Date.now() - cached.ts < STARS_CACHE_TTL) return cached.data;
  } catch (_) {}
  const url = new URL(STARS_API);
  url.searchParams.set('conditions[0][property]', 'provnum');
  url.searchParams.set('conditions[0][value]', provnum);
  url.searchParams.set('conditions[0][operator]', '=');
  url.searchParams.set('limit', '1');
  const res = await fetch(url);
  const rawText = await res.text();
  if (!res.ok) {
    renderStarsDebug(`HTTP ${res.status}: ${rawText.slice(0, 300)}`);
    throw new Error(`Stars API ${res.status}`);
  }
  const json = JSON.parse(rawText);
  const row = (json.results || json.data || json.rows || [])[0] || null;
  renderStarsDebug(JSON.stringify(row || json, null, 2).slice(0, 1000));
  if (row) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: row })); } catch (_) {}
  }
  return row;
}

function renderStarsDebug(msg) {
  const el = document.getElementById('f-stars');
  if (!el) return;
  el.innerHTML = `<pre style="font-size:11px;overflow-x:auto;white-space:pre-wrap;color:#333;background:#f5f5f5;padding:10px;border-radius:6px">${msg}</pre>`;
  el.hidden = false;
}

function renderStars(row) {
  const el = document.getElementById('f-stars');
  if (!el) return;
  if (!row) { el.hidden = true; return; }

  const star = (n) => {
    const v = parseInt(n);
    if (!v || v < 1 || v > 5) return '<span class="star-na">N/A</span>';
    return '<span class="star-filled">' + '★'.repeat(v) + '</span>' +
           '<span class="star-empty">' + '★'.repeat(5 - v) + '</span>';
  };

  // Field names — CMS Care Compare provider info API
  const overall   = row.overall_rating   ?? row.overall          ?? row.overallrating;
  const staffing  = row.staffing_rating  ?? row.staffingrating   ?? row.staffing;
  const inspect   = row.health_inspection_rating ?? row.survey_rating ?? row.healthinspection;
  const quality   = row.quality_rating   ?? row.qm_rating        ?? row.qualitymeasurerating;

  el.innerHTML = `
    <div class="stars-header"><span class="label">CMS Care Compare Ratings</span><span class="muted stars-note">as of last CMS update</span></div>
    <div class="stars-grid">
      <div class="star-item"><div class="star-label">Overall</div><div class="star-row">${star(overall)}</div></div>
      <div class="star-item"><div class="star-label">Health Inspection</div><div class="star-row">${star(inspect)}</div></div>
      <div class="star-item"><div class="star-label">Staffing</div><div class="star-row">${star(staffing)}</div></div>
      <div class="star-item"><div class="star-label">Quality Measures</div><div class="star-row">${star(quality)}</div></div>
    </div>`;
  el.hidden = false;
}

// ---------- render ----------

function renderReport(data) {
  resultsEl.hidden = false;
  document.querySelector('.breakdown').removeAttribute('open');
  document.querySelector('.daily-section').removeAttribute('open');
  if (data.facilityState) updateMinimumsForState(data.facilityState);

  const s = data.summary;
  const f = data.facility || {};
  $('#f-name').textContent = f.provname || '(unknown facility)';
  $('#f-loc').textContent = [f.city, f.state].filter(Boolean).join(', ');
  $('#f-meta').textContent = `CCN ${f.provnum} · ${f.county || ''}`.trim();
  $('#f-range').textContent = `${data.startDate} → ${data.endDate}`;
  $('#f-days').textContent =
    `${data.rowCount} days across ${data.quartersQueried.length} quarter(s) · ` +
    `avg census ${fmt1.format(s.avgDailyCensus)} · ` +
    `${fmt0.format(s.hours.total)} total nurse hours`;

  $('#m-cna').textContent   = fmt2.format(s.hprd.cna);
  $('#m-lpn').textContent   = fmt2.format(s.hprd.lpn);
  $('#m-rn').textContent    = fmt2.format(s.hprd.rn);
  $('#m-lpnrn').textContent = fmt2.format(s.hprd.lpnRn);
  $('#m-total').textContent = fmt2.format(s.hprd.total);

  renderBenchmark(data);
  renderMinimumsLine(data);
  renderCharts(data);
  renderBreakdown(data);
  renderTable(data);

  const notes = [];
  if (data.quartersMissing.length) {
    notes.push(`Quarters not yet published in CMS catalog: ${data.quartersMissing.join(', ')}.`);
  }
  if (data.errors.length) {
    notes.push(`Errors fetching: ${data.errors.map(e => `${e.quarter} (${e.error})`).join('; ')}.`);
  }
  $('#notes').textContent = notes.join(' ');
  initRangeSlider(data);
}

function renderBenchmark(data) {
  const stateLabel = data.facilityState || 'State';
  document.querySelectorAll('.state-avg-label').forEach(el => el.textContent = `${stateLabel} avg`);
  const ny = data.nySummary;
  const s = data.summary;
  const METRICS = [
    ['cna',   'ny-cna',   'd-cna'],
    ['lpn',   'ny-lpn',   'd-lpn'],
    ['rn',    'ny-rn',    'd-rn'],
    ['lpnRn', 'ny-lpnrn', 'd-lpnrn'],
    ['total', 'ny-total', 'd-total'],
  ];
  const hasNy = ny && ny.census > 0;
  for (const [k, nyId, dId] of METRICS) {
    const nyEl = document.getElementById(nyId);
    const dEl = document.getElementById(dId);
    if (!hasNy) {
      nyEl.textContent = '—';
      dEl.textContent = '';
      dEl.className = 'delta';
      continue;
    }
    const nyVal = ny.hprd[k];
    const facVal = s.hprd[k];
    nyEl.textContent = fmt2.format(nyVal);
    if (nyVal > 0 && facVal > 0) {
      const diff = facVal - nyVal;
      const pct = (diff / nyVal) * 100;
      const sign = diff >= 0 ? '▲' : '▼';
      dEl.textContent = `${sign} ${Math.abs(pct).toFixed(1)}%`;
      if (Math.abs(pct) < 2) dEl.className = 'delta neutral';
      else if (pct >= 0) dEl.className = 'delta good';
      else dEl.className = 'delta bad';
    } else {
      dEl.textContent = '';
      dEl.className = 'delta';
    }
  }
}

// ---------- monthly aggregation for charts ----------

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function workDateToMonthKey(d) { return `${d.slice(0,4)}-${d.slice(4,6)}`; }
function monthKeyLabel(k) {
  const [y, m] = k.split('-').map(Number);
  return `${MONTH_LABELS[m-1]} ’${String(y).slice(2)}`;
}

function buildMonthlyBuckets(data) {
  // Collect distinct months from facility rows in chronological order.
  const monthOrder = [];
  const seen = new Set();
  for (const r of data.rows) {
    const k = workDateToMonthKey(r.WorkDate);
    if (!seen.has(k)) { seen.add(k); monthOrder.push(k); }
  }

  // Initialise bucket for each month.
  const empty = () => ({
    facCensus: 0, facCna: 0, facLpn: 0, facRn: 0,
    nyCensus: 0,  nyCna: 0,  nyLpn: 0,  nyRn: 0,
  });
  const buckets = Object.fromEntries(monthOrder.map(k => [k, empty()]));

  // Facility sums per month.
  for (const r of data.rows) {
    const b = buckets[workDateToMonthKey(r.WorkDate)];
    b.facCensus += num(r.MDScensus);
    b.facCna    += cnaHoursRow(r);
    b.facLpn    += lpnHoursRow(r);
    b.facRn     += rnHoursRow(r);
  }

  // NY sums per month, using only the dates inside the requested range that
  // actually have a facility row (so NY and facility cover the same span).
  const rangeDates = new Set(data.rows.map(r => r.WorkDate));
  for (const d of rangeDates) {
    const t = data.nyByDate?.[d];
    if (!t) continue;
    const b = buckets[workDateToMonthKey(d)];
    if (!b) continue;
    b.nyCensus += t.census;
    b.nyCna    += t.cna;
    b.nyLpn    += t.lpn;
    b.nyRn     += t.rn;
  }

  // Turn into per-metric HPRD arrays aligned to monthOrder.
  const hprd = (hours, census) => census > 0 ? hours / census : null;
  const makeRow = (b) => ({
    cna:   { fac: hprd(b.facCna, b.facCensus),                        ny: hprd(b.nyCna, b.nyCensus) },
    lpn:   { fac: hprd(b.facLpn, b.facCensus),                        ny: hprd(b.nyLpn, b.nyCensus) },
    rn:    { fac: hprd(b.facRn,  b.facCensus),                        ny: hprd(b.nyRn,  b.nyCensus) },
    lpnRn: { fac: hprd(b.facLpn + b.facRn, b.facCensus),              ny: hprd(b.nyLpn + b.nyRn, b.nyCensus) },
    total: { fac: hprd(b.facCna + b.facLpn + b.facRn, b.facCensus),   ny: hprd(b.nyCna + b.nyLpn + b.nyRn, b.nyCensus) },
  });

  const perMonth = monthOrder.map(k => ({ key: k, label: monthKeyLabel(k), ...makeRow(buckets[k]) }));
  return perMonth;
}

// ---------- SVG line-chart builder ----------

function buildLineChart({ title, months, series, minValue, minLabel, deltas, width = 560, height = 240 }) {
  const margin = { top: 28, right: 16, bottom: 34, left: 46 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;
  const n = months.length;

  // Y domain
  let yMax = 0;
  for (const s of series) {
    for (const v of s.values) if (Number.isFinite(v) && v > yMax) yMax = v;
  }
  if (Number.isFinite(minValue) && minValue > yMax) yMax = minValue;
  yMax = yMax > 0 ? yMax * 1.18 : 1;

  const x = (i) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => h - (v / yMax) * h;

  // Y gridlines + labels
  const yTicks = 5;
  const grid = [];
  for (let i = 0; i <= yTicks; i++) {
    const yv = (yMax * i) / yTicks;
    const yy = y(yv);
    grid.push(`<line class="grid" x1="0" y1="${yy.toFixed(1)}" x2="${w}" y2="${yy.toFixed(1)}"/>`);
    grid.push(`<text class="tick" x="-8" y="${yy.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${yv.toFixed(2)}</text>`);
  }

  // X labels — thin out if too many to avoid overlap.
  const maxLabels = Math.max(2, Math.min(n, Math.floor(w / 55)));
  const stride = Math.max(1, Math.ceil(n / maxLabels));
  const xLabels = [];
  for (let i = 0; i < n; i++) {
    if (i % stride !== 0 && i !== n - 1) continue;
    const px = x(i);
    xLabels.push(`<text class="tick" x="${px.toFixed(1)}" y="${(h + 18).toFixed(1)}" text-anchor="middle">${months[i]}</text>`);
  }

  // Min line (horizontal reference)
  let minEl = '';
  if (Number.isFinite(minValue) && minValue > 0) {
    const my = y(minValue);
    minEl = `
      <line class="min" x1="0" y1="${my.toFixed(1)}" x2="${w}" y2="${my.toFixed(1)}"/>
      <text class="min-label" x="${w}" y="${(my - 5).toFixed(1)}" text-anchor="end">${minLabel || 'Min'} ${minValue.toFixed(2)}</text>
    `;
  }

  // Lines for each series (no dots — clean lines per user preference).
  const lines = [];
  for (const s of series) {
    const parts = [];
    let cmd = 'M';
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) { cmd = 'M'; continue; }
      const px = x(i); const py = y(v);
      parts.push(`${cmd}${px.toFixed(1)},${py.toFixed(1)}`);
      cmd = 'L';
    }
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
    lines.push(`<path d="${parts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
  }

  // Legend
  const legendItems = series.map(s => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${s.color};${s.dash ? 'background-image:repeating-linear-gradient(90deg,'+s.color+' 0 4px,transparent 4px 7px);background-color:transparent;' : ''}"></span>
      ${s.label}
    </span>
  `).join('');
  const minLegend = Number.isFinite(minValue) && minValue > 0
    ? `<span class="legend-item"><span class="legend-swatch legend-min"></span>${minLabel || 'State min'} ${minValue.toFixed(2)}</span>` : '';

  // Deltas under the title (NY avg and NYS min if provided)
  const pill = (d) => {
    if (!d) return '';
    const cls = d.cls || 'neutral';
    const arrow = d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : '→';
    return `<span class="chart-delta ${cls}">${arrow} ${d.pct} ${d.suffix}</span>`;
  };
  const deltasHtml = deltas && (deltas.ny || deltas.min)
    ? `<div class="chart-deltas">${pill(deltas.ny)}${pill(deltas.min)}</div>`
    : '';

  return `
    <div class="chart">
      <div class="chart-head">
        <div class="chart-title-wrap">
          <div class="chart-title">${title}</div>
          ${deltasHtml}
        </div>
        <div class="chart-legend">${legendItems}${minLegend}</div>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
        <g transform="translate(${margin.left}, ${margin.top})">
          ${grid.join('')}
          ${minEl}
          ${lines.join('')}
          <g>${xLabels.join('')}</g>
        </g>
      </svg>
    </div>
  `;
}

// Given a facility HPRD and a reference value, produce a delta descriptor.
function deltaDescriptor(facVal, refVal, suffix) {
  if (!Number.isFinite(facVal) || !Number.isFinite(refVal) || refVal <= 0) return null;
  const diff = facVal - refVal;
  const pct = (diff / refVal) * 100;
  let cls, dir;
  if (Math.abs(pct) < 2) { cls = 'neutral'; dir = 'flat'; }
  else if (pct >= 0)     { cls = 'good';    dir = 'up';   }
  else                   { cls = 'bad';     dir = 'down'; }
  return { pct: `${Math.abs(pct).toFixed(1)}%`, cls, dir, suffix };
}

function renderCharts(data) {
  const container = document.getElementById('charts');
  if (!container) return;

  const monthly = buildMonthlyBuckets(data);
  if (monthly.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;

  const months = monthly.map(m => m.label);
  const facColor = '#1f5fae';
  const nyColor  = '#5a6675';

  const stateLabel = data.facilityState || 'State';
  const mkSeries = (key) => ([
    { label: 'Facility',          color: facColor, width: 2.5, values: monthly.map(m => m[key].fac) },
    { label: `${stateLabel} avg`, color: nyColor,  width: 2,   dash: '5 4', values: monthly.map(m => m[key].ny) },
  ]);

  const charts = [
    { key: 'cna',   title: 'CNA HPRD',      minValue: nysMinimums.cna   },
    { key: 'lpn',   title: 'LPN HPRD',      minValue: null              },
    { key: 'rn',    title: 'RN HPRD',       minValue: null              },
    { key: 'lpnRn', title: 'LPN + RN HPRD', minValue: nysMinimums.lpnRn },
    { key: 'total', title: 'Total HPRD',    minValue: nysMinimums.total },
  ];

  const facHprd = data.summary.hprd;
  const nyHprd = data.nySummary && data.nySummary.census > 0 ? data.nySummary.hprd : null;

  container.innerHTML = charts.map(c => {
    const deltas = {
      ny:  nyHprd ? deltaDescriptor(facHprd[c.key], nyHprd[c.key], `vs ${stateLabel} avg`) : null,
      min: c.minValue ? deltaDescriptor(facHprd[c.key], c.minValue, `vs ${stateLabel} min`) : null,
    };
    return buildLineChart({
      title: c.title,
      months,
      series: mkSeries(c.key),
      minValue: c.minValue,
      minLabel: `${stateLabel} min`,
      deltas,
    });
  }).join('');
}

function renderMinimumsLine(data) {
  const s = data.summary;
  const METRICS = [
    ['cna',   'min-v-cna',   'min-d-cna',   nysMinimums.cna],
    ['lpnRn', 'min-v-lpnrn', 'min-d-lpnrn', nysMinimums.lpnRn],
    ['total', 'min-v-total', 'min-d-total', nysMinimums.total],
  ];
  for (const [k, vId, dId, minVal] of METRICS) {
    const vEl = document.getElementById(vId);
    const dEl = document.getElementById(dId);
    if (!Number.isFinite(minVal) || minVal <= 0) {
      vEl.textContent = '—';
      dEl.textContent = '';
      dEl.className = 'delta';
      continue;
    }
    vEl.textContent = fmt2.format(minVal);
    const facVal = s.hprd[k];
    const diff = facVal - minVal;
    const pct = minVal > 0 ? (diff / minVal) * 100 : 0;
    if (facVal >= minVal) {
      dEl.textContent = `▲ ${Math.abs(pct).toFixed(1)}%`;
      dEl.className = 'delta good';
    } else {
      dEl.textContent = `▼ ${Math.abs(pct).toFixed(1)}%`;
      dEl.className = 'delta bad';
    }
  }
}

function renderBreakdown(data) {
  const s = data.summary;
  const ft = s.fieldTotals;
  const fmtH = (v) => fmt2.format(v) + ' hrs';
  const RAW_LABELS = {
    Hrs_RN:       ['Hrs_RN',       'RN (direct care)',     true],
    Hrs_RNDON:    ['Hrs_RNDON',    'RN Director of Nursing', true],
    Hrs_RNadmin:  ['Hrs_RNadmin',  'RN with admin duties', true],
    Hrs_LPN:      ['Hrs_LPN',      'LPN (direct care)',    true],
    Hrs_LPNadmin: ['Hrs_LPNadmin', 'LPN with admin duties', false],
    Hrs_CNA:      ['Hrs_CNA',      'CNA',                  true],
    Hrs_NAtrn:    ['Hrs_NAtrn',    'Nurse Aide in training', false],
    Hrs_MedAide:  ['Hrs_MedAide',  'Medication Aide',      true],
  };

  const rawRows = RAW_HOUR_FIELDS.map(f => {
    const [name, desc, included] = RAW_LABELS[f];
    const cls = included ? '' : 'class="excluded"';
    const note = included ? '' : ' <span class="excluded-tag">excluded</span>';
    return `<tr ${cls}><td><code>${name}</code>${note}</td><td class="num">${fmtH(ft[f])}</td><td class="muted">${desc}</td></tr>`;
  }).join('');
  $('#raw-table').innerHTML = rawRows;

  const censusRows = `
    <tr><td>Days in result</td><td class="num">${fmt0.format(s.days)}</td></tr>
    <tr><td>Days with census &gt; 0</td><td class="num">${fmt0.format(s.censusDays)}</td></tr>
    <tr><td>Avg daily census</td><td class="num">${fmt2.format(s.avgDailyCensus)}</td></tr>
    <tr><td><strong>Total resident-days</strong> (denominator)</td><td class="num"><strong>${fmt0.format(s.totalCensus)}</strong></td></tr>
  `;
  $('#census-table').innerHTML = censusRows;

  const denom = s.totalCensus;
  const showHprd = (hours) => denom > 0 ? `${fmt2.format(hours)} ÷ ${fmt0.format(denom)} = <strong>${fmt2.format(hours/denom)}</strong>` : '—';

  const formulaRows = `
    <tr>
      <td><strong>CNA HPRD</strong><br><span class="muted">Hrs_CNA + Hrs_MedAide</span></td>
      <td class="num">${fmt2.format(ft.Hrs_CNA)} + ${fmt2.format(ft.Hrs_MedAide)} = ${fmt2.format(s.hours.cna)}</td>
      <td class="num">${showHprd(s.hours.cna)}</td>
    </tr>
    <tr>
      <td><strong>LPN HPRD</strong><br><span class="muted">Hrs_LPN</span></td>
      <td class="num">${fmt2.format(s.hours.lpn)}</td>
      <td class="num">${showHprd(s.hours.lpn)}</td>
    </tr>
    <tr>
      <td><strong>RN HPRD</strong><br><span class="muted">Hrs_RN + Hrs_RNDON + Hrs_RNadmin</span></td>
      <td class="num">${fmt2.format(ft.Hrs_RN)} + ${fmt2.format(ft.Hrs_RNDON)} + ${fmt2.format(ft.Hrs_RNadmin)} = ${fmt2.format(s.hours.rn)}</td>
      <td class="num">${showHprd(s.hours.rn)}</td>
    </tr>
    <tr>
      <td><strong>LPN + RN HPRD</strong><br><span class="muted">LPN + RN</span></td>
      <td class="num">${fmt2.format(s.hours.lpn)} + ${fmt2.format(s.hours.rn)} = ${fmt2.format(s.hours.lpnRn)}</td>
      <td class="num">${showHprd(s.hours.lpnRn)}</td>
    </tr>
    <tr class="formula-total">
      <td><strong>Total HPRD</strong><br><span class="muted">CNA + LPN + RN</span></td>
      <td class="num">${fmt2.format(s.hours.cna)} + ${fmt2.format(s.hours.lpnRn)} = ${fmt2.format(s.hours.total)}</td>
      <td class="num">${showHprd(s.hours.total)}</td>
    </tr>
    <tr class="excluded-row">
      <td colspan="3" class="muted">
        Excluded from totals: <code>Hrs_LPNadmin</code> (${fmt2.format(ft.Hrs_LPNadmin)} hrs) and
        <code>Hrs_NAtrn</code> (${fmt2.format(ft.Hrs_NAtrn)} hrs) — total ${fmt2.format(s.hours.excluded)} hrs.
        If you include these, Total HPRD becomes <strong>${denom > 0 ? fmt2.format((s.hours.total + s.hours.excluded) / denom) : '—'}</strong>.
      </td>
    </tr>
  `;
  $('#formula-table').innerHTML = formulaRows;

  // ---- state benchmark row in the same panel ----
  const ny = data.nySummary;
  const st = data.facilityState || 'State';
  if (ny && ny.census > 0) {
    const nyBlock = `
      <tr class="ny-header"><td colspan="3"><strong>All ${st} benchmark over the same period</strong></td></tr>
      <tr><td>${st} rows / distinct days</td><td class="num">${fmt0.format(ny.rows)} / ${fmt0.format(ny.distinctDates)}</td><td class="muted">Sum of per-facility daily rows across all ${st} facilities.</td></tr>
      <tr><td><strong>${st} total resident-days</strong></td><td class="num"><strong>${fmt0.format(ny.census)}</strong></td><td class="muted">Denominator for ${st} HPRDs.</td></tr>
      <tr><td>${st} CNA hours</td><td class="num">${fmt0.format(ny.hours.cna)}</td><td class="num">${fmt0.format(ny.hours.cna)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.cna)}</strong></td></tr>
      <tr><td>${st} LPN hours</td><td class="num">${fmt0.format(ny.hours.lpn)}</td><td class="num">${fmt0.format(ny.hours.lpn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.lpn)}</strong></td></tr>
      <tr><td>${st} RN hours</td><td class="num">${fmt0.format(ny.hours.rn)}</td><td class="num">${fmt0.format(ny.hours.rn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.rn)}</strong></td></tr>
      <tr><td>${st} LPN + RN hours</td><td class="num">${fmt0.format(ny.hours.lpnRn)}</td><td class="num">${fmt0.format(ny.hours.lpnRn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.lpnRn)}</strong></td></tr>
      <tr class="formula-total"><td><strong>${st} Total hours</strong></td><td class="num">${fmt0.format(ny.hours.total)}</td><td class="num">${fmt0.format(ny.hours.total)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.total)}</strong></td></tr>
    `;
    $('#formula-table').insertAdjacentHTML('beforeend', nyBlock);
  }
}

function renderTable(data) {
  const split = splitToggle.checked;
  const thead = tableEl.querySelector('thead');
  const tbody = tableEl.querySelector('tbody');

  const headers = ['Date', 'Census'];
  for (const g of STAFF_GROUPS) {
    if (split) headers.push(`${g.label} total`, `${g.label} emp`, `${g.label} ctr`);
    else headers.push(`${g.label} hrs`);
  }
  headers.push('Total nurse hrs', 'HPRD');

  thead.innerHTML = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;

  const rowsHtml = [];
  const totals = Array(headers.length).fill(0);
  let censusSum = 0;

  for (const r of data.rows) {
    const cells = [workDateToISO(r.WorkDate), fmt0.format(num(r.MDScensus))];
    for (const g of STAFF_GROUPS) {
      const total = num(r[g.field]);
      if (split) {
        cells.push(
          fmt2.format(total),
          fmt2.format(num(r[`${g.field}_emp`])),
          fmt2.format(num(r[`${g.field}_ctr`])),
        );
      } else {
        cells.push(fmt2.format(total));
      }
    }
    const dayHours = totalHoursRow(r); // CNA + LPN_non_admin + RN_all
    const census = num(r.MDScensus);
    const hprd = census > 0 ? dayHours / census : 0;
    cells.push(fmt2.format(dayHours), fmt2.format(hprd));
    rowsHtml.push(`<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`);

    totals[1] += census;
    censusSum += census;
    let colIdx = 2;
    for (const g of STAFF_GROUPS) {
      if (split) {
        totals[colIdx++] += num(r[g.field]);
        totals[colIdx++] += num(r[`${g.field}_emp`]);
        totals[colIdx++] += num(r[`${g.field}_ctr`]);
      } else {
        totals[colIdx++] += num(r[g.field]);
      }
    }
    totals[colIdx++] += dayHours;
  }

  const totalHprd = censusSum > 0 ? totals[totals.length - 2] / censusSum : 0;
  const totalsRow = headers.map((_, i) => {
    if (i === 0) return `<td>Totals (${data.rowCount} days)</td>`;
    if (i === 1) return `<td>${fmt0.format(totals[1])}</td>`;
    if (i === headers.length - 1) return `<td>${fmt2.format(totalHprd)}</td>`;
    return `<td>${fmt2.format(totals[i])}</td>`;
  }).join('');

  tbody.innerHTML = rowsHtml.join('') + `<tr class="totals-row">${totalsRow}</tr>`;
}

splitToggle.addEventListener('change', () => {
  if (currentReport) renderTable(currentReport);
});

// ---------- minimum inputs ----------

function updateMinimumsForState(state) {
  currentFacilityState = state;
  nysMinimums = loadMinimums(state);
  const d = getStateMinDefaults(state);
  const stateName = STATE_NAMES[state] || state || 'Federal';
  const titleEl = document.getElementById('minimums-title');
  const statuteEl = document.getElementById('minimums-statute');
  if (titleEl) titleEl.textContent = `${stateName} Staffing Minimums`;
  if (statuteEl) statuteEl.textContent = d.statute ? `· ${d.statute}` : '';
  const fmtInput = (v) => (Number.isFinite(v) && v > 0 ? v : 0).toFixed(2);
  document.getElementById('min-cna').value   = fmtInput(nysMinimums.cna);
  document.getElementById('min-lpnrn').value = fmtInput(nysMinimums.lpnRn);
  document.getElementById('min-total').value = fmtInput(nysMinimums.total);
}

function initMinimumInputs() {
  const cfg = [
    ['min-cna',   'cna'],
    ['min-lpnrn', 'lpnRn'],
    ['min-total', 'total'],
  ];
  const fmtInput = (v) => (Number.isFinite(v) ? v : 0).toFixed(2);
  for (const [id, key] of cfg) {
    const el = document.getElementById(id);
    el.value = fmtInput(nysMinimums[key]);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      nysMinimums[key] = Number.isFinite(v) ? v : 0;
      saveMinimums(currentFacilityState, nysMinimums);
      if (currentReport) {
        renderMinimumsLine(currentReport);
        renderCharts(currentReport);
      }
    });
    el.addEventListener('blur', () => {
      el.value = fmtInput(nysMinimums[key]);
    });
    const tile = el.closest('.min-tile');
    if (tile) {
      tile.addEventListener('click', (e) => {
        if (e.target !== el) el.focus();
      });
    }
  }
  const resetBtn = document.getElementById('min-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const d = getStateMinDefaults(currentFacilityState);
      nysMinimums = { cna: d.cna, lpnRn: d.lpnRn, total: d.total };
      saveMinimums(currentFacilityState, nysMinimums);
      for (const [id, key] of cfg) {
        document.getElementById(id).value = fmtInput(nysMinimums[key]);
      }
      if (currentReport) {
        renderMinimumsLine(currentReport);
        renderCharts(currentReport);
      }
    });
  }
}
initMinimumInputs();
initRangeSliderEvents();

// ---------- CSV export ----------

csvBtn.addEventListener('click', () => {
  if (!currentReport) return;
  const rows = currentReport.rows;
  const cols = [
    'PROVNUM','PROVNAME','CITY','STATE','WorkDate','MDScensus',
    'Hrs_RN','Hrs_RN_emp','Hrs_RN_ctr',
    'Hrs_RNDON','Hrs_RNDON_emp','Hrs_RNDON_ctr',
    'Hrs_RNadmin','Hrs_RNadmin_emp','Hrs_RNadmin_ctr',
    'Hrs_LPN','Hrs_LPN_emp','Hrs_LPN_ctr',
    'Hrs_LPNadmin','Hrs_LPNadmin_emp','Hrs_LPNadmin_ctr',
    'Hrs_CNA','Hrs_CNA_emp','Hrs_CNA_ctr',
    'Hrs_NAtrn','Hrs_NAtrn_emp','Hrs_NAtrn_ctr',
    'Hrs_MedAide','Hrs_MedAide_emp','Hrs_MedAide_ctr',
  ];
  const head = cols.join(',');
  const lines = [head];
  for (const r of rows) {
    lines.push(cols.map(k => csvCell(r[k])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PBJ_${currentReport.providerId}_${currentReport.startDate}_${currentReport.endDate}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}

// ---------- Excel export ----------

// Rasterize a chart's SVG (already sized via viewBox) to a PNG data URL for
// embedding in an Excel sheet. Returns { base64, width, height }.
async function svgToPngBase64(svgEl, scale = 2) {
  const serializer = new XMLSerializer();
  let source = serializer.serializeToString(svgEl);
  // Make sure the SVG has the xmlns so the <img> can load it.
  if (!source.includes('xmlns="http://www.w3.org/2000/svg"')) {
    source = source.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // Pull natural dimensions from viewBox if width/height aren't numeric.
  const vb = (svgEl.getAttribute('viewBox') || '0 0 560 240').split(/\s+/).map(Number);
  const baseW = vb[2] || 560;
  const baseH = vb[3] || 240;

  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(baseW * scale);
    canvas.height = Math.round(baseH * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return { base64: dataUrl.split(',')[1], width: baseW, height: baseH };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Render a chart HTML string (from buildLineChart) into a hidden DOM node,
// rasterize its <svg> to a PNG, and clean up. Lets us produce charts that are
// generated directly from the data in a specific export tab without needing
// the live on-page charts.
async function renderChartHtmlToPng(html, scale = 2) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;';
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  try {
    const svg = wrapper.querySelector('svg');
    if (!svg) throw new Error('no svg produced by buildLineChart');
    return await svgToPngBase64(svg, scale);
  } finally {
    wrapper.remove();
  }
}

// Aggregate NY data into one row per month (for the NY state monthly tab).
function nyMonthlyRows(nyByDate, startCompact, endCompact) {
  const months = {};
  for (const [d, t] of Object.entries(nyByDate || {})) {
    if (d < startCompact || d > endCompact) continue;
    const k = workDateToMonthKey(d);
    const m = months[k] || (months[k] = {
      month: k, days: 0, rows: 0,
      census: 0, cna: 0, lpn: 0, rn: 0, lpnAdmin: 0, naTrn: 0,
    });
    m.days     += 1;
    m.rows     += t.rows;
    m.census   += t.census;
    m.cna      += t.cna;
    m.lpn      += t.lpn;
    m.rn       += t.rn;
    m.lpnAdmin += t.lpnAdmin;
    m.naTrn    += t.naTrn;
  }
  const out = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
  for (const m of out) {
    const hprd = (h) => m.census > 0 ? h / m.census : null;
    m.cna_hprd   = hprd(m.cna);
    m.lpn_hprd   = hprd(m.lpn);
    m.rn_hprd    = hprd(m.rn);
    m.lpnRn_hprd = hprd(m.lpn + m.rn);
    m.total_hprd = hprd(m.cna + m.lpn + m.rn);
  }
  return out;
}

// Short helpers for building metric tabs.
const METRIC_DEFS = [
  { key: 'cna',   label: 'CNA HPRD',      desc: 'Hrs_CNA + Hrs_MedAide',                  minKey: 'cna'   },
  { key: 'lpn',   label: 'LPN HPRD',      desc: 'Hrs_LPN',                                minKey: null    },
  { key: 'rn',    label: 'RN HPRD',       desc: 'Hrs_RN + Hrs_RNDON + Hrs_RNadmin',       minKey: null    },
  { key: 'lpnRn', label: 'LPN + RN HPRD', desc: 'LPN + RN',                               minKey: 'lpnRn' },
  { key: 'total', label: 'Total HPRD',    desc: 'CNA + LPN + RN',                         minKey: 'total' },
];

function metricHoursRow(key, r) {
  switch (key) {
    case 'cna':   return cnaHoursRow(r);
    case 'lpn':   return lpnHoursRow(r);
    case 'rn':    return rnHoursRow(r);
    case 'lpnRn': return lpnRnHoursRow(r);
    case 'total': return totalHoursRow(r);
  }
  return 0;
}

async function exportExcel() {
  if (!currentReport) return;
  if (typeof ExcelJS === 'undefined') {
    alert('Excel library is still loading. Please try again in a moment.');
    return;
  }
  const data = currentReport;
  const report = `PBJ_${data.providerId}_${data.startDate}_${data.endDate}`;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PBJ Daily Nurse Staffing Reports';
  wb.created = new Date();

  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F8' } };
  const HEADER_FONT = { bold: true, color: { argb: 'FF1B2330' } };
  const NUM2 = '0.00';
  const NUM0 = '#,##0';

  const styleHeader = (ws, rowNum) => {
    const row = ws.getRow(rowNum);
    row.font = HEADER_FONT;
    row.fill = HEADER_FILL;
    row.alignment = { vertical: 'middle' };
  };

  // ---- Tab 1: All PBJ Data ----
  {
    const ws = wb.addWorksheet('All PBJ Data');
    const cols = [
      { header: 'PROVNUM',     key: 'PROVNUM',     width: 10 },
      { header: 'PROVNAME',    key: 'PROVNAME',    width: 36 },
      { header: 'CITY',        key: 'CITY',        width: 18 },
      { header: 'STATE',       key: 'STATE',       width: 7 },
      { header: 'COUNTY_NAME', key: 'COUNTY_NAME', width: 16 },
      { header: 'CY_Qtr',      key: 'CY_Qtr',      width: 9 },
      { header: 'WorkDate',    key: 'WorkDate',    width: 12 },
      { header: 'MDScensus',   key: 'MDScensus',   width: 11, numFmt: NUM0 },
    ];
    const hrCols = [
      'Hrs_RN','Hrs_RN_emp','Hrs_RN_ctr',
      'Hrs_RNDON','Hrs_RNDON_emp','Hrs_RNDON_ctr',
      'Hrs_RNadmin','Hrs_RNadmin_emp','Hrs_RNadmin_ctr',
      'Hrs_LPN','Hrs_LPN_emp','Hrs_LPN_ctr',
      'Hrs_LPNadmin','Hrs_LPNadmin_emp','Hrs_LPNadmin_ctr',
      'Hrs_CNA','Hrs_CNA_emp','Hrs_CNA_ctr',
      'Hrs_NAtrn','Hrs_NAtrn_emp','Hrs_NAtrn_ctr',
      'Hrs_MedAide','Hrs_MedAide_emp','Hrs_MedAide_ctr',
    ];
    for (const h of hrCols) cols.push({ header: h, key: h, width: 13, numFmt: NUM2 });
    ws.columns = cols;
    for (const r of data.rows) {
      const rowObj = {};
      for (const c of cols) {
        const k = c.key;
        if (k === 'WorkDate') {
          rowObj[k] = workDateToISO(r.WorkDate);
        } else if (k === 'MDScensus' || k.startsWith('Hrs_')) {
          rowObj[k] = num(r[k]);
        } else {
          rowObj[k] = r[k] || '';
        }
      }
      ws.addRow(rowObj);
    }
    styleHeader(ws, 1);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // ---- Tab 2: NY State Monthly ----
  const startCompactForNy = isoToCompact(data.startDate);
  const endCompactForNy = isoToCompact(data.endDate);
  const nyMonthly = nyMonthlyRows(data.nyByDate, startCompactForNy, endCompactForNy);
  {
    const ws = wb.addWorksheet(`${data.facilityState || 'State'} Monthly`);
    ws.columns = [
      { header: 'Month',              key: 'month',    width: 10 },
      { header: 'Days',               key: 'days',     width: 8,  numFmt: NUM0 },
      { header: 'Facility-day rows',  key: 'rows',     width: 18, numFmt: NUM0 },
      { header: 'NY resident-days',   key: 'census',   width: 18, numFmt: NUM0 },
      { header: 'CNA hours',          key: 'cna',      width: 15, numFmt: NUM0 },
      { header: 'LPN hours',          key: 'lpn',      width: 15, numFmt: NUM0 },
      { header: 'RN hours',           key: 'rn',       width: 15, numFmt: NUM0 },
      { header: 'LPN admin hrs',      key: 'lpnAdmin', width: 15, numFmt: NUM0 },
      { header: 'NA trainee hrs',     key: 'naTrn',    width: 15, numFmt: NUM0 },
      { header: 'CNA HPRD',           key: 'cna_hprd', width: 12, numFmt: NUM2 },
      { header: 'LPN HPRD',           key: 'lpn_hprd', width: 12, numFmt: NUM2 },
      { header: 'RN HPRD',            key: 'rn_hprd',  width: 12, numFmt: NUM2 },
      { header: 'LPN+RN HPRD',        key: 'lpnRn_hprd', width: 14, numFmt: NUM2 },
      { header: 'Total HPRD',         key: 'total_hprd', width: 13, numFmt: NUM2 },
    ];
    for (const m of nyMonthly) ws.addRow(m);
    styleHeader(ws, 1);
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Build a 5-series line chart from the rows above (this tab's own data)
    // and embed it below the table so the chart clearly visualises the data
    // in this sheet.
    if (nyMonthly.length > 0) {
      try {
        const nyChartHtml = buildLineChart({
          title: `${data.facilityState || 'State'} HPRD by month`,
          months: nyMonthly.map(m => monthKeyLabel(m.month)),
          series: [
            { label: 'CNA',      color: '#1f5fae', width: 2, values: nyMonthly.map(m => m.cna_hprd)   },
            { label: 'LPN',      color: '#177245', width: 2, values: nyMonthly.map(m => m.lpn_hprd)   },
            { label: 'RN',       color: '#b35800', width: 2, values: nyMonthly.map(m => m.rn_hprd)    },
            { label: 'LPN + RN', color: '#6b3ea3', width: 2, values: nyMonthly.map(m => m.lpnRn_hprd) },
            { label: 'Total',    color: '#c23b43', width: 2.5, values: nyMonthly.map(m => m.total_hprd) },
          ],
          width: 720,
          height: 300,
        });
        const png = await renderChartHtmlToPng(nyChartHtml, 2);
        const imageId = wb.addImage({ base64: png.base64, extension: 'png' });
        const imgRow = nyMonthly.length + 3;
        ws.addImage(imageId, {
          tl: { col: 0, row: imgRow },
          ext: { width: 820, height: 340 },
        });
      } catch (e) {
        ws.getCell(`A${nyMonthly.length + 3}`).value = `(chart unavailable: ${e.message || e})`;
      }
    }
  }

  // ---- Tabs 3-7: one per metric ----
  const perMonth = buildMonthlyBuckets(data);

  for (const def of METRIC_DEFS) {
    const ws = wb.addWorksheet(def.label.replace(' HPRD', ''));
    const minVal = def.minKey ? nysMinimums[def.minKey] : null;

    // Header / summary block
    ws.mergeCells('A1:G1');
    ws.getCell('A1').value = `${def.label} (${def.desc})`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.mergeCells('A2:G2');
    ws.getCell('A2').value =
      `${data.facility?.provname || ''}  ·  CCN ${data.providerId}  ·  ${data.startDate} → ${data.endDate}`;
    ws.getCell('A2').font = { color: { argb: 'FF5A6675' } };

    const s = data.summary.hprd[def.key];
    const nyS = data.nySummary && data.nySummary.census > 0 ? data.nySummary.hprd[def.key] : null;
    const nyDelta = Number.isFinite(nyS) && nyS > 0 ? ((s - nyS) / nyS) * 100 : null;
    const minDelta = Number.isFinite(minVal) && minVal > 0 ? ((s - minVal) / minVal) * 100 : null;

    const xlStateLabel = data.facilityState || 'State';
    ws.getCell('A4').value = 'Facility HPRD (full period)';
    ws.getCell('B4').value = s; ws.getCell('B4').numFmt = NUM2;
    ws.getCell('A5').value = `${xlStateLabel} state average HPRD (same period)`;
    ws.getCell('B5').value = nyS; ws.getCell('B5').numFmt = NUM2;
    ws.getCell('C5').value = nyDelta != null ? `${nyDelta >= 0 ? '+' : ''}${nyDelta.toFixed(1)}% vs ${xlStateLabel} avg` : '';
    if (minVal) {
      ws.getCell('A6').value = `${xlStateLabel} minimum HPRD`;
      ws.getCell('B6').value = minVal; ws.getCell('B6').numFmt = NUM2;
      ws.getCell('C6').value = minDelta != null ? `${minDelta >= 0 ? '+' : ''}${minDelta.toFixed(1)}% vs ${xlStateLabel} min` : '';
    }

    // Monthly comparison table
    const headerRow = minVal ? 8 : 8;
    ws.getCell(`A${headerRow}`).value = 'Month';
    ws.getCell(`B${headerRow}`).value = 'Facility HPRD';
    ws.getCell(`C${headerRow}`).value = `${xlStateLabel} avg HPRD`;
    ws.getCell(`D${headerRow}`).value = `vs ${xlStateLabel} avg %`;
    if (minVal) {
      ws.getCell(`E${headerRow}`).value = `${xlStateLabel} min`;
      ws.getCell(`F${headerRow}`).value = `vs ${xlStateLabel} min %`;
    }
    styleHeader(ws, headerRow);
    ws.getColumn('A').width = 12;
    ws.getColumn('B').width = 15;
    ws.getColumn('C').width = 15;
    ws.getColumn('D').width = 14;
    ws.getColumn('E').width = 12;
    ws.getColumn('F').width = 15;

    let r = headerRow + 1;
    for (const m of perMonth) {
      const fac = m[def.key].fac;
      const ny  = m[def.key].ny;
      ws.getCell(`A${r}`).value = m.label;
      if (Number.isFinite(fac)) { ws.getCell(`B${r}`).value = fac; ws.getCell(`B${r}`).numFmt = NUM2; }
      if (Number.isFinite(ny))  { ws.getCell(`C${r}`).value = ny;  ws.getCell(`C${r}`).numFmt = NUM2; }
      if (Number.isFinite(fac) && Number.isFinite(ny) && ny > 0) {
        ws.getCell(`D${r}`).value = (fac - ny) / ny;
        ws.getCell(`D${r}`).numFmt = '+0.0%;-0.0%;0.0%';
      }
      if (minVal) {
        ws.getCell(`E${r}`).value = minVal;
        ws.getCell(`E${r}`).numFmt = NUM2;
        if (Number.isFinite(fac) && minVal > 0) {
          ws.getCell(`F${r}`).value = (fac - minVal) / minVal;
          ws.getCell(`F${r}`).numFmt = '+0.0%;-0.0%;0.0%';
        }
      }
      r += 1;
    }

    // Generate the chart fresh from this tab's monthly rows so it visualises
    // exactly the numbers printed in the table above.
    try {
      const months = perMonth.map(m => m.label);
      const series = [
        { label: 'Facility', color: '#1f5fae', width: 2.5, values: perMonth.map(m => m[def.key].fac) },
        { label: `${xlStateLabel} avg`, color: '#5a6675', width: 2,   dash: '5 4', values: perMonth.map(m => m[def.key].ny) },
      ];
      const chartHtml = buildLineChart({
        title: def.label,
        months,
        series,
        minValue: minVal,
        minLabel: `${xlStateLabel} min`,
        width: 720,
        height: 300,
      });
      const png = await renderChartHtmlToPng(chartHtml, 2);
      const imageId = wb.addImage({ base64: png.base64, extension: 'png' });
      const imgRow = r + 2;
      ws.addImage(imageId, {
        tl: { col: 0, row: imgRow - 1 },
        ext: { width: 820, height: 340 },
      });
    } catch (e) {
      ws.getCell(`A${r + 2}`).value = `(chart image unavailable: ${e.message || e})`;
    }

    ws.views = [{ state: 'frozen', ySplit: headerRow }];
  }

  // ---- Save ----
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${report}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const xlsxBtn = document.getElementById('xlsx');
if (xlsxBtn) {
  xlsxBtn.addEventListener('click', async () => {
    if (!currentReport) return;
    const prev = xlsxBtn.textContent;
    xlsxBtn.disabled = true;
    xlsxBtn.textContent = 'Exporting…';
    try {
      await exportExcel();
    } catch (e) {
      console.error(e);
      alert(`Excel export failed: ${e.message || e}`);
    } finally {
      xlsxBtn.textContent = prev;
      xlsxBtn.disabled = false;
    }
  });
}

// ---------- facility index for name search ----------
// Fetches one day's worth of data (one row per facility) using filter[WorkDate],
// which is the only reliable filter on the CMS API. ~2-3 pages covers all ~15k facilities.

let facilityIndexPromise = null;

function getFacilityIndex() {
  if (facilityIndexPromise) return facilityIndexPromise;
  facilityIndexPromise = (async () => {
    const cacheKey = 'pbj.facilityIndex.v3';
    const ttl = 7 * 24 * 60 * 60 * 1000;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const { ts, list } = JSON.parse(raw);
        if (Date.now() - ts < ttl && list && list.length > 100) return list;
      }
    } catch {}
    if (!latestQuarterURL || !latestQuarterKey) return null;
    try {
      // Pick the 15th of the first month of the latest quarter — enough time for most
      // facilities to have submitted data, but still early in the quarter.
      const qStart = quarterToISO(latestQuarterKey, 'start'); // e.g. "2024-07-01"
      const workDate = qStart.slice(0, 8) + '15';             // e.g. "2024-07-15"
      const workDateCompact = isoToCompact(workDate);          // "20240715"

      const facilityMap = {};
      let offset = 0;
      while (true) {
        const url = new URL(latestQuarterURL);
        url.searchParams.set('filter[WorkDate]', workDateCompact);
        url.searchParams.set('size', String(STATE_PAGE_SIZE));
        url.searchParams.set('offset', String(offset));
        const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        for (const r of rows) {
          if (r.PROVNUM && r.PROVNAME && !facilityMap[r.PROVNUM]) {
            facilityMap[r.PROVNUM] = { PROVNUM: r.PROVNUM, PROVNAME: r.PROVNAME, CITY: r.CITY || '', STATE: r.STATE || '' };
          }
        }
        if (rows.length < STATE_PAGE_SIZE) break;
        offset += STATE_PAGE_SIZE;
      }
      const list = Object.values(facilityMap);
      if (list.length > 100) {
        try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), list })); } catch {}
        return list;
      }
    } catch (e) { console.warn('Facility index build failed:', e.message); }
    return null;
  })();
  return facilityIndexPromise;
}

// ---------- name search ----------

function initNameSearch() {
  const toggle = document.getElementById('name-search-toggle');
  const box = document.getElementById('name-search-box');
  const input = document.getElementById('name-search-input');
  const results = document.getElementById('name-search-results');
  const ccnInput = document.getElementById('providerId');
  let debounce = null;

  toggle.addEventListener('click', () => {
    box.hidden = !box.hidden;
    toggle.textContent = box.hidden ? 'search by name' : 'hide search';
    if (!box.hidden) {
      results.innerHTML = '';
      input.value = '';
      input.focus();
      getFacilityIndex(); // warm cache in background
    }
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const term = input.value.trim();
    if (term.length < 2) { results.innerHTML = ''; return; }
    results.innerHTML = '<li class="search-msg">Searching…</li>';
    debounce = setTimeout(() => doSearch(term), 300);
  });

  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && e.target !== toggle) results.innerHTML = '';
  });

  async function doSearch(term) {
    const facilities = await getFacilityIndex();
    if (!facilities) {
      results.innerHTML = '<li class="search-msg">Facility index unavailable — enter CCN directly.</li>';
      return;
    }
    const termLower = term.toLowerCase();
    const matches = facilities
      .filter(r => r.PROVNAME && r.PROVNAME.toLowerCase().includes(termLower))
      .slice(0, 40);
    if (!matches.length) { results.innerHTML = '<li class="search-msg">No facilities found.</li>'; return; }
    results.innerHTML = matches.map(r =>
      `<li data-ccn="${r.PROVNUM}">
        <div class="result-name">${r.PROVNAME}</div>
        <div class="result-meta">${r.CITY}, ${r.STATE} · CCN ${r.PROVNUM}</div>
      </li>`
    ).join('');
    results.querySelectorAll('li[data-ccn]').forEach(li => {
      li.addEventListener('click', () => {
        ccnInput.value = li.dataset.ccn;
        results.innerHTML = '';
        box.hidden = true;
        toggle.textContent = 'search by name';
        input.value = '';
      });
    });
  }
}

// ---------- range slider ----------

let sliderDates = [];
let sliderDebounce = null;

function initRangeSlider(data) {
  const sliderEl = document.getElementById('range-slider');
  if (!sliderEl) return;
  const dates = [...new Set(data.rows.map(r => r.WorkDate))].sort();
  sliderDates = dates;
  if (dates.length < 2) { sliderEl.hidden = true; return; }
  const startEl = document.getElementById('range-start');
  const endEl   = document.getElementById('range-end');
  startEl.min = endEl.min = 0;
  startEl.max = endEl.max = dates.length - 1;
  startEl.value = 0;
  endEl.value   = dates.length - 1;
  updateSliderUI();
  sliderEl.hidden = false;
}

function updateSliderUI() {
  const total   = sliderDates.length - 1;
  const s       = parseInt(document.getElementById('range-start').value);
  const e       = parseInt(document.getElementById('range-end').value);
  const fill    = document.getElementById('range-fill');
  fill.style.left  = `${(s / total) * 100}%`;
  fill.style.width = `${((e - s) / total) * 100}%`;
  const fmt = (compact) => new Date(workDateToISO(compact) + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  document.getElementById('slider-date-start').textContent = fmt(sliderDates[s]);
  document.getElementById('slider-date-end').textContent   = fmt(sliderDates[e]);
  document.getElementById('slider-range-display').textContent =
    `${fmt(sliderDates[s])} \u2013 ${fmt(sliderDates[e])}`;
}

function applySliderRange() {
  if (!currentReport || !sliderDates.length) return;
  const s = parseInt(document.getElementById('range-start').value);
  const e = parseInt(document.getElementById('range-end').value);
  const startCompact = sliderDates[s];
  const endCompact   = sliderDates[e];
  const rows = currentReport.rows.filter(r => r.WorkDate >= startCompact && r.WorkDate <= endCompact);
  const sliced = {
    ...currentReport,
    startDate: workDateToISO(startCompact),
    endDate:   workDateToISO(endCompact),
    rowCount:  rows.length,
    summary:   summarize(rows),
    nySummary: summarizeNyFromFlat(currentReport.nyByDate, startCompact, endCompact),
    rows,
  };
  renderSlicedReport(sliced);
}

function renderSlicedReport(data) {
  const s = data.summary;
  $('#f-range').textContent = `${data.startDate} \u2192 ${data.endDate}`;
  $('#f-days').textContent =
    `${data.rowCount} days \u00b7 avg census ${fmt1.format(s.avgDailyCensus)} \u00b7 ` +
    `${fmt0.format(s.hours.total)} total nurse hours`;
  $('#m-cna').textContent   = fmt2.format(s.hprd.cna);
  $('#m-lpn').textContent   = fmt2.format(s.hprd.lpn);
  $('#m-rn').textContent    = fmt2.format(s.hprd.rn);
  $('#m-lpnrn').textContent = fmt2.format(s.hprd.lpnRn);
  $('#m-total').textContent = fmt2.format(s.hprd.total);
  renderBenchmark(data);
  renderMinimumsLine(data);
  renderCharts(data);
  renderBreakdown(data);
  renderTable(data);
}

function initRangeSliderEvents() {
  const startEl = document.getElementById('range-start');
  const endEl   = document.getElementById('range-end');
  const resetBtn = document.getElementById('slider-reset');
  startEl.addEventListener('input', () => {
    if (parseInt(startEl.value) > parseInt(endEl.value)) startEl.value = endEl.value;
    updateSliderUI();
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(applySliderRange, 40);
  });
  endEl.addEventListener('input', () => {
    if (parseInt(endEl.value) < parseInt(startEl.value)) endEl.value = startEl.value;
    updateSliderUI();
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(applySliderRange, 40);
  });
  resetBtn.addEventListener('click', () => {
    startEl.value = 0;
    endEl.value   = sliderDates.length - 1;
    updateSliderUI();
    applySliderRange();
  });
}

// ---------- init ----------

loadCoverage();
initNameSearch();
