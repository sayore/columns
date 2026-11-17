// packages/columns-bun/src/index.ts
import { ptr, dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export enum ColMode {
    Volatile = 0,
    FastWal = 1,
    StrictAcid = 2,
}

const encoder = new TextEncoder();
const toCString = (s: string) => encoder.encode(s + "\0");

export class ColumnStore {
    readonly maxEntities: number;
    readonly activeBits: Uint32Array;
    private readonly columns = new Map<string, Float32Array>();
    private readonly scratchIds: Uint32Array;
    private readonly sumCountScratch = new BigUint64Array(1);
    private readonly lib: any;
    private readonly dir: string;
    private mode: ColMode = ColMode.FastWal;

    constructor(libPath: string, dbDir: string = "db/cols", maxEntities: number = 1_000_000) {
        this.maxEntities = maxEntities;
        this.dir = dbDir;
        this.activeBits = new Uint32Array(Math.ceil(maxEntities / 32));
        this.scratchIds = new Uint32Array(maxEntities);

        const bitsPath = join(this.dir, "_active_bits.bin");
        if (existsSync(bitsPath)) {
            const buf = readFileSync(bitsPath);
            const loaded = new Uint32Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength >>> 2, this.activeBits.length));
            this.activeBits.set(loaded);
        }

        this.lib = dlopen(libPath, {
            col_filter_range_f32: {
                args: [FFIType.ptr, FFIType.u64, FFIType.f32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.u64],
                returns: FFIType.u64,
            },
            col_refine_ids_f32: {
                args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.f32, FFIType.f32, FFIType.ptr],
                returns: FFIType.u64,
            },
            col_fma_all_f32: {
                args: [FFIType.ptr, FFIType.u64, FFIType.f32, FFIType.f32],
                returns: FFIType.void,
            },
            col_sum_active_f32: {
                args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
                returns: FFIType.f64,
            },
            bitset_and: {
                args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
                returns: FFIType.void,
            },
            col_atomic_snapshot: {
                args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
        });
    }

    setMode(mode: ColMode) {
        this.mode = mode;
    }

    /** Registriert oder lädt eine f32-Spalte (4 MB bei 1M Entities) */
    f32(name: string): Float32Array {
        let col = this.columns.get(name);
        if (col) return col;

        col = new Float32Array(this.maxEntities);
        const filePath = join(this.dir, `${name}.bin`);
        if (existsSync(filePath)) {
            const buf = readFileSync(filePath);
            col.set(new Float32Array(buf.buffer, buf.byteOffset, Math.min(buf.byteLength >>> 2, this.maxEntities)));
        }
        this.columns.set(name, col);
        return col;
    }

    set(name: string, entityId: number, value: number) {
        const col = this.f32(name);
        col[entityId] = value;
        this.activeBits[entityId >>> 5] |= 1 << (entityId & 31);
    }

    clearEntity(entityId: number) {
        this.activeBits[entityId >>> 5] &= ~(1 << (entityId & 31));
        for (const col of this.columns.values()) {
            col[entityId] = 0;
        }
    }

    /** Vollscan über 1M Entities per AVX2/AVX-512 SIMD */
    filterRange(name: string, min: number, max: number): Uint32Array {
        const col = this.f32(name);
        const len = Number(
            this.lib.symbols.col_filter_range_f32(
                ptr(col),
                col.length,
                min,
                max,
                ptr(this.activeBits),
                ptr(this.scratchIds),
                this.scratchIds.length
            )
        );
        return this.scratchIds.subarray(0, len);
    }

    /** Verfeinert bestehende Treffer-IDs (z. B. direkt aus Nerve) */
    refineIds(name: string, ids: Uint32Array, min: number, max: number): Uint32Array {
        if (ids.length === 0) return ids;
        const col = this.f32(name);
        const len = Number(
            this.lib.symbols.col_refine_ids_f32(
                ptr(col),
                col.length,
                ptr(ids),
                ids.length,
                min,
                max,
                ptr(this.scratchIds)
            )
        );
        return this.scratchIds.subarray(0, len);
    }

    /** Massen-Update über alle Entities (`col[i] = col[i] * mul + add`) */
    transformAll(name: string, mul: number, add: number) {
        const col = this.f32(name);
        this.lib.symbols.col_fma_all_f32(ptr(col), col.length, mul, add);
    }

    /** SIMD-Aggregation über alle aktiven Entities */
    sumActive(name: string): { sum: number; count: number } {
        const col = this.f32(name);
        const sum = this.lib.symbols.col_sum_active_f32(
            ptr(col),
            col.length,
            ptr(this.activeBits),
            ptr(this.sumCountScratch)
        );
        return { sum, count: Number(this.sumCountScratch[0]) };
    }

    /** Persistiert alle Spalten + Active-Bitset atomar auf Disk */
    flushAll() {
        if (this.mode === ColMode.Volatile) return;
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });

        for (const [name, col] of this.columns.entries()) {
            const dst = toCString(join(this.dir, `${name}.bin`));
            const tmp = toCString(join(this.dir, `${name}.bin.tmp`));
            this.lib.symbols.col_atomic_snapshot(ptr(col), col.byteLength, ptr(tmp), ptr(dst), this.mode);
        }
        const bitsDst = toCString(join(this.dir, "_active_bits.bin"));
        const bitsTmp = toCString(join(this.dir, "_active_bits.bin.tmp"));
        this.lib.symbols.col_atomic_snapshot(
            ptr(this.activeBits),
            this.activeBits.byteLength,
            ptr(bitsTmp),
            ptr(bitsDst),
            this.mode
        );
    }
}
