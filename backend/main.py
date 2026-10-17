import io
import os
import secrets
import logging

import pandas as pd
import pymysql
from fastapi import FastAPI, UploadFile, File, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("qos")

app = FastAPI(title="QOS Reconciliation & Ingestion Engine")

# Allow CORS for local dev and frontend apps
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# MySQL Database Configuration (XAMPP Default)
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "recon-svc")
DB_PORT = int(os.getenv("DB_PORT", "3306"))

# Shared secret the webhook sender must provide in the X-API-Key header
API_KEY = os.getenv("QOS_API_KEY")

# ---------------------------------------------------------------------------
# QoS vs Mixx reconciliation settings -- ADJUST THESE to match your real files
# ---------------------------------------------------------------------------
# Column in transactions_tg that holds the ID Mixx also uses for the same transaction
QOS_KEY_COLUMN = "momtransaction_id"
# Column in transactions_tg to compare against the Mixx amount ("amount" or "net_amount")
QOS_AMOUNT_COLUMN = "amount"
# Possible header names in the Mixx file (after lowercasing and replacing spaces with _)
MIXX_ID_CANDIDATES = ["transaction_id", "transactionid", "trxn_id", "reference", "txn_id", "id"]
MIXX_AMOUNT_CANDIDATES = ["amount", "montant"]
MIXX_STATUS_CANDIDATES = ["status", "statut", "state"]
# Status values (lowercase) that count as a successful transaction on either side
SUCCESS_STATUSES = {"completed", "success", "successful", "succeeded", "00", "ok"}
# Amounts closer than this are treated as equal
AMOUNT_TOLERANCE = 0.01


def verify_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY:
        logger.error("QOS_API_KEY is not set on the server")
        raise HTTPException(status_code=500, detail="Server API key not configured")
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def get_db_connection():
    return pymysql.connect(
        host=DB_HOST,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        port=DB_PORT,
        cursorclass=pymysql.cursors.DictCursor,
    )


def clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Standardize column names and strip whitespace."""
    df.columns = df.columns.astype(str).str.strip().str.lower().str.replace(" ", "_")
    return df


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class QoSTransactionPayload(BaseModel):
    sendersmsisdn: str | None = None
    sendersfirstname: str | None = None
    senderslastname: str | None = None
    operation_type: str | None = None
    receiversmsisdn: str | None = None
    processingnumber: str | None = None
    amount: float | None = None
    trxndate: str | None = None
    clientid: str | None = None
    currency: str | None = None
    response: str | None = None
    responsemessage: str | None = None
    fee: float | None = None
    status: str | None = None
    clientrefno: str | None = None
    responsetime: str | None = None
    narration: str | None = None
    momtransaction_id: str | None = None
    channel: str | None = None
    transactionid: str | None = None
    net_amount: float | None = None
    country: str | None = None
    intent_id: str | None = None
    provider: str | None = None
    token: str | None = None
    sent_to_mifos: bool | None = None
    reservation_state: str | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def health_check():
    return {"status": "ok", "service": "QOS Reconciliation & Ingestion Engine"}


@app.post("/webhook/qos", dependencies=[Depends(verify_api_key)])
async def receive_qos_webhook(payload: QoSTransactionPayload):
    # A missing transactionid would bypass duplicate protection (NULLs are not
    # treated as duplicates by a UNIQUE index), so reject it up front.
    if not payload.transactionid:
        raise HTTPException(status_code=422, detail="transactionid is required")

    connection = None
    try:
        connection = get_db_connection()
        with connection.cursor() as cursor:
            sql = """
                INSERT INTO transactions_tg (
                    sendersmsisdn, sendersfirstname, senderslastname, operation_type,
                    receiversmsisdn, processingnumber, amount, trxndate, clientid,
                    currency, response, responsemessage, fee, status, clientrefno,
                    responsetime, narration, momtransaction_id, channel, transactionid,
                    net_amount, country, intent_id, provider, token, sent_to_mifos, reservation_state
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    status = VALUES(status),
                    response = VALUES(response),
                    responsemessage = VALUES(responsemessage)
            """
            cursor.execute(sql, (
                payload.sendersmsisdn, payload.sendersfirstname, payload.senderslastname, payload.operation_type,
                payload.receiversmsisdn, payload.processingnumber, payload.amount, payload.trxndate, payload.clientid,
                payload.currency, payload.response, payload.responsemessage, payload.fee, payload.status, payload.clientrefno,
                payload.responsetime, payload.narration, payload.momtransaction_id, payload.channel, payload.transactionid,
                payload.net_amount, payload.country, payload.intent_id, payload.provider, payload.token,
                1 if payload.sent_to_mifos else 0, payload.reservation_state,
            ))
            # MySQL affected-rows: 1 = new row inserted, 2 = existing row updated, 0 = existing row unchanged
            created = cursor.rowcount == 1
            connection.commit()

        return {
            "status": "success",
            "result": "created" if created else "already_ingested",
            "transactionid": payload.transactionid,
        }
    except Exception:
        if connection:
            connection.rollback()
        # Full details go to the server log, not back to the caller
        logger.exception("Webhook ingestion failed for transactionid=%s", payload.transactionid)
        # 500 so the sender knows it's our side and retries
        raise HTTPException(status_code=500, detail="Webhook ingestion failed")
    finally:
        if connection:
            connection.close()


@app.post("/api/reconcile")
async def reconcile_files(
    system_file: UploadFile = File(...),
    gateway_file: UploadFile = File(...),
):
    try:
        sys_bytes = await system_file.read()
        gtw_bytes = await gateway_file.read()

        sys_df = pd.read_excel(io.BytesIO(sys_bytes)) if system_file.filename.endswith((".xlsx", ".xls")) else pd.read_csv(io.BytesIO(sys_bytes))
        gtw_df = pd.read_excel(io.BytesIO(gtw_bytes)) if gateway_file.filename.endswith((".xlsx", ".xls")) else pd.read_csv(io.BytesIO(gtw_bytes))

        sys_df = clean_dataframe(sys_df)
        gtw_df = clean_dataframe(gtw_df)

        sys_id_col = "transaction_id" if "transaction_id" in sys_df.columns else sys_df.columns[0]
        gtw_id_col = "transaction_id" if "transaction_id" in gtw_df.columns else gtw_df.columns[0]

        sys_df[sys_id_col] = sys_df[sys_id_col].astype(str).str.strip()
        gtw_df[gtw_id_col] = gtw_df[gtw_id_col].astype(str).str.strip()

        merged = pd.merge(
            sys_df,
            gtw_df,
            left_on=sys_id_col,
            right_on=gtw_id_col,
            how="outer",
            indicator=True,
        )

        total_records = len(merged)
        matched_records = len(merged[merged["_merge"] == "both"])
        missing_in_gateway = len(merged[merged["_merge"] == "left_only"])
        missing_in_system = len(merged[merged["_merge"] == "right_only"])

        audit_health = round((matched_records / total_records * 100), 2) if total_records > 0 else 0.0

        return {
            "summary": {
                "audit_health": audit_health,
                "total_records": total_records,
                "matched_records": matched_records,
                "missing_in_gateway": missing_in_gateway,
                "missing_in_system": missing_in_system,
            },
            "mismatched_ids": merged[merged["_merge"] != "both"][sys_id_col].fillna(merged[gtw_id_col]).head(100).tolist(),
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Reconciliation failed: {str(e)}")


# ---------------------------------------------------------------------------
# QoS (live, from MySQL) vs Mixx (uploaded file) reconciliation
# ---------------------------------------------------------------------------
def pick_column(df: pd.DataFrame, candidates: list[str]) -> str | None:
    for name in candidates:
        if name in df.columns:
            return name
    return None


def to_number(series: pd.Series) -> pd.Series:
    cleaned = series.astype(str).str.replace(",", "", regex=False).str.replace(" ", "", regex=False).str.strip()
    return pd.to_numeric(cleaned, errors="coerce")


def classify_row(row) -> str:
    if row["_merge"] == "left_only":
        return "MISSING_IN_MIXX"
    if row["_merge"] == "right_only":
        return "MISSING_IN_QOS"

    q_amt, m_amt = row["qos_amount"], row["mixx_amount"]
    if pd.notna(q_amt) and pd.notna(m_amt) and abs(q_amt - m_amt) > AMOUNT_TOLERANCE:
        return "AMOUNT_MISMATCH"

    q_status, m_status = row["qos_status"], row["mixx_status"]
    if pd.notna(q_status) and pd.notna(m_status):
        if (str(q_status).lower() in SUCCESS_STATUSES) != (str(m_status).lower() in SUCCESS_STATUSES):
            return "STATUS_MISMATCH"

    return "MATCHED"


@app.post("/api/reconcile/mixx")
async def reconcile_qos_vs_mixx(
    mixx_file: UploadFile = File(...),
    date_from: str | None = None,
    date_to: str | None = None,
):
    """
    Compares the live QoS transactions in MySQL (transactions_tg) against an uploaded Mixx file.
    Optional date_from / date_to (e.g. 2026-10-01) limit which QoS rows are compared,
    so a one-day Mixx file isn't compared against months of QoS data.
    """
    try:
        # ---- Mixx file -------------------------------------------------
        raw = await mixx_file.read()
        filename = (mixx_file.filename or "").lower()
        if filename.endswith((".xlsx", ".xls")):
            mixx_df = pd.read_excel(io.BytesIO(raw))
        else:
            mixx_df = pd.read_csv(io.BytesIO(raw))
        mixx_df = clean_dataframe(mixx_df)

        id_col = pick_column(mixx_df, MIXX_ID_CANDIDATES)
        if not id_col:
            raise HTTPException(
                status_code=400,
                detail=f"No transaction ID column found in Mixx file. Columns found: {list(mixx_df.columns)}. "
                       f"Add the right name to MIXX_ID_CANDIDATES in main.py.",
            )
        amount_col = pick_column(mixx_df, MIXX_AMOUNT_CANDIDATES)
        status_col = pick_column(mixx_df, MIXX_STATUS_CANDIDATES)

        mixx_df = mixx_df[mixx_df[id_col].notna()].copy()
        mixx = pd.DataFrame({"match_key": mixx_df[id_col].astype(str).str.strip()})
        mixx["mixx_amount"] = to_number(mixx_df[amount_col]) if amount_col else float("nan")
        mixx["mixx_status"] = mixx_df[status_col].astype(str).str.strip().str.lower() if status_col else None
        mixx = mixx[mixx["match_key"] != ""]

        mixx_duplicate_ids = mixx[mixx.duplicated("match_key", keep=False)]["match_key"].unique().tolist()
        mixx = mixx.drop_duplicates("match_key", keep="first")

        # ---- QoS data from MySQL ----------------------------------------
        sql = (
            f"SELECT transactionid, {QOS_KEY_COLUMN} AS match_key, {QOS_AMOUNT_COLUMN} AS qos_amount, "
            f"status AS qos_status, trxndate FROM transactions_tg"
        )
        clauses, params = [], []
        if date_from:
            clauses.append("trxndate >= %s")
            params.append(date_from)
        if date_to:
            clauses.append("trxndate <= %s")
            params.append(date_to)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)

        connection = get_db_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql, params)
                qos_rows = cursor.fetchall()
        finally:
            connection.close()

        qos = pd.DataFrame(qos_rows, columns=["transactionid", "match_key", "qos_amount", "qos_status", "trxndate"])
        qos_total_rows = len(qos)
        qos = qos[qos["match_key"].notna()].copy()
        qos["match_key"] = qos["match_key"].astype(str).str.strip()
        qos = qos[qos["match_key"] != ""]
        qos_without_key = qos_total_rows - len(qos)

        qos_duplicate_ids = qos[qos.duplicated("match_key", keep=False)]["match_key"].unique().tolist()
        qos = qos.drop_duplicates("match_key", keep="first")
        qos["qos_amount"] = to_number(qos["qos_amount"])
        qos["qos_status"] = qos["qos_status"].astype(str).str.strip().str.lower()

        # ---- Compare -----------------------------------------------------
        merged = qos.merge(mixx, on="match_key", how="outer", indicator=True)
        merged["result"] = merged.apply(classify_row, axis=1)

        counts = merged["result"].value_counts().to_dict()
        total = len(merged)
        matched = int(counts.get("MATCHED", 0))

        exceptions = merged[merged["result"] != "MATCHED"].copy()
        exceptions["trxndate"] = exceptions["trxndate"].astype(str).replace({"NaT": None, "nan": None, "None": None})
        exceptions = exceptions[
            ["match_key", "transactionid", "trxndate", "qos_amount", "mixx_amount", "qos_status", "mixx_status", "result"]
        ]
        exceptions = exceptions.astype(object).where(pd.notna(exceptions), None)

        return {
            "summary": {
                "audit_health": round(matched / total * 100, 2) if total else 0.0,
                "total_compared": total,
                "matched": matched,
                "missing_in_mixx": int(counts.get("MISSING_IN_MIXX", 0)),
                "missing_in_qos": int(counts.get("MISSING_IN_QOS", 0)),
                "amount_mismatch": int(counts.get("AMOUNT_MISMATCH", 0)),
                "status_mismatch": int(counts.get("STATUS_MISMATCH", 0)),
            },
            "warnings": {
                "qos_rows_without_match_key": qos_without_key,
                "duplicate_ids_in_mixx_file": mixx_duplicate_ids[:50],
                "duplicate_ids_in_qos": qos_duplicate_ids[:50],
                "mixx_columns_used": {"id": id_col, "amount": amount_col, "status": status_col},
            },
            "exceptions": exceptions.head(500).to_dict(orient="records"),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("QoS vs Mixx reconciliation failed")
        raise HTTPException(status_code=400, detail=f"Reconciliation failed: {str(e)}")