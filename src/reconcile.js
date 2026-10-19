
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

  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value;
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(
        parsed.y, parsed.m - 1, parsed.d,
        parsed.H, parsed.M, parsed.S
      );
    }
  }

  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d;
}

export function formatDate(value) {
  const d = excelDate(value);
  if (!d) return tidy(value) || "—";

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

export function money(value, currency = "XOF") {
  const n = number(value) ?? 0;
  return `${currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(n)}`;
}

export async function readWorkbook(fileOrBuffer) {
  let bytes;

  if (fileOrBuffer instanceof ArrayBuffer) {
    bytes = fileOrBuffer;
  } else if (ArrayBuffer.isView(fileOrBuffer)) {
    bytes = fileOrBuffer.buffer.slice(
      fileOrBuffer.byteOffset,
      fileOrBuffer.byteOffset + fileOrBuffer.byteLength
    );
  } else {
    bytes = await fileOrBuffer.arrayBuffer();
  }

  const isCsv =
    typeof fileOrBuffer?.name === "string" &&
    fileOrBuffer.name.toLowerCase().endsWith(".csv");

  const wb = XLSX.read(bytes, {
    type: "array",
    cellDates: true,
    raw: isCsv,
  });

  const ws = wb.Sheets[wb.SheetNames[0]];

  return XLSX.utils.sheet_to_json(ws, {
    defval: "",
    raw: true,
  });
}

function compositeFromQos(row) {
  const client = tidy(row.clientid);
  const ref = tidy(row.transRef);

  return client && ref ? `${client}!${ref}` : "";
}

function operatorAmountExpected(qosRow) {
  const op = upper(qosRow.operationType);

  if (op === "MAKEDEPOSIT") {
    return number(qosRow.netAmount ?? qosRow.amount);
  }

  return number(qosRow.amount);
}

function isQosSuccessful(row) {
  return (
    upper(row.responsemessage) === "SUCCESSFULL" ||
    Number(row.response) === 0
  );
}

function statusFor(qos, op) {
  if (!op) return "Unmatched";

  const expected = operatorAmountExpected(qos);
  const actual = number(op.Amount);

  const amountMatches =
    expected === null || actual === null
      ? true
      : Math.abs(expected - actual) < 0.01;

  const txId = tidy(qos.momtransactionId);
  const opTxId = tidy(op.trans_id);

  const qosRequest = compositeFromQos(qos);
  const opRequest = tidy(op.idRequete);

  const txIdMatches = Boolean(txId && txId === opTxId);
  const reqMatches = Boolean(qosRequest && qosRequest === opRequest);

  return amountMatches && (txIdMatches || reqMatches)
    ? "Matched"
    : "Mismatched";
}

export function reconcile(qosRows, operatorRows) {
  // Index operator transactions once for constant-time lookups.
  const byTransId = new Map();
  const byRequest = new Map();

  for (let i = 0; i < operatorRows.length; i++) {
    const row = operatorRows[i];
    const id = tidy(row.trans_id);
    const req = tidy(row.idRequete);

    // Preserve the original behavior: the last duplicate wins.
    if (id) byTransId.set(id, { row, index: i });
    if (req) byRequest.set(req, { row, index: i });
  }

  const usedOperator = new Set();
  const rows = [];

  let matched = 0;
  let mismatched = 0;
  let unmatched = 0;
  let discrepancyValue = 0;

  const trendMap = new Map();

  function addTrend(time, status) {
    const d = excelDate(time);
    if (!d) return;

    const key = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");

    let bucket = trendMap.get(key);

    if (!bucket) {
      bucket = { date: key, matched: 0, exceptions: 0 };
      trendMap.set(key, bucket);
    }

    if (status === "Matched") bucket.matched++;
    else bucket.exceptions++;
  }

  // Reconcile QOS transactions in one pass.
  for (let index = 0; index < qosRows.length; index++) {
    const qos = qosRows[index];

    const tx = tidy(qos.momtransactionId);
    const req = compositeFromQos(qos);

    const found =
      (tx && byTransId.get(tx)) ||
      (req && byRequest.get(req)) ||
      null;

    const op = found?.row || null;

    if (found) usedOperator.add(found.index);

    const status = statusFor(qos, op);
    const expectedAmount = operatorAmountExpected(qos);
    const operatorAmount = op ? number(op.Amount) : null;

    const delta =
      op && expectedAmount !== null && operatorAmount !== null
        ? operatorAmount - expectedAmount
        : null;

    if (status === "Matched") matched++;
    else if (status === "Mismatched") mismatched++;
    else unmatched++;

    if (delta !== null) discrepancyValue += delta;

    const time = qos.trxndate;

    rows.push({
      rowKey: `qos-${index}`,
      source: "QOS",
      id: tx || req || tidy(qos.transRef) || `QOS-${index + 1}`,
      qosTransactionId: tx,
      operatorTransactionId: op ? tidy(op.trans_id) : "",
      requestId: req,
      operatorRequestId: op ? tidy(op.idRequete) : "",
      time,
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

    addTrend(time, status);
  }

  // Add operator transactions not consumed by a QOS match.
  for (let index = 0; index < operatorRows.length; index++) {
    if (usedOperator.has(index)) continue;

    const op = operatorRows[index];
    const time = op.trans_date;

    unmatched++;

    rows.push({
      rowKey: `operator-${index}`,
      source: "Operator",
      id: tidy(op.trans_id) || tidy(op.idRequete) || `OP-${index + 1}`,
      qosTransactionId: "",
      operatorTransactionId: tidy(op.trans_id),
      requestId: "",
      operatorRequestId: tidy(op.idRequete),
      time,
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

    addTrend(time, "Unmatched");
  }

  const total = rows.length;
  const discrepancies = mismatched + unmatched;
  const matchRate = total ? (matched / total) * 100 : 0;

  const trend = [...trendMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  return {
    rows,
    metrics: {
      total,
      matched,
      mismatched,
      unmatched,
      discrepancies,
      matchRate,
      discrepancyValue,
    },
    trend,
    sourceCounts: {
      qos: qosRows.length,
      operator: operatorRows.length,
    },
  };
}

export function exportResults(result) {
  const exportRows = result.rows.map((r) => ({
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
