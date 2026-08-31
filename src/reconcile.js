import * as XLSX from "xlsx";

const tidy = (value) => value == null ? "" : String(value).trim();
const upper = (value) => tidy(value).toUpperCase();
const number = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function excelDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S);
  }
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d;
}

export function formatDate(value) {
  const d = excelDate(value);
  if (!d) return tidy(value) || "—";
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).format(d);
}

export function money(value, currency = "XOF") {
  const n = number(value) ?? 0;
  return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}`;
}

export async function readWorkbook(fileOrBuffer) {
  let bytes;
  if (fileOrBuffer instanceof ArrayBuffer) bytes = fileOrBuffer;
  else if (ArrayBuffer.isView(fileOrBuffer)) bytes = fileOrBuffer.buffer;
  else bytes = await fileOrBuffer.arrayBuffer();

  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
}

function compositeFromQos(row) {
  const client = tidy(row.clientid);
  const ref = tidy(row.transRef);
  return client && ref ? `${client}!${ref}` : "";
}

function operatorAmountExpected(qosRow) {
  const op = upper(qosRow.operationType);
  if (op === "MAKEDEPOSIT") return number(qosRow.netAmount ?? qosRow.amount);
  return number(qosRow.amount);
}

function isQosSuccessful(row) {
  return upper(row.responsemessage) === "SUCCESSFULL" || Number(row.response) === 0;
}

function statusFor(qos, op) {
  if (!op) return "Unmatched";
  const expected = operatorAmountExpected(qos);
  const actual = number(op.Amount);
  const amountMatches = expected === null || actual === null ? true : Math.abs(expected - actual) < 0.01;
  const txIdMatches = tidy(qos.momtransactionId) && tidy(qos.momtransactionId) === tidy(op.trans_id);
  const reqMatches = compositeFromQos(qos) && compositeFromQos(qos) === tidy(op.idRequete);
  return amountMatches && (txIdMatches || reqMatches) ? "Matched" : "Mismatched";
}

export function reconcile(qosRows, operatorRows) {
  const byTransId = new Map();
  const byRequest = new Map();
  operatorRows.forEach((row, index) => {
    const id = tidy(row.trans_id);
    const req = tidy(row.idRequete);
    if (id) byTransId.set(id, { row, index });
    if (req) byRequest.set(req, { row, index });
  });

  const usedOperator = new Set();
  const rows = [];

  qosRows.forEach((qos, index) => {
    const tx = tidy(qos.momtransactionId);
    const req = compositeFromQos(qos);
    const found = (tx && byTransId.get(tx)) || (req && byRequest.get(req));
    const op = found?.row || null;
    if (found) usedOperator.add(found.index);

    const status = statusFor(qos, op);
    const expectedAmount = operatorAmountExpected(qos);
    const operatorAmount = op ? number(op.Amount) : null;
    const delta = op && expectedAmount != null && operatorAmount != null ? operatorAmount - expectedAmount : null;

    rows.push({
      rowKey: `qos-${index}`,
      source: "QOS",
      id: tx || req || tidy(qos.transRef) || `QOS-${index + 1}`,
      qosTransactionId: tx,
      operatorTransactionId: op ? tidy(op.trans_id) : "",
      requestId: req,
      operatorRequestId: op ? tidy(op.idRequete) : "",
      time: qos.trxndate,
      amount: expectedAmount,
      operatorAmount,
      delta,
      currency: tidy(qos.currency) || "XOF",
      status,
      operationType: tidy(qos.operationType),
      qosResult: tidy(qos.responsemessage),
      operatorState: op ? tidy(op.trans_state) : "Missing",
      qosSuccessful: isQosSuccessful(qos),
      qos,
      operator: op,
    });
  });

  operatorRows.forEach((op, index) => {
    if (usedOperator.has(index)) return;
    rows.push({
      rowKey: `operator-${index}`,
      source: "Operator",
      id: tidy(op.trans_id) || tidy(op.idRequete) || `OP-${index + 1}`,
      qosTransactionId: "",
      operatorTransactionId: tidy(op.trans_id),
      requestId: "",
      operatorRequestId: tidy(op.idRequete),
      time: op.trans_date,
      amount: null,
      operatorAmount: number(op.Amount),
      delta: null,
      currency: "XOF",
      status: "Unmatched",
      operationType: tidy(op.trans_type),
      qosResult: "Missing",
      operatorState: tidy(op.trans_state),
      qosSuccessful: false,
      qos: null,
      operator: op,
    });
  });

  const matched = rows.filter(r => r.status === "Matched").length;
  const mismatched = rows.filter(r => r.status === "Mismatched").length;
  const unmatched = rows.filter(r => r.status === "Unmatched").length;
  const discrepancies = mismatched + unmatched;
  const total = rows.length;
  const matchRate = total ? matched / total * 100 : 0;
  const discrepancyValue = rows.reduce((sum, r) => sum + (r.delta ?? 0), 0);

  const trendMap = new Map();
  rows.forEach(row => {
    const d = excelDate(row.time);
    if (!d) return;
    const key = d.toISOString().slice(0,10);
    const bucket = trendMap.get(key) || { date: key, matched: 0, exceptions: 0 };
    if (row.status === "Matched") bucket.matched += 1;
    else bucket.exceptions += 1;
    trendMap.set(key, bucket);
  });
  const trend = [...trendMap.values()].sort((a,b) => a.date.localeCompare(b.date));

  return {
    rows,
    metrics: { total, matched, mismatched, unmatched, discrepancies, matchRate, discrepancyValue },
    trend,
    sourceCounts: { qos: qosRows.length, operator: operatorRows.length },
  };
}

export function exportResults(result) {
  const exportRows = result.rows.map(r => ({
    Status: r.status,
    Source: r.source,
    "QOS Transaction ID": r.qosTransactionId,
    "Operator Transaction ID": r.operatorTransactionId,
    "QOS Request ID": r.requestId,
    "Operator Request ID": r.operatorRequestId,
    Date: formatDate(r.time),
    "QOS Expected Amount": r.amount,
    "Operator Amount": r.operatorAmount,
    Difference: r.delta,
    Currency: r.currency,
    "QOS Operation": r.operationType,
    "QOS Result": r.qosResult,
    "Operator State": r.operatorState,
  }));
  const ws = XLSX.utils.json_to_sheet(exportRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Reconciliation");
  XLSX.writeFile(wb, "QOS_Reconciliation_Results.xlsx");
}
