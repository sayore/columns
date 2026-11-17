# columns

**Zero-Dependency AVX2/AVX-512 SIMD Structure-of-Arrays (SoA) Column Store for Bun + Rust.**

Built for high-frequency numeric filtering, tick-based batch math (`FMA`), and deterministic `u32` ID refinement without ORM overhead or GC pauses.

---

## Selling Points & Key Statistics

* **Zero Dependencies:** `0` external Rust crates (`std` + variadic `libc` syscalls) and `0` npm dependencies (`bun:ffi` + `node:fs`).
* **Cache-Line SoA Layout:** **`4.0 MB`** per `f32` column for **1,000,000 entities**, directly indexed by `entity_id: u32` for auto-vectorized AVX2/AVX-512 loops.
* **~6B – 9B Entities/sec Batch Math:** `transformAll` (`col[i] = col[i] * mul + add`) processes **1,000,000 `f32` entities in `107 – 168 µs`**.
* **Bitset-Accelerated Full Scans:** **`1.04 – 1.09 ms`** `filterRange` across **1,000,000 entities** (`250,000` hits), skipping empty 32-entity blocks in 1 cycle via `trailing_zeros` (`TZCNT`/`BLSR`).
* **Sub-Microsecond Candidate Refinement:** `refineIds` filters `Uint32Array` slices from external engines (`nerve` / `spatial`) with zero allocations; combined `nerve + columns` queries run in **`36.47 µs`** (100k entities).
* **Atomic Persistence:** `StrictAcid` mode persists columns and `_active_bits.bin` via temp-file + `fsync` + POSIX `rename`.

---

## Benchmarks (1,000,000 `f32` Entities, Linux x86_64)

| Operation | Dataset | Latency | Notes |
| :--- | :--- | ---: | :--- |
| `transformAll` (`col[i] = col[i] * a + b`) | 1,000,000 entities | `107 – 168 µs` | SIMD FMA pass |
| `filterRange` (`min <= col[i] <= max`) | 1,000,000 entities (250k hits) | `1040 – 1094 µs` | Bitset-accelerated full scan |
| `sumActive` (`sum` + `count`) | 1,000,000 active entities | single pass | `f64` accumulator |
| Hybrid Query (`nerve` + `columns`) | 100,000 entities (1k runs) | `36.47 µs` | ~27,400 hybrid queries/sec |

*Suite: `bun run test` (`5/5` passing: `sumActive`, `filterRange`, `transformAll`, `StrictAcid` persistence & reload, `nerve + columns` integration).*

---

## Quickstart

```bash
bun run build:native
bun run test
```

```ts
import { ColumnStore, ColMode } from "./packages/columns-bun/src/index";

const cols = new ColumnStore(
  "./crates/columns-core/target/release/libcolumns_core.so",
  "db/cols",
  1_000_000
);
cols.setMode(ColMode.StrictAcid);

cols.set("hp", 42, 35.0);
cols.set("hp", 99, 120.0);

// SIMD fused multiply-add across all 1M entities
cols.transformAll("hp", 1.0, 10.0);

// Range query skipping inactive 32-entity bitset blocks
const wounded = cols.filterRange("hp", 1.0, 50.0);

// Sum + count across all active entities
const { sum, count } = cols.sumActive("hp");

// Refine a candidate list from an external engine (e.g., nerve or spatial)
const filtered = cols.refineIds("hp", new Uint32Array([42, 99]), 1.0, 50.0);
// -> Uint32Array [42]

cols.flushAll(); // Atomic temp-file + fsync + POSIX rename
```

---

## Architecture & Limits

* **Contiguous SoA Columns:** Each column is a flat `Float32Array` indexed directly by `entity_id: u32`.
* **Zero-Allocation Refinement:** `refineIds` and `filterRange` write matching `u32` IDs into a pre-allocated scratch buffer and return a zero-copy `.subarray()` view.
* **Limits:** Fixed `maxEntities` capacity per store instance (default `1,000,000`), `f32` column values, single-writer process model.

---

## Zero-Coupling Ecosystem

Part of a modular trio of independent primitives sharing only a primitive `u32` Entity ID contract:

* **`nerve`** — Semantic tags, relations & payloads
* **`columns`** — AVX2/AVX-512 SIMD Structure-of-Arrays numeric store
* **`spatial`** — Cache-local flat 2D spatial grid & radius queries

## License

MIT
