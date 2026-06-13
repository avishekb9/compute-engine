#!/usr/bin/env python3
"""
ksg_te_gpu_trial.py — minimal GPU feasibility trial for the engine's hottest CPU
path: the Kraskov-Stoegbauer-Grassberger / Frenzel-Pompe max-norm transfer-entropy
k-nearest-neighbour search (k=4, the engine default), which is what `ksg_te` and
`ksg_robustness` spend their O(n^2) time on, and which saturated all 22 cores of
the Precision 5490 (ksg_robustness.R hardcodes detectCores()-1 = 21 mclapply
workers per job).

This trial OFFLOADS that primitive to the NVIDIA RTX 3000 Ada GPU via numba.cuda
(a zero-install path: numba + the CUDA 12.4 toolkit are already present) and holds
it to the engine's reproduce-integrity bar: the GPU result must equal a CPU
reference EXACTLY (FP64, IEEE-deterministic), not approximately. It also estimates
TE in both directions on a known coupled system (X drives Y) as a sanity check on
the estimator, and measures GPU-vs-CPU wall time.

Bounded by construction: n ~ 3000 points, a few MB of VRAM, the CPU reference is
thread-pinned, and nothing here touches the R engine or its job server. Safe to
run on an idle box; it cannot reproduce the 22-core hang.

  usage: OPENBLAS_NUM_THREADS=1 python3 ksg_te_gpu_trial.py [--n 3000] [--json out.json]
"""
import os
# Pin BLAS/threading BEFORE importing numpy so the CPU reference cannot itself
# fan out across cores (the trial must never be a CPU hog).
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_v, "1")

import sys
import json
import time
import argparse
import numpy as np
from scipy.special import digamma

K = 4  # k-th nearest neighbour; matches the engine's ksg_te default (k=4, lag=1)


# ----------------------------------------------------------------------------- data
def coupled_system(n, seed=42):
    """A linear system in which X Granger-/information-drives Y, and not the
    reverse, so TE(X->Y) must exceed TE(Y->X). Deterministic for a fixed seed."""
    rng = np.random.default_rng(seed)
    burn = 200
    N = n + burn + 2
    ex = rng.standard_normal(N)
    ey = rng.standard_normal(N)
    x = np.zeros(N)
    y = np.zeros(N)
    for t in range(1, N):
        x[t] = 0.70 * x[t - 1] + ex[t]
        y[t] = 0.50 * y[t - 1] + 0.60 * x[t - 1] + 0.5 * ey[t]   # X_{t-1} -> Y_t
    return x[burn:], y[burn:]


def zscore(v):
    return (v - v.mean()) / v.std(ddof=0)


def embed_cmi(source, target, n):
    """Build the three coordinate axes of the conditional-MI used for TE
    (Frenzel-Pompe): A = target future, B = source past, C = target past.
    Each standardised. Returns A, B, C of length n (lag/embedding = 1)."""
    A = zscore(target[1:n + 1])     # target_{t+1}
    B = zscore(source[0:n])         # source_t   (the conditioning-out source)
    C = zscore(target[0:n])         # target_t
    return A, B, C


# ------------------------------------------------------------------------- CPU ref
def cpu_eps_counts(A, B, C):
    """Exact CPU reference. eps[i] = max-norm distance to the K-th neighbour of i
    in the joint (A,B,C) space (self excluded); then strict-'<' neighbour counts
    in the C, (B,C) and (A,C) sub-spaces. Pure FP64, no randomness."""
    DA = np.abs(A[:, None] - A[None, :])
    DB = np.abs(B[:, None] - B[None, :])
    DC = np.abs(C[:, None] - C[None, :])
    np.fill_diagonal(DA, np.inf)
    np.fill_diagonal(DB, np.inf)
    np.fill_diagonal(DC, np.inf)
    D = np.maximum(np.maximum(DA, DB), DC)        # joint max-norm, self = inf
    eps = np.partition(D, K - 1, axis=1)[:, K - 1]  # K-th smallest per row
    e = eps[:, None]
    n_z = np.sum(DC < e, axis=1)                   # C sub-space
    n_xz = np.sum(np.maximum(DB, DC) < e, axis=1)  # (B,C) sub-space
    n_yz = np.sum(np.maximum(DA, DC) < e, axis=1)  # (A,C) sub-space
    return eps, n_z.astype(np.int64), n_xz.astype(np.int64), n_yz.astype(np.int64)


# ------------------------------------------------------------------------- GPU path
from numba import cuda  # noqa: E402


@cuda.jit
def _eps_kernel(A, B, C, eps):
    i = cuda.grid(1)
    n = A.size
    if i >= n:
        return
    kd = cuda.local.array(K, np.float64)     # the K smallest distances seen, ascending
    for t in range(K):
        kd[t] = 1.0e308
    ai = A[i]; bi = B[i]; ci = C[i]
    for j in range(n):
        if j == i:
            continue
        da = abs(A[j] - ai); db = abs(B[j] - bi); dc = abs(C[j] - ci)
        d = da
        if db > d:
            d = db
        if dc > d:
            d = dc
        if d < kd[K - 1]:                     # insertion-sort into the K-smallest buffer
            p = K - 1
            while p > 0 and kd[p - 1] > d:
                kd[p] = kd[p - 1]
                p -= 1
            kd[p] = d
    eps[i] = kd[K - 1]                        # K-th smallest = the KSG radius


@cuda.jit
def _count_kernel(A, B, C, eps, n_z, n_xz, n_yz):
    i = cuda.grid(1)
    n = A.size
    if i >= n:
        return
    ai = A[i]; bi = B[i]; ci = C[i]; e = eps[i]
    cz = 0; cxz = 0; cyz = 0
    for j in range(n):
        if j == i:
            continue
        da = abs(A[j] - ai); db = abs(B[j] - bi); dc = abs(C[j] - ci)
        if dc < e:
            cz += 1
        mxz = db if db > dc else dc
        if mxz < e:
            cxz += 1
        myz = da if da > dc else dc
        if myz < e:
            cyz += 1
    n_z[i] = cz; n_xz[i] = cxz; n_yz[i] = cyz


def gpu_eps_counts(A, B, C):
    n = A.size
    dA = cuda.to_device(A); dB = cuda.to_device(B); dC = cuda.to_device(C)
    d_eps = cuda.device_array(n, np.float64)
    d_nz = cuda.device_array(n, np.int64)
    d_nxz = cuda.device_array(n, np.int64)
    d_nyz = cuda.device_array(n, np.int64)
    tpb = 128
    bpg = (n + tpb - 1) // tpb
    _eps_kernel[bpg, tpb](dA, dB, dC, d_eps)
    _count_kernel[bpg, tpb](dA, dB, dC, d_eps, d_nz, d_nxz, d_nyz)
    cuda.synchronize()
    return (d_eps.copy_to_host(), d_nz.copy_to_host(),
            d_nxz.copy_to_host(), d_nyz.copy_to_host())


# ------------------------------------------------------------------------- estimator
def te_from_counts(n_z, n_xz, n_yz):
    """Frenzel-Pompe KSG conditional-MI estimate:
       TE = psi(K) + < psi(n_z+1) - psi(n_xz+1) - psi(n_yz+1) >."""
    return float(digamma(K) + np.mean(
        digamma(n_z + 1) - digamma(n_xz + 1) - digamma(n_yz + 1)))


def te_direction(source, target, n):
    A, B, C = embed_cmi(source, target, n)
    return A, B, C


# ------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3000, help="points used (bounded)")
    ap.add_argument("--json", type=str, default=None, help="write result JSON here")
    args = ap.parse_args()
    n = int(args.n)

    if not cuda.is_available():
        print("FATAL: no CUDA device visible to numba", file=sys.stderr)
        sys.exit(2)
    dev = cuda.get_current_device()

    x, y = coupled_system(n + 4)
    # X -> Y direction (this is the one we cross-check GPU vs CPU on)
    A, B, C = te_direction(x, y, n)

    # warm up the JIT so the timing measures compute, not compilation
    _ = gpu_eps_counts(A[:64].copy(), B[:64].copy(), C[:64].copy())

    t0 = time.perf_counter()
    g_eps, g_nz, g_nxz, g_nyz = gpu_eps_counts(A, B, C)
    gpu_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    c_eps, c_nz, c_nxz, c_nyz = cpu_eps_counts(A, B, C)
    cpu_s = time.perf_counter() - t0

    # ---- the integrity bar: GPU must EQUAL the CPU reference, not approximate it
    eps_max_abs = float(np.max(np.abs(g_eps - c_eps)))
    nz_mismatch = int(np.sum(g_nz != c_nz))
    nxz_mismatch = int(np.sum(g_nxz != c_nxz))
    nyz_mismatch = int(np.sum(g_nyz != c_nyz))
    exact = (eps_max_abs == 0.0 and nz_mismatch == 0
             and nxz_mismatch == 0 and nyz_mismatch == 0)

    te_xy = te_from_counts(g_nz, g_nxz, g_nyz)

    # Y -> X direction (sanity: must be far weaker on this X-drives-Y system)
    A2, B2, C2 = te_direction(y, x, n)
    g2 = gpu_eps_counts(A2, B2, C2)
    te_yx = te_from_counts(g2[1], g2[2], g2[3])

    free, total = cuda.current_context().get_memory_info()
    result = {
        "trial": "ksg_te_gpu",
        "estimator": "Frenzel-Pompe max-norm KSG conditional-MI (TE), k=%d, lag=1" % K,
        "n_points": n,
        "device": dev.name.decode() if isinstance(dev.name, bytes) else str(dev.name),
        "compute_capability": "%d.%d" % dev.compute_capability,
        "vram_used_mib": round((total - free) / 1048576, 1),
        "gpu_equals_cpu_exact": bool(exact),
        "eps_max_abs_diff": eps_max_abs,
        "count_mismatches": {"n_z": nz_mismatch, "n_xz": nxz_mismatch, "n_yz": nyz_mismatch},
        "te_x_to_y": round(te_xy, 6),
        "te_y_to_x": round(te_yx, 6),
        "direction_correct": bool(te_xy > te_yx),
        "gpu_seconds": round(gpu_s, 4),
        "cpu_seconds": round(cpu_s, 4),
        "speedup_cpu_over_gpu": round(cpu_s / gpu_s, 2) if gpu_s > 0 else None,
        "precision": "float64 (IEEE-deterministic; FP64:FP32 perf ratio 1:64 on Ada laptop)",
    }

    print(json.dumps(result, indent=2))
    print("\nVERDICT:",
          "GPU==CPU EXACT" if exact else "!! GPU != CPU (investigate before trusting the offload)",
          "| direction", "OK" if result["direction_correct"] else "WRONG",
          "| GPU %.3fs vs CPU %.3fs" % (gpu_s, cpu_s))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=2)
        print("wrote", args.json)
    sys.exit(0 if (exact and result["direction_correct"]) else 1)


if __name__ == "__main__":
    main()
