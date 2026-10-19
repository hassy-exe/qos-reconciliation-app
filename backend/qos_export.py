"""
Export QOS transactions from the database to a CSV file, and time it.

Run it from the project folder, for example:

    .\\venv\\Scripts\\python.exe qos_export.py 2026-10-17 2026-10-17
    .\\venv\\Scripts\\python.exe qos_export.py 2026-07-01 2026-07-31
    .\\venv\\Scripts\\python.exe qos_export.py 2026-10-17 2026-10-17 --success-only

It asks for the database login. The password is typed hidden and is never saved.
(If you set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME or DB_PORT as environment
variables, it uses those instead of asking.)

The CSV uses the same column names as the QOS workbook, so the reconciliation
page can read it.
"""
import argparse
import csv
import getpass
import os
import sys
import time
from datetime import datetime

import pymysql

COLUMNS = [
    "momtransactionId", "clientid", "transRef", "operationType", "amount",
    "netAmount", "trxndate", "currency", "response", "responsemessage",
]

SQL = """
    SELECT momtransaction_id, clientid, clientrefno, operation_type, amount,
           net_amount, trxndate, currency, response, responsemessage
    FROM transactions_tg
    WHERE trxndate >= %s AND trxndate <= %s
    {extra}
    ORDER BY trxndate
"""


def fmt(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return value


def write_csv(rows, path, progress_every=100_000):
    """Write an iterable of row tuples to a CSV file. Returns the number of rows written."""
    count = 0
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        for row in rows:
            writer.writerow([fmt(v) for v in row])
            count += 1
            if progress_every and count % progress_every == 0:
                print(f"  ...{count:,} rows written")
    return count


def ask(env_name, prompt, secret=False, default=None):
    value = os.getenv(env_name)
    if value:
        return value
    text = f"{prompt}" + (f" [{default}]" if default else "") + ": "
    value = getpass.getpass(text) if secret else input(text)
    return value.strip() or default


def main():
    parser = argparse.ArgumentParser(description="Export QOS transactions to CSV")
    parser.add_argument("date_from", help="first day, e.g. 2026-10-17")
    parser.add_argument("date_to", help="last day (included), e.g. 2026-10-17")
    parser.add_argument("--success-only", action="store_true", help="only transactions with response 00")
    parser.add_argument("--out", help="output file name")
    args = parser.parse_args()

    start = f"{args.date_from} 00:00:00"
    end = f"{args.date_to} 23:59:59"
    out_path = args.out or f"QOS_export_{args.date_from}_to_{args.date_to}.csv"

    host = ask("DB_HOST", "Database host")
    user = ask("DB_USER", "Database user")
    password = ask("DB_PASSWORD", "Database password", secret=True)
    name = ask("DB_NAME", "Database name", default="autoremit")
    port = int(ask("DB_PORT", "Database port", default="3306"))

    extra = "AND response = '00'" if args.success_only else ""

    print("\nConnecting...")
    t0 = time.time()
    try:
        connection = pymysql.connect(
            host=host, user=user, password=password, database=name, port=port,
            connect_timeout=20, cursorclass=pymysql.cursors.SSCursor,
        )
    except pymysql.err.OperationalError as e:
        print(f"\nCould not connect: {e}")
        print("If this says 'timed out' or 'Can't connect', the database firewall may be")
        print("blocking this computer. If it says 'Access denied', check the user and password.")
        sys.exit(1)
    t_connect = time.time() - t0

    try:
        with connection.cursor() as cursor:
            t1 = time.time()
            cursor.execute(SQL.format(extra=extra), (start, end))
            t_query = time.time() - t1

            t2 = time.time()
            rows = write_csv(cursor, out_path)
            t_write = time.time() - t2
    finally:
        connection.close()

    total = time.time() - t0
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print("\nDone.")
    print(f"  File:            {out_path}  ({size_mb:.1f} MB)")
    print(f"  Rows:            {rows:,}")
    print(f"  Connect time:    {t_connect:.1f} s")
    print(f"  Query start:     {t_query:.1f} s")
    print(f"  Fetch + write:   {t_write:.1f} s")
    print(f"  TOTAL:           {total:.1f} s")


if __name__ == "__main__":
    main()
