#!/usr/bin/env python3
"""
ksg_gpu.py -- GPU offload of the engine's KSG / Frenzel-Pompe transfer-entropy
search, callable from the R methods (ksg_te.R, ksg_robustness.R) with a CPU
fallback. This is the production sibling of gpu/ksg_te_gpu_trial.py (which proved
the primitive bit-exact); here the same two numba.cuda kernels carry the O(n^2)
neighbour search for MANY directed pairs in ONE process (one CUDA context), so the
load that saturated all 22 CPU cores of the Precision 5490 moves onto the
NVIDIA RTX 3000 Ada GPU instead.

Contract with r/_ksg_core.R (the estimator this MUST reproduce):
  TE(src -> dst) = I( dst_{t+1} ; src_t^(lag) | dst_t^(lag) )   [Schreiber 2000]
                 = psi(k) + < psi(n_z+1) - psi(n_xz+1) - psi(n_yz+1) >  [Frenzel-Pompe]
  * RAW coordinates (the engine does NOT z-score -- G20 series are already
    daily log-returns; max-norm is not scale-invariant, so this matters).
  * eps_i = max-norm distance to the k-th neighbour of point i in the joint
    (dst_{t+1}, src_t^(lag), dst_t^(lag)) space, self excluded.
  * n_z / n_xz / n_yz = points with marginal max-norm distance STRICTLY < eps_i
    in the Z=dst-past, XZ=(future,dst-past), YZ=(src-past,dst-past) sub-spaces.
The observed TE is deterministic and is the only quantity the eval suite gates
(ksg_te: USA->Japan TE in band; ksg_robustness: TE rankings across the grid) --
so it is held bit-exact to the engine's 6-dp emit. Significance uses IAAFT source
surrogates (Schreiber & Schmitz 1996); the engine seeds NEITHER ksg method, so the
surrogate p-value is a non-reproducible draw in both paths and this helper's
independent IAAFT is statistically equivalent (documented, never claimed exact).

Modes:
  ksg_gpu.py --probe                 -> {"cuda": bool, ...}; exit 0 if a CUDA
                                        device is usable, 2 otherwise.
  ksg_gpu.py --spec S --bin B --out O -> read returns matrix (raw float64,
                                        column-major, from R writeBin) + spec JSON
                                        {n,kk,k,lag,B,pairs,seed}; write results
                                        JSON {ok,compute_path,pairs:[{i,j,te,ge,p}]}.
On any failure it exits non-zero with a JSON error on stdout; the R caller then
runs its governed CPU mclapply path, so a missing/broken GPU never breaks a run.
"""
import os
# Pin BLAS/threading BEFORE numpy so the host side can never fan out across cores.
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_v, "1")

import sys
import json
import time
import argparse
import numpy as np

KMAX = 32  # max k supported by the per-thread local buffer (KSG k is small, <=8)


def _die(msg, code=2):
    """Emit a single JSON error object on stdout and exit non-zero (the R caller
    treats any non-zero exit / missing --out as 'no GPU' and falls back to CPU)."""
    sys.stdout.write(json.dumps({"ok": False, "error": str(msg)}))
    sys.stdout.flush()
    sys.exit(code)


# --------------------------------------------------------------------------- CUDA
def _import_cuda():
    try:
        from numba import cuda
        if not cuda.is_available():
            return None, "no CUDA device visible to numba"
        return cuda, None
    except Exception as e:                       # numba/driver/toolkit absent
        return None, "numba.cuda import failed: %s" % e


def _build_kernels(cuda):
    """Two kernels over a BATCH of searches M3 (S x m x d): S independent searches
    (one observed TE + B surrogates of a pair), each an m-point joint split into
    [X (dx cols) | Y (dy cols) | Z (dz cols)] = [future | src-past | dst-past]. One
    thread per (search s, point i), so a whole pair's B+1 O(m^2) searches run in ONE
    launch -- amortising the numba launch + host<->device transfer overhead that
    dominates when launching per search. Arithmetic is bit-identical to the FP64 CPU
    reference (abs/subtract/max are exact IEEE ops; the k-th order statistic of an
    identical multiset and strict-'<' integer counts are identical)."""

    @cuda.jit
    def eps_kernel(M3, dx, dy, dz, k, eps2):
        tid = cuda.grid(1)
        S = M3.shape[0]; m = M3.shape[1]
        if tid >= S * m:
            return
        s = tid // m; i = tid % m
        d = dx + dy + dz
        kd = cuda.local.array(KMAX, np.float64)        # k smallest joint distances
        for t in range(k):
            kd[t] = 1.0e308
        for j in range(m):
            if j == i:
                continue
            dmax = 0.0                                 # joint = max over ALL columns
            for c in range(d):
                v = M3[s, i, c] - M3[s, j, c]
                if v < 0.0:
                    v = -v
                if v > dmax:
                    dmax = v
            if dmax < kd[k - 1]:                        # insertion into k-smallest
                p = k - 1
                while p > 0 and kd[p - 1] > dmax:
                    kd[p] = kd[p - 1]
                    p -= 1
                kd[p] = dmax
        eps2[s, i] = kd[k - 1]

    @cuda.jit
    def count_kernel(M3, dx, dy, dz, eps2, nz2, nxz2, nyz2):
        tid = cuda.grid(1)
        S = M3.shape[0]; m = M3.shape[1]
        if tid >= S * m:
            return
        s = tid // m; i = tid % m
        z0 = dx + dy                                   # Z columns: [z0, z0+dz)
        e = eps2[s, i]
        cz = 0
        cxz = 0
        cyz = 0
        for j in range(m):
            if j == i:
                continue
            # Z sub-space (dst-past): max over columns [z0, z0+dz)
            mz = 0.0
            for c in range(z0, z0 + dz):
                v = M3[s, i, c] - M3[s, j, c]
                if v < 0.0:
                    v = -v
                if v > mz:
                    mz = v
            if mz < e:
                cz += 1
            # XZ sub-space (future + dst-past): X cols [0,dx) then Z cols
            mxz = mz
            for c in range(0, dx):
                v = M3[s, i, c] - M3[s, j, c]
                if v < 0.0:
                    v = -v
                if v > mxz:
                    mxz = v
            if mxz < e:
                cxz += 1
            # YZ sub-space (src-past + dst-past): Y cols [dx,dx+dy) then Z cols
            myz = mz
            for c in range(dx, dx + dy):
                v = M3[s, i, c] - M3[s, j, c]
                if v < 0.0:
                    v = -v
                if v > myz:
                    myz = v
            if myz < e:
                cyz += 1
        nz2[s, i] = cz
        nxz2[s, i] = cxz
        nyz2[s, i] = cyz

    return eps_kernel, count_kernel


# --------------------------------------------------------------------- estimator
def _embed_te(src, dst, lag):
    """Replicates r/_ksg_core.R .embed_lags + .te alignment, RAW (no z-score).
    Returns the joint matrix M = [future | src-past(lag) | dst-past(lag)] of
    shape (m, 1+2*lag) with m = n-lag, and the group sizes (dx=1, dy=lag, dz=lag)."""
    n = src.shape[0]
    m = n - lag
    if m < 1:
        raise ValueError("series too short for lag=%d" % lag)
    fut = dst[lag:lag + m].reshape(m, 1)               # dst_{t+1}
    spast = np.empty((m, lag), dtype=np.float64)
    dpast = np.empty((m, lag), dtype=np.float64)
    for d in range(lag):                               # column d = v[(lag-1-d):...]
        s = lag - 1 - d
        spast[:, d] = src[s:s + m]
        dpast[:, d] = dst[s:s + m]
    M = np.concatenate([fut, spast, dpast], axis=1)
    return np.ascontiguousarray(M), 1, lag, lag


def _eps_counts_gpu_batch(cuda, eps_kernel, count_kernel, M3, dx, dy, dz, k):
    """eps + the three strict-'<' counts for a BATCH of S searches M3 (S x m x d),
    one GPU launch each (host arrays (S, m) back)."""
    S, m = M3.shape[0], M3.shape[1]
    dM = cuda.to_device(np.ascontiguousarray(M3))
    d_eps = cuda.device_array((S, m), np.float64)
    d_nz = cuda.device_array((S, m), np.int64)
    d_nxz = cuda.device_array((S, m), np.int64)
    d_nyz = cuda.device_array((S, m), np.int64)
    tpb = 128
    bpg = (S * m + tpb - 1) // tpb
    eps_kernel[bpg, tpb](dM, dx, dy, dz, k, d_eps)
    count_kernel[bpg, tpb](dM, dx, dy, dz, d_eps, d_nz, d_nxz, d_nyz)
    cuda.synchronize()
    return (d_eps.copy_to_host(), d_nz.copy_to_host(),
            d_nxz.copy_to_host(), d_nyz.copy_to_host())


def _count_1d_engine_batch(v, eps2, sv=None):
    """Exact host replica of r/_ksg_core.R .count_1d for the 1-column Z sub-space
    (the dst-past count when lag==1), vectorised over S searches. The Z column v is
    SHARED across a pair's searches (dst-past is fixed); only eps2 (S x m) varies.
    The engine tests membership against (v-eps)/(v+eps-1e-12) via findInterval, which
    differs from the GPU's |dp-v|<eps abs-form on the rare boundary tie where |dp-v|
    rounds to exactly eps but v-eps rounds down -- the engine INCLUDES that point. We
    match it bit-for-bit so the published TE (the eval anchor) is preserved exactly.
    R findInterval(x, sv) (right-open) == np.searchsorted(sv, x, side='right')."""
    if sv is None:
        sv = np.sort(v)
    vb = v[None, :]                                    # (1, m), broadcast over S
    hi = np.searchsorted(sv, (vb + eps2 - 1e-12).ravel(), side="right").reshape(eps2.shape)
    lo = np.searchsorted(sv, (vb - eps2).ravel(), side="right").reshape(eps2.shape)
    return np.maximum(hi - lo - 1, 0).astype(np.int64)


def _te_values_batch(M3, dx, dy, dz, eps2, nz2, nxz2, nyz2, k, digamma, sv_z=None):
    """Frenzel-Pompe KSG CMI reduction for all S searches (R's digamma-equivalent),
    returning a length-S vector of TE values. The 1-D Z count uses the engine-faithful
    host path when dz==1 (Z column shared across searches -> taken from M3[0])."""
    if dz == 1:
        nz2 = _count_1d_engine_batch(M3[0, :, dx + dy], eps2, sv_z)
    contrib = digamma(nz2 + 1) - digamma(nxz2 + 1) - digamma(nyz2 + 1)   # (S, m)
    return (digamma(k) + contrib.mean(axis=1)).astype(np.float64)        # (S,)


def _iaaft_batch(x, rng, B, n_iter=100):
    """B IAAFT surrogates (Schreiber & Schmitz 1996) at once -- the numpy mirror of
    r/_ksg_core.R .iaaft, vectorised over the B surrogates because the per-surrogate
    FFT loop is the engine's real transfer-entropy bottleneck (38 ms x B x pairs on
    the host, dwarfing the GPU search). Each row alternately imposes x's amplitude
    spectrum and x's empirical amplitude distribution until the rank order stabilises;
    R's fft(.,inverse=TRUE)/n == numpy ifft (already 1/n-normalised). Once a row's
    rank order is fixed it is a fixed point (s=sx[r] -> same S -> same r), so iterating
    to a global stop is identical to per-row early-breaking. Ordinal ranks via a stable
    double-argsort == R rank(ties.method='first'). The engine seeds NEITHER ksg method,
    so this independent draw is statistically equivalent, never claimed bit-identical."""
    n = x.shape[0]
    sx = np.sort(x)
    amp = np.abs(np.fft.fft(x))[None, :]               # x's amplitude spectrum (shared)
    s = np.empty((B, n), dtype=np.float64)
    for b in range(B):
        s[b] = x[rng.permutation(n)]                   # independent random starts
    prev = None
    for _ in range(n_iter):
        S = np.fft.fft(s, axis=1)
        ph = S / np.maximum(np.abs(S), 1e-12)
        s2 = np.real(np.fft.ifft(amp * ph, axis=1))    # impose spectrum
        r = np.argsort(np.argsort(s2, axis=1, kind="stable"), axis=1)  # 0-based ordinal
        s = sx[r]                                       # impose amplitude distribution
        if prev is not None and np.array_equal(r, prev):
            break
        prev = r
    return s


# -------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true",
                    help="print CUDA availability JSON; exit 0 if usable else 2")
    ap.add_argument("--spec", type=str, help="path to the JSON spec")
    ap.add_argument("--bin", type=str, help="path to the raw float64 returns matrix")
    ap.add_argument("--out", type=str, help="path to write the results JSON")
    args = ap.parse_args()

    cuda, err = _import_cuda()

    if args.probe:
        info = {"cuda": cuda is not None}
        if cuda is not None:
            try:
                dev = cuda.get_current_device()
                info["device"] = (dev.name.decode() if isinstance(dev.name, bytes)
                                  else str(dev.name))
                info["compute_capability"] = "%d.%d" % dev.compute_capability
            except Exception as e:
                info = {"cuda": False, "error": "device query failed: %s" % e}
                sys.stdout.write(json.dumps(info)); sys.exit(2)
        else:
            info["error"] = err
        sys.stdout.write(json.dumps(info))
        sys.exit(0 if info.get("cuda") else 2)

    if not (args.spec and args.bin and args.out):
        _die("need --probe or all of --spec/--bin/--out")
    if cuda is None:
        _die("no usable CUDA device: %s" % err)

    try:
        from scipy.special import digamma
    except Exception as e:
        _die("scipy unavailable: %s" % e)

    try:
        with open(args.spec) as f:
            spec = json.load(f)
        n = int(spec["n"]); kk = int(spec["kk"])
        k = int(spec["k"]); lag = int(spec["lag"]); B = int(spec["B"])
        pairs = [(int(a), int(b)) for a, b in spec["pairs"]]
        seed = int(spec.get("seed", 0))
    except Exception as e:
        _die("bad spec: %s" % e)
    if k < 1 or k > KMAX:
        _die("k=%d out of supported range [1,%d]" % (k, KMAX))

    try:
        flat = np.fromfile(args.bin, dtype=np.float64)
        if flat.size != n * kk:
            _die("bin size %d != n*kk %d" % (flat.size, n * kk))
        R = flat.reshape((kk, n)).T                    # column-major from R writeBin
        R = np.ascontiguousarray(R, dtype=np.float64)
    except SystemExit:
        raise
    except Exception as e:
        _die("bad bin: %s" % e)

    try:
        eps_kernel, count_kernel = _build_kernels(cuda)
        # warm the JIT on a tiny array so the first real pair is not paying compile
        _warm, dx, dy, dz = _embed_te(R[:, 0][:64], R[:, 0][:64], lag)
        _w3 = _warm[None, :, :]
        _we, _wz, _wxz, _wyz = _eps_counts_gpu_batch(cuda, eps_kernel, count_kernel,
                                                     _w3, dx, dy, dz, k)
        _ = _te_values_batch(_w3, dx, dy, dz, _we, _wz, _wxz, _wyz, k, digamma)
    except Exception as e:
        _die("kernel build/warmup failed: %s" % e)

    rng = np.random.default_rng(seed if seed else None)
    t0 = time.perf_counter()
    out_pairs = []
    try:
        for (i, j) in pairs:
            src = R[:, i]; dst = R[:, j]
            M, dx, dy, dz = _embed_te(src, dst, lag)
            m, dcol = M.shape
            sv_z = np.sort(M[:, dx + dy]) if dz == 1 else None   # dst-past, fixed per pair
            # Build the search batch: row 0 = observed; rows 1..B = surrogates. Only
            # the src-past columns [1, 1+lag) change (future + dst-past are fixed).
            if B > 0:
                surr = _iaaft_batch(src, rng, B)                 # (B, n), batched FFT
                M3 = np.broadcast_to(M, (B + 1, m, dcol)).copy()
                for b in range(B):
                    ss = surr[b]
                    for d in range(lag):
                        M3[b + 1, :, 1 + d] = ss[(lag - 1 - d):(lag - 1 - d) + m]
            else:
                M3 = M[None, :, :]
            eps2, nz2, nxz2, nyz2 = _eps_counts_gpu_batch(cuda, eps_kernel, count_kernel,
                                                          M3, dx, dy, dz, k)
            te = _te_values_batch(M3, dx, dy, dz, eps2, nz2, nxz2, nyz2, k, digamma, sv_z)
            te_obs = float(te[0])
            ge = int(np.sum(te[1:] >= te_obs)) if B > 0 else 0
            p = (1 + ge) / (B + 1)
            out_pairs.append({"i": i, "j": j, "te": te_obs, "ge": ge, "p": p})
    except Exception as e:
        _die("compute failed on pair: %s" % e)
    secs = time.perf_counter() - t0

    try:
        dev = cuda.get_current_device()
        free, total = cuda.current_context().get_memory_info()
        dev_name = dev.name.decode() if isinstance(dev.name, bytes) else str(dev.name)
        cc = "%d.%d" % dev.compute_capability
        vram = round((total - free) / 1048576, 1)
    except Exception:
        dev_name, cc, vram = "unknown", "?", None

    result = {
        "ok": True,
        "compute_path": "gpu",
        "device": dev_name,
        "compute_capability": cc,
        "vram_mib": vram,
        "n_obs": int(R.shape[0] - lag),
        "k": k, "lag": lag, "B": B,
        "seconds": round(secs, 3),
        "surrogate_engine": "numpy-iaaft (method unseeded in the engine; p-values "
                            "non-reproducible in both CPU and GPU paths)",
        "pairs": out_pairs,
    }
    with open(args.out, "w") as f:
        json.dump(result, f)
    sys.stdout.write(json.dumps({"ok": True, "n_pairs": len(out_pairs),
                                 "seconds": result["seconds"]}))
    sys.exit(0)


if __name__ == "__main__":
    main()
