# PBJ Daily Nurse Staffing Reports

A **pure static website** that builds extended-timeframe staffing reports for any
U.S. nursing home using the CMS
[Payroll-Based Journal Daily Nurse Staffing](https://data.cms.gov/quality-of-care/payroll-based-journal-daily-nurse-staffing)
public data API.

No backend, no build step, no dependencies. The browser calls `data.cms.gov`
directly (CMS allows CORS), discovers the quarterly dataset UUIDs from the CMS
catalog, fetches every quarter that overlaps the requested date range, trims
rows to the range, and computes summary metrics (avg daily census, total nurse
hours, total/RN/LPN/CNA HPRD).

## Files

```
index.html    # UI
app.js        # all logic — catalog discovery, fetching, aggregation, rendering
style.css     # styling
```

That's the whole app. Drop those three files on any static host and it works.

## Deploy for free

### GitHub Pages
1. Create a new GitHub repo and push `index.html`, `app.js`, `style.css` to the `main` branch.
2. Repo → **Settings** → **Pages** → Source: "Deploy from a branch" → Branch: `main`, folder: `/ (root)` → **Save**.
3. Your site will be live at `https://<your-username>.github.io/<repo-name>/` in a minute or two.

### Netlify (drag-and-drop)
1. Go to https://app.netlify.com/drop.
2. Drag the project folder onto the page.
3. You get a `*.netlify.app` URL instantly.

### Cloudflare Pages
1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Upload the folder. Done.

### Vercel
1. https://vercel.com/new → import the GitHub repo (or drag folder with Vercel CLI).
2. Framework preset: **Other**. Root directory: `./`. Deploy.

## Local preview

Any static file server works. Two one-liners:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

```
npx serve .
```

> **Note**: Opening `index.html` directly via `file://` may or may not work
> depending on your browser's CORS handling of `Origin: null` — use one of the
> local servers above instead.

## How to use

1. Enter the facility's 6-digit CMS Certification Number (CCN), e.g. `015009`.
2. Pick a start and end date (any range covered by available quarters — shown in the form).
3. Click **Generate report**.

You'll get facility info, summary metric cards, a day-by-day detail table with
an optional employee/contract split, and a one-click CSV export.

## Data source

- Dataset: https://data.cms.gov/quality-of-care/payroll-based-journal-daily-nurse-staffing
- CMS catalog: https://data.cms.gov/data.json
- Data dictionary: https://data.cms.gov/resources/payroll-based-journal-daily-nurse-staffing-data-dictionary

The catalog listing of quarterly datasets is cached in `localStorage` for 1
hour, so the first report in a session does an extra small fetch; subsequent
reports skip it.
