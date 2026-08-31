# QOS Financial Reconciliation Dashboard

A fully functional React/Vite version of the supplied `FinancialReconDashboard.jsx` concept.

## What it does

- Uploads a QOS workbook and an operator/Mixx workbook in the browser.
- Reads Excel/CSV files with SheetJS (`xlsx`).
- Matches `QOS.momtransactionId` to `MIXX.trans_id`.
- Uses `QOS.clientid + "!" + QOS.transRef` to match `MIXX.idRequete` as a fallback.
- For `MAKEDEPOSIT`, compares MIXX `Amount` with QOS `netAmount`.
- For other QOS operations, compares MIXX `Amount` with QOS `amount`.
- Classifies rows as Matched, Mismatched, or Unmatched.
- Shows real dashboard metrics, daily trend, reports, filters, pagination, discrepancy logs, and Excel export.
- Includes the two supplied July 2026 workbooks under `public/samples` for instant testing.

## Launch

1. Install Node.js 18+.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
npm run dev
```

4. Open the local URL printed by Vite (normally `http://localhost:5173`).
5. Click **Load July 2026 Sample Files** for an immediate demo, or upload new files.

## Production build

```bash
npm run build
npm run preview
```

## Important assumption

The reconciliation logic reflects the field relationships visible in the two supplied July workbooks. If another operator uses different field names or amount semantics, edit `src/reconcile.js`.
