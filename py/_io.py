"""Shared IO for compute-engine Python analyses.
Each analysis script: reads a params dict (argv[1] = JSON), loads the requested
dataset + series, runs, and prints a single JSON object to stdout. No network,
no writes outside the cwd. Errors -> JSON {"error": ...} + exit 1.
"""
import json, sys, os
import pandas as pd
import numpy as np

REPO = os.environ.get("COMPUTE_REPO", "/home/ecolex/versiondevs/ivy-fineco")

# Whitelisted datasets (id -> path). No arbitrary file access.
DATASETS = {
    "g20": f"{REPO}/papers/contagion-channels/data/G20.xlsx",
}

def load_params():
    if len(sys.argv) < 2:
        fail("no params JSON argument")
    try:
        return json.loads(sys.argv[1])
    except Exception as e:
        fail(f"bad params JSON: {e}")

def load_series(params):
    """Return (df, returns_df). df = raw levels indexed by Date; returns = log returns."""
    ds = params.get("dataset", "g20")
    if ds not in DATASETS:
        fail(f"unknown dataset '{ds}'; allowed: {list(DATASETS)}")
    df = pd.read_excel(DATASETS[ds])
    df = df.set_index(df.columns[0])
    df.index = pd.to_datetime(df.index)
    df = df.apply(pd.to_numeric, errors="coerce")
    # optional date window
    if params.get("start"): df = df[df.index >= pd.to_datetime(params["start"])]
    if params.get("end"):   df = df[df.index <= pd.to_datetime(params["end"])]
    rets = np.log(df).diff().dropna(how="all")
    return df, rets

def pick_columns(rets, params):
    cols = params.get("series")
    if cols:
        missing = [c for c in cols if c not in rets.columns]
        if missing: fail(f"series not found: {missing}; available: {list(rets.columns)}")
        return rets[cols].dropna()
    return rets.dropna()

def emit(obj):
    print(json.dumps(obj, default=str))
    sys.exit(0)

def fail(msg):
    print(json.dumps({"error": str(msg)}))
    sys.exit(1)
