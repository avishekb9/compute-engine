# R Runner Progress Protocol (Tier A)

Long-running R method runners report progress so the async worker can forward it as
SSE and persist it to the job record. The protocol is line-based on **stdout** and is
backward compatible: methods that emit no progress lines simply show indeterminate
status until the final result.

## Contract

A runner's stdout is a stream of newline-delimited JSON objects. Exactly one of them is
the **final result** (the existing `/api/compute/run` JSON contract). Any number of
**progress** objects may precede it. The two are distinguished by a reserved key.

### Progress line
```json
{"__progress__": true, "fraction": 0.34, "stage": "window_18_of_52", "elapsed_s": 142}
```
- `__progress__` (required, literal `true`) — marks the line as progress, not result.
- `fraction` (0..1) — best-effort completion estimate; omit if unknown.
- `stage` (string) — short human-readable step label.
- `elapsed_s` (number) — seconds since the runner started.

### Final result line
The existing contract, unchanged (no `__progress__` key):
```json
{"method": "ksg_te_panel", "result": { ... }, "provenance": { ... }}
```

## Worker behaviour
1. Read stdout line by line.
2. A line parsed as JSON with `__progress__ === true` → update the job record's
   `progress` and emit an SSE `progress` event. Never persisted as the result.
3. The first JSON line **without** `__progress__` → the final result; persist it,
   mark the job `succeeded`, emit SSE `done`.
4. Non-JSON stdout lines are logged (debug) and ignored for the result contract.
5. Non-zero exit / `timeout` (124) → job `failed` with a coded error; SSE `error`.

## R helper (to be added to r/_io.R)
```r
emit_progress <- function(fraction = NA, stage = "", elapsed_s = NA) {
  cat(jsonlite::toJSON(list(`__progress__` = TRUE, fraction = fraction,
                            stage = stage, elapsed_s = elapsed_s),
                       auto_unbox = TRUE, na = "null"), "\n", sep = "")
  flush(stdout())
}
```
Usage inside a rolling/bootstrap loop:
```r
for (i in seq_len(W)) {
  # ... compute window i ...
  emit_progress(i / W, sprintf("window_%d_of_%d", i, W), as.numeric(Sys.time() - t0))
}
```

## Notes
- `flush(stdout())` is mandatory so the worker sees progress in real time rather than
  buffered at process exit.
- Progress is advisory; correctness never depends on it. A method may be made
  `long_running: true` in the catalog without emitting any progress (it then shows an
  indeterminate running state).
