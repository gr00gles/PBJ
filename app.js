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

// NYS minimum staffing requirements (10 NYCRR 415.13 — 2022 nursing home staffing law).
// Editable in the UI and persisted in localStorage so the user can update if NYS changes them.
const MIN_CACHE_KEY = 'pbj.nysMinimums.v1';
const MIN_DEFAULTS = { cna: 2.2, lpnRn: 1.1, total: 3.5 };
function loadMinimums() {
  try {
    const raw = localStorage.getItem(MIN_CACHE_KEY);
    if (raw) {
      const m = JSON.parse(raw);
      return {
        cna:   Number.isFinite(+m.cna)   ? +m.cna   : MIN_DEFAULTS.cna,
        lpnRn: Number.isFinite(+m.lpnRn) ? +m.lpnRn : MIN_DEFAULTS.lpnRn,
        total: Number.isFinite(+m.total) ? +m.total : MIN_DEFAULTS.total,
      };
    }
  } catch {}
  return { ...MIN_DEFAULTS };
}
function saveMinimums(m) {
  try { localStorage.setItem(MIN_CACHE_KEY, JSON.stringify(m)); } catch {}
}
let nysMinimums = loadMinimums();

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

// ---------- NY state benchmark ----------

const NY_PAGE_SIZE = 6500;          // observed CMS cap for state-wide queries
const NY_CACHE_PREFIX = 'pbj.nys.'; // + quarterKey + '.v1'
const NY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function nyCacheKey(quarterKey) { return `${NY_CACHE_PREFIX}${quarterKey}.v1`; }

function readNyCache(quarterKey) {
  try {
    const raw = localStorage.getItem(nyCacheKey(quarterKey));
    if (!raw) return null;
    const { fetchedAt, byDate } = JSON.parse(raw);
    if (Date.now() - fetchedAt > NY_CACHE_TTL_MS) return null;
    return byDate;
  } catch { return null; }
}

function writeNyCache(quarterKey, byDate) {
  try {
    localStorage.setItem(nyCacheKey(quarterKey), JSON.stringify({ fetchedAt: Date.now(), byDate }));
  } catch {}
}

// Pulls every NY row in a quarter (paginated), accumulating per-day totals.
// Returns { WorkDate: { census, cna, lpn, rn, lpnAdmin, naTrn, rows } }.
async function fetchNyQuarterAggregated(accessURL, quarterKey, onProgress) {
  const cached = readNyCache(quarterKey);
  if (cached) return cached;

  const byDate = {};
  let offset = 0;
  let pageIndex = 0;
  // Safety cap: state quarters top out around ~60k rows
  const HARD_CAP = 200000;
  while (offset < HARD_CAP) {
    const u = new URL(accessURL);
    u.searchParams.set('filter[STATE]', 'NY');
    u.searchParams.set('size', String(NY_PAGE_SIZE));
    u.searchParams.set('offset', String(offset));
    const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`NY HTTP ${res.status} at offset ${offset}`);
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
    if (rows.length < NY_PAGE_SIZE) break;
    offset += NY_PAGE_SIZE;
  }

  writeNyCache(quarterKey, byDate);
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
    startEl.min = earliestISO; startEl.max = latestISO;
    endEl.min = earliestISO; endEl.max = latestISO;
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

  // Kick off facility fetches and NY benchmark fetches concurrently.
  onProgress?.(`Fetching staffing data for facility ${providerId}…`);
  const facilityPromise = Promise.allSettled(
    available.map(q => fetchQuarterForProvider(catalog[q], providerId).then(rows => ({ q, rows })))
  );
  const nyPromise = Promise.allSettled(
    available.map(async (q) => {
      const byDate = await fetchNyQuarterAggregated(catalog[q], q, (qk, page, count) => {
        onProgress?.(`Loading NY state benchmark ${qk} (page ${page}, ${count} rows)…`);
      });
      return { q, byDate };
    })
  );

  const [facilityResults, nyResults] = await Promise.all([facilityPromise, nyPromise]);

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
  } catch (err) {
    console.error(err);
    setStatus('error', `Error: ${err.message}`);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Generate report';
  }
});

// ---------- render ----------

function renderReport(data) {
  resultsEl.hidden = false;

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
}

function renderBenchmark(data) {
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
      const sign = diff >= 0 ? '+' : '−';
      dEl.textContent = `${sign}${Math.abs(pct).toFixed(1)}%`;
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
    ? `<span class="legend-item"><span class="legend-swatch legend-min"></span>NYS min ${minValue.toFixed(2)}</span>` : '';

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

  const mkSeries = (key) => ([
    { label: 'Facility', color: facColor, width: 2.5, values: monthly.map(m => m[key].fac) },
    { label: 'NY avg',   color: nyColor,  width: 2,   dash: '5 4', values: monthly.map(m => m[key].ny) },
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
      ny:  nyHprd ? deltaDescriptor(facHprd[c.key], nyHprd[c.key], 'vs NY avg') : null,
      min: c.minValue ? deltaDescriptor(facHprd[c.key], c.minValue, 'vs NYS min') : null,
    };
    return buildLineChart({
      title: c.title,
      months,
      series: mkSeries(c.key),
      minValue: c.minValue,
      minLabel: 'NYS min',
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
      dEl.textContent = `✓ +${Math.abs(pct).toFixed(1)}%`;
      dEl.className = 'delta good';
    } else {
      dEl.textContent = `✗ −${Math.abs(pct).toFixed(1)}%`;
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

  // ---- NY state benchmark row in the same panel ----
  const ny = data.nySummary;
  if (ny && ny.census > 0) {
    const nyBlock = `
      <tr class="ny-header"><td colspan="3"><strong>All NYS benchmark over the same period</strong></td></tr>
      <tr><td>NY rows / distinct days</td><td class="num">${fmt0.format(ny.rows)} / ${fmt0.format(ny.distinctDates)}</td><td class="muted">Sum of per-facility daily rows across all NY facilities.</td></tr>
      <tr><td><strong>NY total resident-days</strong></td><td class="num"><strong>${fmt0.format(ny.census)}</strong></td><td class="muted">Denominator for NY HPRDs.</td></tr>
      <tr><td>NY CNA hours</td><td class="num">${fmt0.format(ny.hours.cna)}</td><td class="num">${fmt0.format(ny.hours.cna)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.cna)}</strong></td></tr>
      <tr><td>NY LPN hours</td><td class="num">${fmt0.format(ny.hours.lpn)}</td><td class="num">${fmt0.format(ny.hours.lpn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.lpn)}</strong></td></tr>
      <tr><td>NY RN hours</td><td class="num">${fmt0.format(ny.hours.rn)}</td><td class="num">${fmt0.format(ny.hours.rn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.rn)}</strong></td></tr>
      <tr><td>NY LPN + RN hours</td><td class="num">${fmt0.format(ny.hours.lpnRn)}</td><td class="num">${fmt0.format(ny.hours.lpnRn)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.lpnRn)}</strong></td></tr>
      <tr class="formula-total"><td><strong>NY Total hours</strong></td><td class="num">${fmt0.format(ny.hours.total)}</td><td class="num">${fmt0.format(ny.hours.total)} ÷ ${fmt0.format(ny.census)} = <strong>${fmt2.format(ny.hprd.total)}</strong></td></tr>
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

// ---------- NYS minimum inputs ----------

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
      saveMinimums(nysMinimums);
      if (currentReport) {
        renderMinimumsLine(currentReport);
        renderCharts(currentReport);
      }
    });
    el.addEventListener('blur', () => {
      el.value = fmtInput(nysMinimums[key]);
    });
    // Click anywhere on the tile focuses the input
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
      nysMinimums = { ...MIN_DEFAULTS };
      saveMinimums(nysMinimums);
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

// ---------- init ----------

loadCoverage();
