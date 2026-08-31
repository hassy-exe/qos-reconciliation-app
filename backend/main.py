from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import io

app = FastAPI(title="QOS Reconciliation Engine")

# Allow your React app on Render or local dev to communicate with this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Standardize column names and strip whitespace."""
    df.columns = df.columns.astype(str).str.strip().str.lower().str.replace(' ', '_')
    return df

@app.get("/")
def health_check():
    return {"status": "ok", "service": "QOS Reconciliation Engine"}

@app.post("/api/reconcile")
async def reconcile_files(
    system_file: UploadFile = File(...),
    gateway_file: UploadFile = File(...)
):
    try:
        # Read Excel/CSV buffers into Pandas
        sys_bytes = await system_file.read()
        gtw_bytes = await gateway_file.read()

        sys_df = pd.read_excel(io.BytesIO(sys_bytes)) if system_file.filename.endswith(('.xlsx', '.xls')) else pd.read_csv(io.BytesIO(sys_bytes))
        gtw_df = pd.read_excel(io.BytesIO(gtw_bytes)) if gateway_file.filename.endswith(('.xlsx', '.xls')) else pd.read_csv(io.BytesIO(gtw_bytes))

        sys_df = clean_dataframe(sys_df)
        gtw_df = clean_dataframe(gtw_df)

        # Expected key columns (adjust column names to match your dataset schema)
        sys_id_col = 'transaction_id' if 'transaction_id' in sys_df.columns else sys_df.columns[0]
        gtw_id_col = 'transaction_id' if 'transaction_id' in gtw_df.columns else gtw_df.columns[0]

        # Convert IDs to string for exact matching
        sys_df[sys_id_col] = sys_df[sys_id_col].astype(str).str.strip()
        gtw_df[gtw_id_col] = gtw_df[gtw_id_col].astype(str).str.strip()

        # Execute Reconciliation Join
        merged = pd.merge(
            sys_df, 
            gtw_df, 
            left_on=sys_id_col, 
            right_on=gtw_id_col, 
            how='outer', 
            indicator=True
        )

        total_records = len(merged)
        matched_records = len(merged[merged['_merge'] == 'both'])
        missing_in_gateway = len(merged[merged['_merge'] == 'left_only'])
        missing_in_system = len(merged[merged['_merge'] == 'right_only'])

        # Calculate Audit Health %
        audit_health = round((matched_records / total_records * 100), 2) if total_records > 0 else 0.0

        return {
            "summary": {
                "audit_health": audit_health,
                "total_records": total_records,
                "matched_records": matched_records,
                "missing_in_gateway": missing_in_gateway,
                "missing_in_system": missing_in_system
            },
            "mismatched_ids": merged[merged['_merge'] != 'both'][sys_id_col].fillna(merged[gtw_id_col]).head(100).tolist()
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Reconciliation failed: {str(e)}")