import React, { useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CheckCircle2, ChevronLeft, ChevronRight, Download,
  FileCheck2, FileSpreadsheet, LayoutDashboard, Loader2, Search, Settings,
  UploadCloud, UserCircle2, XCircle, Zap
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import { exportResults, formatDate, money, readWorkbook, reconcile, excelDate } from "./reconcile.js";

// Backend address. Set VITE_API_URL in a file called .env.local to test against a local backend.
const API_URL = import.meta.env.VITE_API_URL || "https://qos-recon-backend.onrender.com";

const NAV = [
  ["dashboard", "Dashboard", LayoutDashboard],
  ["workspace", "Workspace", UploadCloud],
  ["reports", "Operator Reports", FileSpreadsheet],
  ["discrepancies", "Discrepancy Logs", AlertTriangle],
];

// ---- QOS data now comes from the database, for the dates found in the Mixx file ----
const pad = (n) => String(n).padStart(2, "0");
const dayStart = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
const dayEnd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 23:59:59`;

async function fetchQosRows(operatorRows) {
  const dates = operatorRows.map((r) => excelDate(r.trans_date)).filter(Boolean);
  if (!dates.length) throw new Error("Could not read any dates (trans_date column) from the Mixx file.");

  let first = dates[0];
  let last = dates[0];
  for (const d of dates) {
    if (d < first) first = d;
    if (d > last) last = d;
  }

  const params = new URLSearchParams({ date_from: dayStart(first), date_to: dayEnd(last) });
  const res = await fetch(`${API_URL}/api/qos/transactions?${params}`);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail; } catch { /* ignore */ }
    throw new Error(detail || "Could not load QOS transactions from the server.");
  }
  return res.json();
}

function Badge({ status }) {
  const Icon = status === "Matched" ? CheckCircle2 : status === "Mismatched" ? AlertTriangle : XCircle;
  return <span className={`badge ${status.toLowerCase()}`}><Icon size={14}/>{status}</span>;
}

function Button({ children, secondary=false, ...props }) {
  return <button className={secondary ? "btn secondary" : "btn"} {...props}>{children}</button>;
}

function Sidebar({ active, onNavigate, hasResults }) {
  return <aside className="sidebar">
    <div className="brand"><div className="brand-icon"><FileCheck2 size={20}/></div><div><b>Financial Audit</b><span>QOS Recon</span></div></div>
    <Button onClick={() => onNavigate("workspace")}><Zap size={16}/> New Audit</Button>
    <div className="nav-title">Menu</div>
    <nav>{NAV.map(([key,label,Icon]) => <button key={key} className={active===key ? "nav-item active":"nav-item"} onClick={() => onNavigate(key)}>
      <Icon size={18}/><span>{label}</span>{key!=="workspace" && hasResults && key!=="dashboard" ? <i className="dot"/> : null}
    </button>)}</nav>
    <div className="sidebar-foot">Local browser processing<br/><small>Your files never leave this app.</small></div>
  </aside>
}

function Topbar({ title, result }) {
  return <header className="topbar"><b>{title}</b><div className="top-actions">
    {result && <Button secondary onClick={() => exportResults(result)}><Download size={15}/> Export Excel</Button>}
    <Settings size={19}/><UserCircle2 size={22}/>
  </div></header>
}

function Dropzone({ title, subtitle, file, onFile }) {
  const [drag, setDrag] = useState(false);
  const accept = (f) => { if (f) onFile(f); };
  return <div className={`dropzone ${drag?"drag":""}`} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);accept(e.dataTransfer.files?.[0])}}>
    <div className="round-icon"><UploadCloud size={23}/></div><b>{title}</b><p>{subtitle}</p>
    {file ? <div className="file-pill"><FileSpreadsheet size={15}/>{file.name}</div> : <label className="file-picker">Browse file<input hidden type="file" accept=".xlsx,.xls,.csv" onChange={e=>accept(e.target.files?.[0])}/></label>}
  </div>
}

function Metric({ label, value, sub, accent }) { return <div className="card metric"><span>{label}</span><strong className={accent?"accent":""}>{value}</strong><small>{sub}</small></div> }

function Dashboard({ result, onNavigate }) {
  if (!result) return <Empty onGo={() => onNavigate("workspace")} />;
  const m=result.metrics;
  return <>
    <div className="heading"><h1>Executive Summary</h1><p>Live reconciliation performance from the loaded workbooks.</p></div>
    <div className="metrics">
      <Metric label="Records Compared" value={m.total.toLocaleString()} sub={`${result.sourceCounts.qos.toLocaleString()} QOS · ${result.sourceCounts.operator.toLocaleString()} operator`}/>
      <Metric label="Matched" value={m.matched.toLocaleString()} sub={`${m.matchRate.toFixed(2)}% match rate`} accent/>
      <Metric label="Unmatched" value={m.unmatched.toLocaleString()} sub="Missing on either side"/>
      <Metric label="Mismatched" value={m.mismatched.toLocaleString()} sub="Keys found, values differ"/>
    </div>
    <div className="dashboard-grid">
      <div className="card chart-card"><div className="card-head"><div><b>Daily Reconciliation Trend</b><span>Matched records vs exceptions</span></div></div>
        <div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={result.trend}><CartesianGrid vertical={false} stroke="#eee"/><XAxis dataKey="date" tickFormatter={v=>v.slice(5)} tickLine={false}/><YAxis tickLine={false}/><Tooltip/><Bar dataKey="matched" fill="#f59e0b" radius={[6,6,0,0]}/><Bar dataKey="exceptions" fill="#fcd89a" radius={[6,6,0,0]}/></BarChart></ResponsiveContainer></div>
      </div>
      <div className="card summary-card"><b>Audit Health</b><div className="rate">{m.matchRate.toFixed(2)}%</div><div className="progress"><i style={{width:`${Math.min(100,m.matchRate)}%`}}/></div>
        <dl><div><dt>Total exceptions</dt><dd>{m.discrepancies.toLocaleString()}</dd></div><div><dt>Net amount variance</dt><dd>{money(m.discrepancyValue)}</dd></div></dl>
      </div>
    </div>
  </>
}

function Empty({ onGo }) { return <div className="empty"><div className="round-icon large"><FileSpreadsheet size={28}/></div><h2>No reconciliation loaded</h2><p>Open Workspace, upload the Mixx file, then run the audit.</p><Button onClick={onGo}><UploadCloud size={16}/> Open Workspace</Button></div> }

function Workspace({ opFile, setOpFile, running, onRun, error }) {
  return <div className="workspace-wrap">
    <div className="heading"><h1>QOS Reconciliation</h1><p>Upload the operator/Mixx ledger. QOS transactions are loaded automatically for the same dates, and matching happens in your browser.</p></div>
    <div className="drop-grid" style={{ gridTemplateColumns: "minmax(0, 560px)" }}><Dropzone title="Operator / Mixx Workbook" subtitle="Partner-submitted ledger · .xlsx, .xls or .csv" file={opFile} onFile={setOpFile}/></div>
    <div className="run-row">
      <Button onClick={onRun} disabled={!opFile || running}>
        {running ? (
          <><Loader2 className="spin" size={16} /> Reconciling...</>
        ) : (
          <><FileCheck2 size={16} /> Run Reconciliation</>
        )}
      </Button>
    </div>
    {error && <div className="error-box"><AlertTriangle size={17}/>{error}</div>}
    <div className="logic card"><b>QOS data source</b><p>Loaded automatically from the QOS transactions database, for the date range found in the Mixx file.</p></div>
    <div className="logic card"><b>Matching logic used</b><p>Primary keys: <code>QOS.momtransactionId ↔ MIXX.trans_id</code> and fallback <code>QOS.clientid + "!" + QOS.transRef ↔ MIXX.idRequete</code>.</p><p>Amount check: <code>MAKEDEPOSIT → QOS.netAmount</code>; other QOS transaction types → <code>QOS.amount</code>.</p></div>
  </div>
}

function DataTable({ rows }) {
  const [filter,setFilter]=useState("All"), [query,setQuery]=useState(""), [page,setPage]=useState(1); const pageSize=25;
  const filtered=useMemo(()=>rows.filter(r=>(filter==="All"||r.status===filter) && (!query.trim() || [r.id,r.requestId,r.operatorRequestId].join(" ").toLowerCase().includes(query.toLowerCase()))),[rows,filter,query]);
  const totalPages=Math.max(1,Math.ceil(filtered.length/pageSize)); const slice=filtered.slice((page-1)*pageSize,page*pageSize);
  return <div className="table-card">
    <div className="table-toolbar"><div className="tabs">{["All","Matched","Unmatched","Mismatched"].map(t=><button className={filter===t?"active":""} onClick={()=>{setFilter(t);setPage(1)}} key={t}>{t}</button>)}</div><div className="search"><Search size={15}/><input value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="Search transaction / request ID"/></div></div>
    <div className="table-scroll"><table><thead><tr><th>Transaction ID</th><th>Date / Time</th><th>QOS Amount</th><th>Operator Amount</th><th>Difference</th><th>Status</th></tr></thead><tbody>{slice.map(r=><tr key={r.rowKey}><td><b>{r.id}</b><small>{r.operationType || r.source}</small></td><td>{formatDate(r.time)}</td><td>{r.amount==null?"—":money(r.amount,r.currency)}</td><td>{r.operatorAmount==null?"—":money(r.operatorAmount,r.currency)}</td><td className={r.delta?"danger":""}>{r.delta==null?"—":money(r.delta,r.currency)}</td><td><Badge status={r.status}/></td></tr>)}{slice.length===0&&<tr><td colSpan="6" className="none">No matching records.</td></tr>}</tbody></table></div>
    <div className="pager"><span>Showing {filtered.length?((page-1)*pageSize+1):0}–{Math.min(page*pageSize,filtered.length)} of {filtered.length.toLocaleString()}</span><div><button disabled={page===1} onClick={()=>setPage(p=>Math.max(1,p-1))}><ChevronLeft size={16}/></button><b>{page} / {totalPages}</b><button disabled={page===totalPages} onClick={()=>setPage(p=>Math.min(totalPages,p+1))}><ChevronRight size={16}/></button></div></div>
  </div>
}

function Reports({ result }) { if(!result)return <Empty/>; return <><div className="heading"><h1>Operator Detail View & Transaction Log</h1><p>All reconciled records from the currently loaded workbooks.</p></div><DataTable rows={result.rows}/></> }
function Discrepancies({ result }) { if(!result)return <Empty/>; const rows=result.rows.filter(r=>r.status!=="Matched"); return <><div className="heading"><h1>Discrepancy Logs</h1><p>{rows.length.toLocaleString()} unmatched or mismatched records require review.</p></div><DataTable rows={rows}/></> }

export default function App(){
  const [page,setPage]=useState("dashboard"), [opFile,setOpFile]=useState(null), [result,setResult]=useState(null), [running,setRunning]=useState(false), [error,setError]=useState("");

  const run = async (o = opFile) => {
    try {
      setRunning(true);
      setError("");

      // 1. Read the Mixx file in the browser
      const op = await readWorkbook(o);
      if (!op.length) throw new Error("The Mixx workbook has no data rows.");

      // 2. Load the QOS transactions for the same dates from the backend database
      const qos = await fetchQosRows(op);
      if (!qos.length) throw new Error("No QOS transactions were found in the database for the dates in this Mixx file.");

      // 3. Match them with the existing reconcile() logic
      setResult(reconcile(qos, op));
      setPage("dashboard");
    } catch (e) {
      console.error(e);
      setError(e?.message || "Could not read or reconcile the file.");
      setPage("workspace");
    } finally {
      setRunning(false);
    }
  };

  const title=NAV.find(n=>n[0]===page)?.[1]||"Dashboard";
  return <div className="app"><Sidebar active={page} onNavigate={setPage} hasResults={!!result}/><section className="shell"><Topbar title={title} result={result}/><main>{page==="dashboard"?<Dashboard result={result} onNavigate={setPage}/>:page==="workspace"?<Workspace {...{opFile,setOpFile,running}} onRun={()=>run()} error={error}/>:page==="reports"?<Reports result={result}/>:<Discrepancies result={result}/>}</main></section></div>
}