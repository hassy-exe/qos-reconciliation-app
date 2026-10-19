
import React, { useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CheckCircle2, ChevronLeft, ChevronRight,
  Download, FileCheck2, FileSpreadsheet, LayoutDashboard, Loader2,
  Search, Settings, UploadCloud, UserCircle2, XCircle, Zap
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import {
  exportResults, formatDate, money, readWorkbook, reconcile, excelDate
} from "./reconcile.js";

const API_URL = import.meta.env.VITE_API_URL || "https://qos-recon-backend.onrender.com";

const NAV = [
  ["dashboard", "Dashboard", LayoutDashboard],
  ["workspace", "Workspace", UploadCloud],
  ["reports", "Operator Reports", FileSpreadsheet],
  ["discrepancies", "Discrepancy Logs", AlertTriangle],
];

function dateKey(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";

  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}

function filterByDateRange(rows, dateField, from, to) {
  if (!from || !to) return rows;

  return rows.filter((row) => {
    const date = dateKey(excelDate(row[dateField]));
    return date && date >= from && date <= to;
  });
}

async function fetchQosRows(operatorRows, token, selectedFrom, selectedTo) {
  const dates = operatorRows
    .map((row) => dateKey(excelDate(row.trans_date)))
    .filter(Boolean)
    .sort();

  const dateFrom = selectedFrom || dates[0];
  const dateTo = selectedTo || dates[dates.length - 1];

  if (!dateFrom || !dateTo) {
    throw new Error("Select a valid start and end date.");
  }

  if (dateFrom > dateTo) {
    throw new Error("Start date cannot be after end date.");
  }

  const params = new URLSearchParams({
    date_from: `${dateFrom} 00:00:00`,
    date_to: `${dateTo} 23:59:59`,
  });

  const response = await fetch(
    `${API_URL}/api/qos/transactions?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (response.status === 401) {
    throw new Error("SESSION_EXPIRED");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to load QOS transactions (${response.status}). ${detail.slice(0, 200)}`
    );
  }

  const rows = await response.json();

  if (!Array.isArray(rows)) {
    throw new Error("Invalid QOS response from database.");
  }

  return rows.map((row) => ({
    ...row,
    momtransactionId: row.momtransactionId ?? row.momtransactionid,
    transRef: row.transRef ?? row.transref,
    operationType: row.operationType ?? row.operation_type,
    netAmount: row.netAmount ?? row.netamount,
  }));
}

function Badge({ status }) {
  const Icon = status === "Matched"
    ? CheckCircle2
    : status === "Mismatched" ? AlertTriangle : XCircle;

  return (
    <span className={`badge ${status.toLowerCase()}`}>
      <Icon size={14} />
      {status}
    </span>
  );
}

function Button({ children, secondary = false, ...props }) {
  return (
    <button className={secondary ? "btn secondary" : "btn"} {...props}>
      {children}
    </button>
  );
}

function Sidebar({ active, onNavigate, hasResults }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-icon"><FileCheck2 size={20} /></div>
        <div><b>Financial Audit</b><span>QOS Recon</span></div>
      </div>

      <Button onClick={() => onNavigate("workspace")}>
        <Zap size={16} /> New Audit
      </Button>

      <div className="nav-title">Menu</div>

      <nav>
        {NAV.map(([key, label, Icon]) => (
          <button
            key={key}
            className={active === key ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate(key)}
          >
            <Icon size={18} />
            <span>{label}</span>
            {key !== "workspace" && hasResults && key !== "dashboard"
              ? <i className="dot" />
              : null}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        Matching runs in your browser<br />
        <small>The Mixx file is not uploaded to the server.</small>
      </div>
    </aside>
  );
}

function Topbar({ title, result, onLogout }) {
  return (
    <header className="topbar">
      <b>{title}</b>
      <div className="top-actions">
        {result && (
          <Button secondary onClick={() => exportResults(result)}>
            <Download size={15} /> Export Excel
          </Button>
        )}
        <Button secondary onClick={onLogout}>Log out</Button>
        <Settings size={19} />
        <UserCircle2 size={22} />
      </div>
    </header>
  );
}

function Login({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch(`${API_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        throw new Error(
          res.status === 401 ? "Wrong password" : "Could not log in. Try again."
        );
      }

      const data = await res.json();
      onLogin(data.token);
    } catch (err) {
      setError(err.message || "Could not log in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="empty">
      <div className="round-icon large"><FileCheck2 size={28} /></div>
      <h2>QOS Recon</h2>
      <p>Enter the team password to continue.</p>

      <form
        onSubmit={submit}
        style={{ display: "grid", gap: 12, justifyItems: "center" }}
      >
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Team password"
          autoFocus
          required
          style={{
            padding: 10,
            borderRadius: 8,
            border: "1px solid #ddd",
            width: 260,
          }}
        />
        <Button type="submit" disabled={!password || busy}>
          {busy ? "Checking..." : "Log in"}
        </Button>
      </form>

      {error && (
        <div className="error-box">
          <AlertTriangle size={17} /> {error}
        </div>
      )}
    </div>
  );
}

function Dropzone({ title, subtitle, file, onFile }) {
  const [drag, setDrag] = useState(false);
  const accept = (f) => { if (f) onFile(f); };

  return (
    <div
      className={`dropzone ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        accept(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="round-icon"><UploadCloud size={23} /></div>
      <b>{title}</b>
      <p>{subtitle}</p>

      {file ? (
        <div className="file-pill">
          <FileSpreadsheet size={15} /> {file.name}
          <button
            type="button"
            onClick={() => onFile(null)}
            aria-label="Remove file"
          >
            ×
          </button>
        </div>
      ) : (
        <label className="file-picker">
          Browse file
          <input
            hidden
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => accept(e.target.files?.[0])}
          />
        </label>
      )}
    </div>
  );
}

function Metric({ label, value, sub, accent }) {
  return (
    <div className="card metric">
      <span>{label}</span>
      <strong className={accent ? "accent" : ""}>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

function Empty({ onGo }) {
  return (
    <div className="empty">
      <div className="round-icon large"><FileSpreadsheet size={28} /></div>
      <h2>No reconciliation loaded</h2>
      <p>Open Workspace, upload the Mixx file, then run the audit.</p>
      {onGo && (
        <Button onClick={onGo}>
          <UploadCloud size={16} /> Open Workspace
        </Button>
      )}
    </div>
  );
}

function Dashboard({ result, onNavigate }) {
  if (!result) {
    return <Empty onGo={() => onNavigate("workspace")} />;
  }

  const m = result.metrics;

  return (
    <>
      <div className="heading">
        <h1>Executive Summary</h1>
        <p>Live reconciliation performance from the loaded workbooks.</p>
      </div>

      <div className="metrics">
        <Metric
          label="Records Compared"
          value={m.total.toLocaleString()}
          sub={`${result.sourceCounts.qos.toLocaleString()} QOS · ${result.sourceCounts.operator.toLocaleString()} operator`}
        />
        <Metric
          label="Matched"
          value={m.matched.toLocaleString()}
          sub={`${m.matchRate.toFixed(2)}% match rate`}
          accent
        />
        <Metric
          label="Unmatched"
          value={m.unmatched.toLocaleString()}
          sub="Missing on either side"
        />
        <Metric
          label="Mismatched"
          value={m.mismatched.toLocaleString()}
          sub="Keys found, values differ"
        />
      </div>

      <div className="dashboard-grid">
        <div className="card chart-card">
          <div className="card-head">
            <div>
              <b>Daily Reconciliation Trend</b>
              <span>Matched records vs exceptions</span>
            </div>
          </div>

          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={result.trend}>
                <CartesianGrid vertical={false} stroke="#eee" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => v.slice(5)}
                  tickLine={false}
                />
                <YAxis tickLine={false} />
                <Tooltip />
                <Bar dataKey="matched" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                <Bar dataKey="exceptions" fill="#fcd89a" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card summary-card">
          <b>Audit Health</b>
          <div className="rate">{m.matchRate.toFixed(2)}%</div>
          <div className="progress">
            <i style={{ width: `${Math.min(100, m.matchRate)}%` }} />
          </div>

          <dl>
            <div><dt>Total exceptions</dt><dd>{m.discrepancies.toLocaleString()}</dd></div>
            <div><dt>Net amount variance</dt><dd>{money(m.discrepancyValue)}</dd></div>
          </dl>
        </div>
      </div>
    </>
  );
}

function Workspace({
  opFile, setOpFile, qosFile, setQosFile,
  running, onRun, error,
  dateFrom, setDateFrom, dateTo, setDateTo,
}) {
  return (
    <div className="workspace-wrap">
      <div className="heading">
        <h1>QOS Reconciliation</h1>
        <p>
          Upload the operator/Mixx ledger. Choose the QOS date range below,
          or leave the dates blank to use the dates in the Mixx file.
        </p>
      </div>

      <div className="drop-grid">
        <Dropzone
          title="Operator / Mixx Workbook"
          subtitle="Partner-submitted ledger · .xlsx, .xls or .csv"
          file={opFile}
          onFile={setOpFile}
        />
        <Dropzone
          title="QOS Export (optional)"
          subtitle="Upload a QOS file instead of loading from the database."
          file={qosFile}
          onFile={setQosFile}
        />
      </div>

      <div className="card" style={{ padding: 18, marginTop: 18 }}>
        <b>QOS database date range</b>
        <p style={{ marginTop: 6 }}>
          Select both dates to override the Mixx file dates.
        </p>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            Start date
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            End date
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>

          <Button
            secondary
            type="button"
            onClick={() => { setDateFrom(""); setDateTo(""); }}
          >
            Use Mixx file dates
          </Button>
        </div>
      </div>

      <div className="run-row">
        <Button onClick={onRun} disabled={!opFile || running}>
          {running
            ? <><Loader2 className="spin" size={16} /> Reconciling...</>
            : <><FileCheck2 size={16} /> Run Reconciliation</>}
        </Button>
      </div>

      {error && (
        <div className="error-box">
          <AlertTriangle size={17} /> {error}
        </div>
      )}

      <div className="logic card">
        <b>QOS data source</b>
        <p>
          When no QOS file is uploaded, transactions are loaded directly
          from MySQL for the selected dates.
        </p>
      </div>

      <div className="logic card">
        <b>Matching logic used</b>
        <p>
          Primary keys: <code>QOS.momtransactionId ↔ MIXX.trans_id</code>
          {" "}and fallback{" "}
          <code>QOS.clientid + "!" + QOS.transRef ↔ MIXX.idRequete</code>.
        </p>
        <p>
          Amount check: <code>MAKEDEPOSIT → QOS.netAmount</code>;
          other QOS transaction types → <code>QOS.amount</code>.
        </p>
      </div>
    </div>
  );
}

function DataTable({ rows }) {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const filtered = useMemo(() => rows.filter((r) =>
    (filter === "All" || r.status === filter) &&
    (!query.trim() ||
      [r.id, r.requestId, r.operatorRequestId]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()))
  ), [rows, filter, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="table-card">
      <div className="table-toolbar">
        <div className="tabs">
          {["All", "Matched", "Unmatched", "Mismatched"].map((t) => (
            <button
              className={filter === t ? "active" : ""}
              onClick={() => { setFilter(t); setPage(1); }}
              key={t}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search transaction / request ID"
          />
        </div>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Date / Time</th>
              <th>QOS Amount</th>
              <th>Operator Amount</th>
              <th>Difference</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {slice.map((r) => (
              <tr key={r.rowKey}>
                <td>
                  <b>{r.id}</b>
                  <small>{r.operationType || r.source}</small>
                </td>
                <td>{formatDate(r.time)}</td>
                <td>{r.amount == null ? "—" : money(r.amount, r.currency)}</td>
                <td>{r.operatorAmount == null ? "—" : money(r.operatorAmount, r.currency)}</td>
                <td className={r.delta ? "danger" : ""}>
                  {r.delta == null ? "—" : money(r.delta, r.currency)}
                </td>
                <td><Badge status={r.status} /></td>
              </tr>
            ))}

            {!slice.length && (
              <tr><td colSpan="6" className="none">No matching records.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>
          Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–
          {Math.min(safePage * pageSize, filtered.length)} of {filtered.length.toLocaleString()}
        </span>

        <div>
          <button
            disabled={safePage === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft size={16} />
          </button>
          <b>{safePage} / {totalPages}</b>
          <button
            disabled={safePage === totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Reports({ result }) {
  if (!result) return <Empty />;

  return (
    <>
      <div className="heading">
        <h1>Operator Detail View & Transaction Log</h1>
        <p>All reconciled records from the currently loaded workbooks.</p>
      </div>
      <DataTable rows={result.rows} />
    </>
  );
}

function Discrepancies({ result }) {
  if (!result) return <Empty />;

  const rows = result.rows.filter((r) => r.status !== "Matched");

  return (
    <>
      <div className="heading">
        <h1>Discrepancy Logs</h1>
        <p>{rows.length.toLocaleString()} unmatched or mismatched records require review.</p>
      </div>
      <DataTable rows={rows} />
    </>
  );
}

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [opFile, setOpFile] = useState(null);
  const [qosFile, setQosFile] = useState(null);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [token, setToken] = useState(sessionStorage.getItem("qos_token") || "");

  function logout() {
    sessionStorage.removeItem("qos_token");
    setToken("");
    setResult(null);
    setOpFile(null);
    setQosFile(null);
    setError("");
    setDateFrom("");
    setDateTo("");
    setPage("dashboard");
  }

  async function run(o = opFile, q = qosFile) {
    const timings = {};
    let stageStart = performance.now();

    const logStage = (name) => {
      timings[name] = ((performance.now() - stageStart) / 1000).toFixed(2);
      console.log(`[QOS Recon] ${name}: ${timings[name]} seconds`);
      stageStart = performance.now();
    };

    try {
      setRunning(true);
      setError("");

      if (!o) throw new Error("Upload the Mixx workbook first.");

      if (Boolean(dateFrom) !== Boolean(dateTo)) {
        throw new Error("Choose both a start date and an end date, or clear both.");
      }

      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error("Start date cannot be after end date.");
      }

      const opOriginal = await readWorkbook(o);
      logStage("Read Mixx workbook");

      if (!opOriginal.length) {
        throw new Error("The Mixx workbook has no data rows.");
      }

      const op = dateFrom && dateTo
        ? filterByDateRange(opOriginal, "trans_date", dateFrom, dateTo)
        : opOriginal;

      logStage("Filter Mixx transactions");
      console.log("[QOS Recon] Starting QOS fetch...");

      if (!op.length) {
        throw new Error("No Mixx transactions were found in the selected date range.");
      }

      let qos;

      if (q) {
        qos = await readWorkbook(q);
        logStage("Read QOS file");

        if (!qos.length) {
          throw new Error("The QOS file has no data rows.");
        }

        if (dateFrom && dateTo) {
          qos = filterByDateRange(qos, "trxndate", dateFrom, dateTo);
        }

        logStage("Filter QOS transactions");
      } else {
        qos = await fetchQosRows(op, token, dateFrom, dateTo);
        logStage("Fetch QOS from database");
        console.log("[QOS Recon] QOS fetch finished");

        if (!qos.length) {
          throw new Error("No QOS transactions were found for the selected dates.");
        }
      }

      const nextResult = reconcile(qos, op);
      logStage("Reconcile transactions");

      setResult(nextResult);
      setPage("dashboard");

      console.log("[QOS Recon] Transaction counts:", {
        mixxOriginal: opOriginal.length,
        mixxCompared: op.length,
        qosCompared: qos.length,
        totalResults: nextResult.rows.length,
      });
    } catch (e) {
      console.error("[QOS Recon] Error:", e);

      if (e?.message === "SESSION_EXPIRED") {
        sessionStorage.removeItem("qos_token");
        setToken("");
        setError("Your session expired. Please log in again.");
        return;
      }

      setError(e?.message || "Could not read or reconcile the file.");
      setPage("workspace");
    } finally {
      setRunning(false);
    }
  }

  if (!token) {
    return (
      <Login
        onLogin={(t) => {
          sessionStorage.setItem("qos_token", t);
          setToken(t);
        }}
      />
    );
  }

  const title = NAV.find((n) => n[0] === page)?.[1] || "Dashboard";

  return (
    <div className="app">
      <Sidebar active={page} onNavigate={setPage} hasResults={!!result} />

      <section className="shell">
        <Topbar title={title} result={result} onLogout={logout} />

        <main>
          {page === "dashboard" ? (
            <Dashboard result={result} onNavigate={setPage} />
          ) : page === "workspace" ? (
            <Workspace
              opFile={opFile}
              setOpFile={setOpFile}
              qosFile={qosFile}
              setQosFile={setQosFile}
              running={running}
              onRun={() => run()}
              error={error}
              dateFrom={dateFrom}
              setDateFrom={setDateFrom}
              dateTo={dateTo}
              setDateTo={setDateTo}
            />
          ) : page === "reports" ? (
            <Reports result={result} />
          ) : (
            <Discrepancies result={result} />
          )}
        </main>
      </section>
    </div>
  );
}
