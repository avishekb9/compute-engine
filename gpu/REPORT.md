# GPU offload of the KSG transfer-entropy bottleneck — feasibility trial

**Author:** Avishek Bhandari (SHSSM, IIT Bhubaneswar) · **Date:** 2026-06-13 · **Worker:** `ecolex-Precision-5490`

## Abstract

The engine's transfer-entropy methods (`ksg_te`, `ksg_robustness`) spend their time
in an O(n²) k-nearest-neighbour search under the max-norm — the Kraskov–Stoegbauer–
Grassberger / Frenzel–Pompe estimator. On the Precision 5490 this work saturated all
22 logical cores and hung the machine (root cause in §4). This trial moves that exact
primitive onto the laptop's **NVIDIA RTX 3000 Ada** GPU via `numba.cuda` — a path that
needs no new installation — and holds it to the engine's reproduce-integrity bar: the
GPU result must **equal** a CPU reference exactly, not approximately. It does, at every
size tested, while running **32–74× faster** and freeing the CPU entirely. A separate,
verified change removes the saturation at its source so the CPU path is also safe.

## 1. Method

We estimate transfer entropy in the Frenzel–Pompe conditional-mutual-information form,
`TE(X→Y) = ψ(k) + ⟨ψ(n_z+1) − ψ(n_xz+1) − ψ(n_yz+1)⟩`, with `k = 4` and embedding 1
(the engine's `ksg_te` defaults). For each point the GPU computes `ε_i`, the max-norm
distance to its k-th neighbour in the joint `(Y_{t+1}, X_t, Y_t)` space, then the
strict-`<` neighbour counts in the `Y_t`, `(X_t,Y_t)` and `(Y_{t+1},Y_t)` sub-spaces.
Two `numba.cuda` kernels (one per point, K-smallest insertion for `ε_i`; one for the
three counts) carry the whole O(n²) load; the cheap `ψ`-sum is done on the host.

Data is a deterministic linear system in which X drives Y
(`y_t = 0.5 y_{t-1} + 0.6 x_{t-1} + ½εy`), so `TE(X→Y)` must dominate `TE(Y→X)`.

- **Hardware:** NVIDIA RTX 3000 Ada Generation Laptop GPU, compute capability 8.9, 8 GB.
- **Stack:** numba 0.63.1, CUDA toolkit 12.4, driver 580.159.04. No PyTorch/CuPy needed.
- **Reproduce:** `OPENBLAS_NUM_THREADS=1 python3 gpu/ksg_te_gpu_trial.py --n 3000 --json out.json`

## 2. Results

| n | GPU≡CPU exact | max&#124;ε_gpu−ε_cpu&#124; | count mismatches | TE(X→Y) | TE(Y→X) | GPU | CPU | speed-up |
|---|---|---|---|---|---|---|---|---|
| 2000 | **yes** | 0.0 | 0 | 0.5395 | 0.0130 | 3 ms | 0.10 s | 32× |
| 3000 | **yes** | 0.0 | 0 | 0.5182 | 0.0018 | 4 ms | 0.31 s | **74×** |
| 5000 | **yes** | 0.0 | 0 | 0.5261 | 0.0056 | 11 ms | 0.81 s | 73× |

VRAM at n=3000: **151 MiB** of 7807. Every run recovers the correct direction
(`TE(X→Y) ≫ TE(Y→X)`), confirming the estimator is wired correctly, not merely fast.

## 3. Verification (the integrity bar)

The claim is **not** "the GPU is fast"; it is "the GPU is *exactly* the CPU and fast".
The trial computes an independent FP64 NumPy reference for `ε_i` and all three counts
and asserts agreement. At n = 2000, 3000 and 5000 the maximum absolute `ε` difference
is `0.0` and there are **zero** count mismatches in any sub-space — bit-exact, because
max-norm distances are IEEE-deterministic and identical on host and device. A non-exact
result would fail the script (non-zero exit), exactly as an engine eval row would. This
is FP64; the Ada laptop's FP32 path is 64× faster again but is left for later because
exactness, not peak throughput, is the bar that matters for a published estimator.

## 4. The CPU saturation, fixed at the source

`ksg_robustness.R` (and `ksg_te.R`, `sri_daily.R`) hard-coded
`ncores <- detectCores() - 1L` = **21** `mclapply` workers, ignoring the job's
`n_cores`. With the job server running two jobs at once and BLAS left multi-threaded,
two `ksg_robustness` jobs forked 2 × 21 = 42 workers, each able to spawn further BLAS
threads — the multiplicative oversubscription that pinned 22 cores at 100% and hung the
box (the reboot left two `ksg_robustness` records in `running`).

Fixed (verified, determinism-safe — worker count never changes a TE number):

- **`r/_io.R`** gains `ce_ncores(p, reserve)`: base `detectCores()-reserve`, overridden
  by an explicit `n_cores`, then **clamped by a hard `CE_MAX_CORES` ceiling**. All six
  `mclapply` sites now call it.
- **`server/job-server.mjs`** sets `CE_MAX_CORES = floor((cpus−2)/MAX_CONCURRENT)` (=10
  here) and pins `OPENBLAS/OMP/MKL/VECLIB/NUMEXPR` threads to 1 for every R spawn; the
  budget is surfaced in `/health` and the startup log.

Two concurrent jobs therefore use ≤ 20 cores, never 42; a job asking for 21 under a
ceiling of 4 is forced to 4 (verified end-to-end through `mclapply`). Pinning BLAS also
removes a source of non-deterministic floating-point reduction order — a reproducibility
gain on top of the safety one.

## 5. Reading and next steps

The KSG neighbour search — the engine's heaviest, most-parallel, and previously most
dangerous CPU load — runs bit-exactly on the GPU in single-digit milliseconds and frees
all CPU cores for other jobs. The two changes are complementary: the core-governance fix
makes the **CPU** path safe today; the GPU kernel offers an **offload** path that removes
the load from the CPU altogether. Natural next steps, in order of value: (i) wire
`ksg_te`/`ksg_robustness` to dispatch the neighbour search to the GPU kernel when a CUDA
device is present, falling back to the governed CPU path otherwise; (ii) register this
trial as a failable eval row (it already exits non-zero on any GPU≠CPU divergence);
(iii) extend the kernel to the IAAFT surrogate inner loop (the other O(n²·B) cost).

> Integrity: every number above is emitted by `gpu/ksg_te_gpu_trial.py` and stored in
> `gpu/ksg_te_gpu_trial.result.json`; nothing here is hand-entered.
