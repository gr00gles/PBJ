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

function summarize(rows) {
  let totalCensus = 0, censusDays = 0;
  let cnaHours = 0, lpnHours = 0, rnHours = 0;
  for (const r of rows) {
    const c = num(r.MDScensus);
    totalCensus += c;
    if (c > 0) censusDays += 1;
    cnaHours += cnaHoursRow(r);
    lpnHours += lpnHoursRow(r);
    rnHours  += rnHoursRow(r);
  }
  const lpnRnHours = lpnHours + rnHours;
  const totalNurseHours = cnaHours + lpnRnHours;
  const hprd = (s) => totalCensus > 0 ? s / totalCensus : 0;
  return {
    days: rows.length,
    censusDays,
    totalCensus,
    avgDailyCensus: censusDays > 0 ? totalCensus / censusDays : 0,
    hours: { cna: cnaHours, lpn: lpnHours, rn: rnHours, lpnRn: lpnRnHours, total: totalNurseHours },
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

async function generateReport({ providerId, startDate, endDate }) {
  const catalog = await loadCatalog();
  const wanted = quartersInRange(startDate, endDate);
  const available = wanted.filter(q => catalog[q]);
  const missing = wanted.filter(q => !catalog[q]);

  const startCompact = isoToCompact(startDate);
  const endCompact = isoToCompact(endDate);

  const results = await Promise.allSettled(
    available.map(q => fetchQuarterForProvider(catalog[q], providerId).then(rows => ({ q, rows })))
  );

  const errors = [];
  const rowsByQuarter = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const q = available[i];
    if (r.status === 'rejected') {
      errors.push({ quarter: q, error: String(r.reason && r.reason.message || r.reason) });
    } else {
      rowsByQuarter[q] = r.value.rows;
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

  return {
    providerId, startDate, endDate,
    facility,
    quartersQueried: available,
    quartersMissing: missing,
    errors,
    rowCount: allRows.length,
    summary: summarize(allRows),
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
    const data = await generateReport({ providerId, startDate, endDate });
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
