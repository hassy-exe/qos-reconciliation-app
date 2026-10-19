
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import secrets
import time
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional

import pandas as pd
import pymysql
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("qos-recon")

app = FastAPI(title="QOS Reconciliation & Ingestion Engine")
app.add_middleware(GZipMiddleware, minimum_size=1000)

origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_USER = os.getenv("DB_USER", "")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
API_KEY = os.getenv("API_KEY", "")
TEAM_PASSWORD = os.getenv("TEAM_PASSWORD", "")
TOKEN_SECRET = os.getenv("TOKEN_SECRET", "change-this-token-secret")
TOKEN_HOURS = int(os.getenv("TOKEN_HOURS", "12"))


def get_db_connection():
    if not DB_USER or not DB_NAME:
        raise RuntimeError("DB_USER and DB_NAME must be set in backend/.env")

    return pymysql.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        port=DB_PORT,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=15,
        read_timeout=300,
        write_timeout=300,
        autocommit=True,
    )


def _sign(value: str) -> str:
    return hmac.new(
        TOKEN_SECRET.encode(),
        value.encode(),
        hashlib.sha256,
    ).hexdigest()


def _make_token(password: str) -> str:
    expires = str(int(time.time()) + TOKEN_HOURS * 3600)
    fingerprint = hashlib.sha256(password.encode()).hexdigest()[:16]
    payload = f"{expires}:{fingerprint}"
    return f"{payload}:{_sign(payload)}"


def require_login(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Login required")

    token = authorization.split(" ", 1)[1].strip()

    try:
        expires, fingerprint, signature = token.split(":", 2)
        payload = f"{expires}:{fingerprint}"

        if int(expires) < int(time.time()):
            raise ValueError("Expired token")

        if not hmac.compare_digest(signature, _sign(payload)):
            raise ValueError("Invalid signature")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    return True


class LoginPayload(BaseModel):
    password: str


class QoSTransactionPayload(BaseModel):
    sendersmsisdn: Optional[str] = None
    receiversmsisdn: Optional[str] = None
    amount: Optional[float] = None
    net_amount: Optional[float] = None
    currency: Optional[str] = None
    clientid: Optional[str] = None
    clientrefno: Optional[str] = None
    momtransaction_id: Optional[str] = None
    operation_type: Optional[str] = None
    trxndate: Optional[str] = None
    response: Optional[str] = None
    responsemessage: Optional[str] = None


def json_default(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)


@app.get("/")
def health():
    return {"ok": True, "service": "QOS Recon API"}


@app.post("/api/login")
def login(payload: LoginPayload):
    if not TEAM_PASSWORD:
        raise HTTPException(status_code=500, detail="TEAM_PASSWORD is not configured")

    if not secrets.compare_digest(payload.password, TEAM_PASSWORD):
        raise HTTPException(status_code=401, detail="Wrong password")

    return {
        "token": _make_token(payload.password),
        "expires_in": TOKEN_HOURS * 3600,
    }


def tidy(value):
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def upper(value):
    return tidy(value).upper()


def number(value):
    if value is None or value == "":
        return None
    try:
        result = float(str(value).replace(",", "").strip())
        return result if pd.notna(result) else None
    except (TypeError, ValueError):
        return None


def date_key(value):
    if value is None or value == "":
        return ""

    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")

    text = str(value).strip()
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        return text[:10]

    parsed = pd.to_datetime(value, errors="coerce")
    return "" if pd.isna(parsed) else parsed.strftime("%Y-%m-%d")


def parse_bound(value, is_end=False):
    try:
        if len(value) == 10:
            parsed = datetime.strptime(value, "%Y-%m-%d")
            if is_end:
                parsed = parsed.replace(hour=23, minute=59, second=59)
            return parsed

        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date: {value}")


def read_operator_file(contents, filename):
    if not contents:
        raise HTTPException(status_code=400, detail="The Mixx file is empty")

    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(contents))
        else:
            df = pd.read_excel(io.BytesIO(contents))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read the Mixx workbook: {exc}",
        )

    df.columns = [str(column).strip() for column in df.columns]
    return df.where(pd.notna(df), None).to_dict(orient="records")


def fetch_qos_rows(date_from, date_to):
    if not date_from or not date_to:
        raise HTTPException(
            status_code=400,
            detail="Both start and end dates are required",
        )

    start = parse_bound(date_from)
    end = parse_bound(date_to, is_end=True)

    if start > end:
        raise HTTPException(status_code=400, detail="Start date is after end date")

    sql = """
        SELECT
            momtransaction_id AS momtransactionId,
            clientid,
            clientrefno AS transRef,
            operation_type AS operationType,
            amount,
            net_amount AS netAmount,
            trxndate,
            currency,
            response,
            responsemessage
        FROM transactions_tg
        WHERE trxndate >= %s AND trxndate <= %s
        ORDER BY trxndate
    """

    rows = []
    connection = None
    cursor = None

    try:
        connection = get_db_connection()
        cursor = connection.cursor(pymysql.cursors.SSDictCursor)
        cursor.execute(sql, (start, end))

        while True:
            batch = cursor.fetchmany(5000)
            if not batch:
                break
            rows.extend(batch)
    except Exception:
        logger.exception("Failed to fetch QOS transactions")
        raise HTTPException(status_code=500, detail="Could not load QOS transactions")
    finally:
        if cursor:
            cursor.close()
        if connection:
            connection.close()

    return rows


def composite_from_qos(row):
    client = tidy(row.get("clientid"))
    ref = tidy(row.get("transRef"))
    return f"{client}!{ref}" if client and ref else ""


def expected_amount(qos):
    if upper(qos.get("operationType")) == "MAKEDEPOSIT":
        value = qos.get("netAmount")
        return number(value if value is not None else qos.get("amount"))
    return number(qos.get("amount"))


def qos_successful(qos):
    return (
        upper(qos.get("responsemessage")) == "SUCCESSFULL"
        or number(qos.get("response")) == 0
    )


def reconcile_records(qos_rows, operator_rows):
    # Preserve the frontend rule: the last duplicate key wins.
    by_trans_id = {}
    by_request = {}

    for index, op in enumerate(operator_rows):
        tx = tidy(op.get("trans_id"))
        request = tidy(op.get("idRequete"))

        if tx:
            by_trans_id[tx] = {"row": op, "index": index}
        if request:
            by_request[request] = {"row": op, "index": index}

    used_operator = set()
    rows = []
    matched = mismatched = unmatched = 0
    discrepancy_value = 0.0
    trend_map = {}

    def add_trend(value, status):
        key = date_key(value)
        if not key:
            return

        if key not in trend_map:
            trend_map[key] = {
                "date": key,
                "matched": 0,
                "exceptions": 0,
            }

        if status == "Matched":
            trend_map[key]["matched"] += 1
        else:
            trend_map[key]["exceptions"] += 1

    for index, qos in enumerate(qos_rows):
        tx = tidy(qos.get("momtransactionId"))
        request = composite_from_qos(qos)

        found = (by_trans_id.get(tx) if tx else None) or (
            by_request.get(request) if request else None
        )

        op = found["row"] if found else None
        if found:
            used_operator.add(found["index"])

        expected = expected_amount(qos)
        actual = number(op.get("Amount")) if op else None

        amount_matches = (
            expected is None
            or actual is None
            or abs(expected - actual) < 0.01
        )
        tx_matches = bool(tx and op and tx == tidy(op.get("trans_id")))
        request_matches = bool(
            request and op and request == tidy(op.get("idRequete"))
        )

        if not op:
            status = "Unmatched"
        elif amount_matches and (tx_matches or request_matches):
            status = "Matched"
        else:
            status = "Mismatched"

        delta = (
            actual - expected
            if op and actual is not None and expected is not None
            else None
        )

        if status == "Matched":
            matched += 1
        elif status == "Mismatched":
            mismatched += 1
        else:
            unmatched += 1

        if delta is not None:
            discrepancy_value += delta

        rows.append({
            "rowKey": f"qos-{index}",
            "source": "QOS",
            "id": tx or request or tidy(qos.get("transRef")) or f"QOS-{index + 1}",
            "qosTransactionId": tx,
            "operatorTransactionId": tidy(op.get("trans_id")) if op else "",
            "requestId": request,
            "operatorRequestId": tidy(op.get("idRequete")) if op else "",
            "time": qos.get("trxndate"),
            "amount": expected,
            "operatorAmount": actual,
            "delta": delta,
            "currency": tidy(qos.get("currency")) or "XOF",
            "status": status,
            "operationType": tidy(qos.get("operationType")),
            "qosResult": tidy(qos.get("responsemessage")),
            "operatorState": tidy(op.get("trans_state")) if op else "Missing",
            "qosSuccessful": qos_successful(qos),
        })

        add_trend(qos.get("trxndate"), status)

    for index, op in enumerate(operator_rows):
        if index in used_operator:
            continue

        unmatched += 1
        tx = tidy(op.get("trans_id"))
        request = tidy(op.get("idRequete"))

        rows.append({
            "rowKey": f"operator-{index}",
            "source": "Operator",
            "id": tx or request or f"OP-{index + 1}",
            "qosTransactionId": "",
            "operatorTransactionId": tx,
            "requestId": "",
            "operatorRequestId": request,
            "time": op.get("trans_date"),
            "amount": None,
            "operatorAmount": number(op.get("Amount")),
            "delta": None,
            "currency": "XOF",
            "status": "Unmatched",
            "operationType": tidy(op.get("trans_type")),
            "qosResult": "Missing",
            "operatorState": tidy(op.get("trans_state")),
            "qosSuccessful": False,
        })

        add_trend(op.get("trans_date"), "Unmatched")

    total = len(rows)
    discrepancies = mismatched + unmatched

    return {
        "rows": rows,
        "metrics": {
            "total": total,
            "matched": matched,
            "mismatched": mismatched,
            "unmatched": unmatched,
            "discrepancies": discrepancies,
            "matchRate": matched / total * 100 if total else 0,
            "discrepancyValue": discrepancy_value,
        },
        "trend": [trend_map[key] for key in sorted(trend_map)],
        "sourceCounts": {
            "qos": len(qos_rows),
            "operator": len(operator_rows),
        },
    }


@app.post("/webhook/qos")
def qos_webhook(
    payload: QoSTransactionPayload,
    x_api_key: Optional[str] = Header(default=None),
):
    if API_KEY and not hmac.compare_digest(x_api_key or "", API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")

    data = payload.model_dump(exclude_none=True) if hasattr(
        payload, "model_dump"
    ) else payload.dict(exclude_none=True)

    if not data:
        raise HTTPException(status_code=400, detail="Empty payload")

    columns = list(data)
    sql = (
        "INSERT INTO transactions_tg ("
        + ", ".join(f"`{column}`" for column in columns)
        + ") VALUES ("
        + ", ".join(["%s"] * len(columns))
        + ")"
    )

    try:
        with get_db_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, [data[column] for column in columns])
        return {"ok": True}
    except Exception:
        logger.exception("Could not insert QOS webhook payload")
        raise HTTPException(status_code=500, detail="Could not store QOS transaction")


@app.post("/api/reconcile/run")
async def reconcile_run(
    file: UploadFile = File(...),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    _logged_in: bool = Depends(require_login),
):
    started = time.perf_counter()
    operator_rows = read_operator_file(await file.read(), file.filename or "")

    if not operator_rows:
        raise HTTPException(status_code=400, detail="The Mixx workbook has no data rows")

    # If dates are omitted, infer them from Mixx transaction dates.
    dates = sorted(
        key for key in (date_key(row.get("trans_date")) for row in operator_rows)
        if key
    )

    date_from = date_from or (dates[0] if dates else None)
    date_to = date_to or (dates[-1] if dates else None)

    if not date_from or not date_to:
        raise HTTPException(
            status_code=400,
            detail="Choose a date range; Mixx trans_date dates could not be determined.",
        )

    # Filter Mixx rows to the selected date range, matching the frontend behaviour.
    operator_rows = [
        row for row in operator_rows
        if date_from <= date_key(row.get("trans_date")) <= date_to
    ]

    if not operator_rows:
        raise HTTPException(
            status_code=400,
            detail="No Mixx transactions were found in the selected date range.",
        )

    qos_rows = fetch_qos_rows(date_from, date_to)

    if not qos_rows:
        raise HTTPException(
            status_code=404,
            detail="No QOS transactions were found for the selected dates.",
        )

    result = reconcile_records(qos_rows, operator_rows)
    result["serverSeconds"] = round(time.perf_counter() - started, 2)

    logger.info(
        "Reconciliation completed in %.2fs: QOS=%s operator=%s output=%s",
        result["serverSeconds"],
        len(qos_rows),
        len(operator_rows),
        len(result["rows"]),
    )

    return Response(
    content=json.dumps(
        result,
        default=json_default,
        separators=(",", ":"),
    ),
    media_type="application/json",
)


@app.post("/api/reconcile")
async def reconcile_files(
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...),
    _logged_in: bool = Depends(require_login),
):
    try:
        def load_file(upload):
            name = (upload.filename or "").lower()
            return (
                pd.read_csv(upload.file)
                if name.endswith(".csv")
                else pd.read_excel(upload.file)
            )

        a = load_file(file_a)
        b = load_file(file_b)
        a.columns = [str(c).strip() for c in a.columns]
        b.columns = [str(c).strip() for c in b.columns]
        common = [column for column in a.columns if column in b.columns]

        if not common:
            raise HTTPException(status_code=400, detail="Files have no columns in common")

        merged = a.merge(
            b, how="outer", on=common, indicator=True, suffixes=("_a", "_b")
        )
        records = json.loads(merged.to_json(orient="records", date_format="iso"))
        return {"rows": records, "total": len(records), "common_columns": common}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Generic file reconciliation failed")
        raise HTTPException(status_code=400, detail=f"Could not reconcile files: {exc}")


@app.post("/api/reconcile/mixx")
async def reconcile_mixx_legacy(
    file: UploadFile = File(...),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    _logged_in: bool = Depends(require_login),
):
    # Keep the old route available, but use the same rules as the new endpoint.
    started = time.perf_counter()
    operator_rows = read_operator_file(await file.read(), file.filename or "")

    dates = sorted(
        key for key in (date_key(row.get("trans_date")) for row in operator_rows)
        if key
    )
    date_from = date_from or (dates[0] if dates else None)
    date_to = date_to or (dates[-1] if dates else None)

    qos_rows = fetch_qos_rows(date_from, date_to)
    result = reconcile_records(qos_rows, operator_rows)
    result["serverSeconds"] = round(time.perf_counter() - started, 2)
    return Response(
    content=json.dumps(
        result,
        default=json_default,
        separators=(",", ":"),
    ),
    media_type="application/json",
)


@app.get("/api/qos/transactions")
def get_qos_transactions(
    date_from: str,
    date_to: str,
    _logged_in: bool = Depends(require_login),
):
    start = parse_bound(date_from)
    end = parse_bound(date_to, is_end=True)

    if start > end:
        raise HTTPException(status_code=400, detail="Start date is after end date")

    sql = """
        SELECT momtransaction_id AS momtransactionId,
               clientid,
               clientrefno AS transRef,
               operation_type AS operationType,
               amount,
               net_amount AS netAmount,
               trxndate,
               currency,
               response,
               responsemessage
        FROM transactions_tg
        WHERE trxndate >= %s AND trxndate <= %s
        ORDER BY trxndate
    """

    def stream():
        connection = None
        cursor = None

        try:
            connection = get_db_connection()
            cursor = connection.cursor(pymysql.cursors.SSDictCursor)
            cursor.execute(sql, (start, end))
            yield "["
            first = True

            while True:
                batch = cursor.fetchmany(1000)
                if not batch:
                    break

                encoded = []
                for row in batch:
                    if not first:
                        encoded.append(",")
                    first = False
                    encoded.append(
                        json.dumps(row, default=json_default, separators=(",", ":"))
                    )
                yield "".join(encoded)

            yield "]"
        except Exception:
            logger.exception("Could not stream QOS transactions")
            raise
        finally:
            if cursor:
                cursor.close()
            if connection:
                connection.close()

    return StreamingResponse(stream(), media_type="application/json")
