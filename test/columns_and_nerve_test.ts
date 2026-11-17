// test/columns_and_nerve_test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ColumnStore, ColMode } from "../packages/columns-bun/src/index";

const ROOT_DIR = join(import.meta.dir, "..");
const NERVE_DB_DIR = join(ROOT_DIR, "db");
const COLS_DB_DIR = join(ROOT_DIR, "db_cols_test");
const LIB_PATH = join(ROOT_DIR, "crates/columns-core/target/release/libcolumns_core.so");

// Sicherstellen, dass db/ existiert, bevor nerve's engine.ts geladen wird
if (!existsSync(NERVE_DB_DIR)) mkdirSync(NERVE_DB_DIR, { recursive: true });
if (existsSync(COLS_DB_DIR)) rmSync(COLS_DB_DIR, { recursive: true, force: true });

const { Engine, DbMode } = await import("/mnt/lfs/lfs/repos/nerve/packages/nerve-bun/src/engine.ts");

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

const results: TestResult[] = [];
function assertTest(name: string, condition: boolean, detail: string) {
    results.push({ name, passed: condition, detail });
    console.log(`[${condition ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

console.log("=== 1. Standalone-Tests (columns) ===");

const MAX_ENTITIES = 1_000_000;
const cols = new ColumnStore(LIB_PATH, COLS_DB_DIR, MAX_ENTITIES);
cols.setMode(ColMode.Volatile);

// 1M aktive Entities mit exakten f32-Werten 1..100 befüllen
const hpCol = cols.f32("hp");
for (let i = 0; i < MAX_ENTITIES; i++) {
    hpCol[i] = (i % 100) + 1;
    cols.activeBits[i >>> 5] |= 1 << (i & 31);
}

// 1a. sumActive über 1.000.000 aktive Entities
const sumRes = cols.sumActive("hp");
const expectedSum = 1_000_000 * 50.5; // (1+100)/2 * 1_000_000 = 50_500_000
assertTest(
    "sumActive (1.000.000 aktive Entities)",
    sumRes.count === 1_000_000 && sumRes.sum === expectedSum,
    `count=${sumRes.count}, sum=${sumRes.sum} (erwartet: ${expectedSum})`
);

// 1b. filterRange über 1.000.000 aktive Entities (1 <= hp <= 25 -> 250.000 Treffer)
cols.filterRange("hp", 1, 25); // Warmup
const FILTER_RUNS = 50;
const tFilterStart = performance.now();
let filteredIds = new Uint32Array(0);
for (let i = 0; i < FILTER_RUNS; i++) {
    filteredIds = cols.filterRange("hp", 1, 25);
}
const filterUs = ((performance.now() - tFilterStart) * 1000) / FILTER_RUNS;
assertTest(
    "filterRange (1.000.000 Entities, 1..25)",
    filteredIds.length === 250_000 && filteredIds[0] === 0 && filteredIds[1] === 1,
    `hits=${filteredIds.length}, avgLatency=${filterUs.toFixed(2)} µs`
);

// 1c. transformAll (col_fma_all_f32: hp = hp * 2 + 10)
cols.transformAll("hp", 2, 10); // Warmup
const FMA_RUNS = 50;
const tFmaStart = performance.now();
for (let i = 0; i < FMA_RUNS; i++) {
    cols.transformAll("hp", 1, 0);
}
const fmaUs = ((performance.now() - tFmaStart) * 1000) / FMA_RUNS;
assertTest(
    "transformAll (col_fma_all_f32 über 1.000.000 Entities)",
    hpCol[0] === 12 && hpCol[99] === 210,
    `hp[0]=${hpCol[0]}, hp[99]=${hpCol[99]}, avgLatency=${fmaUs.toFixed(2)} µs`
);

// 1d. Persistenz- & Reload-Test (StrictAcid -> flushAll -> neue Instanz)
const PERSIST_DIR = join(COLS_DB_DIR, "persist");
const store1 = new ColumnStore(LIB_PATH, PERSIST_DIR, 10_000);
store1.setMode(ColMode.StrictAcid);
for (let i = 0; i < 10_000; i++) {
    if (i % 2 === 0) {
        store1.set("hp", i, (i % 100) + 1);
    }
}
const sumBeforeReload = store1.sumActive("hp");
const filterBeforeReload = store1.filterRange("hp", 1, 20).length;
store1.flushAll();

const store2 = new ColumnStore(LIB_PATH, PERSIST_DIR, 10_000);
const sumAfterReload = store2.sumActive("hp");
const filterAfterReload = store2.filterRange("hp", 1, 20).length;
assertTest(
    "Persistenz & Reload (StrictAcid + _active_bits.bin)",
    sumBeforeReload.count === 5_000 &&
        sumAfterReload.count === sumBeforeReload.count &&
        sumAfterReload.sum === sumBeforeReload.sum &&
        filterAfterReload === filterBeforeReload,
    `count=${sumAfterReload.count}, sum=${sumAfterReload.sum}, filterHits=${filterAfterReload}`
);

console.log("\n=== 2. Zero-Coupling-Integrationstest (nerve + columns) ===");

Engine.reset();
Engine.setMode(DbMode.FastWal);

const ENTITIES = 100_000;
const integCols = new ColumnStore(LIB_PATH, join(COLS_DB_DIR, "integ"), ENTITIES);
integCols.setMode(ColMode.Volatile);

Engine.beginTransaction();
for (let i = 0; i < ENTITIES; i++) {
    Engine.addKeyword(i, `zone_${i % 10}`);
    if (i % 10 === 0) Engine.addKeyword(i, "undead");
    if (i % 100 === 0) Engine.addKeyword(i, "boss");
    integCols.set("hp", i, (i % 500) + 1);
    integCols.set("level", i, (i % 60) + 1);
}
Engine.commitTransaction();
Engine.triggerAsyncMerge();

const candidateScratch = new Uint32Array(50);
function runCombinedQuery(): Uint32Array {
    const semanticHits = Engine.getTopMatchesUnique(["undead", "boss"], [], 50);
    for (let i = 0; i < semanticHits.length; i++) {
        candidateScratch[i] = semanticHits[i].id;
    }
    return integCols.refineIds("hp", candidateScratch.subarray(0, semanticHits.length), 1, 250);
}

// Warmup
const sampleHits = runCombinedQuery();
const integHp = integCols.f32("hp");
const allValid =
    sampleHits.length > 0 &&
    Array.from(sampleHits).every(id => id % 100 === 0 && integHp[id] >= 1 && integHp[id] <= 250);

const COMBINED_RUNS = 1000;
const tCombStart = performance.now();
let lastLen = 0;
for (let i = 0; i < COMBINED_RUNS; i++) {
    lastLen = runCombinedQuery().length;
}
const combinedUs = ((performance.now() - tCombStart) * 1000) / COMBINED_RUNS;

assertTest(
    "Nerve + Columns Kombinierte Query (100.000 Entities, 1.000 Läufe)",
    allValid && lastLen === sampleHits.length,
    `refinedHits=${lastLen}, combinedAvgLatency=${combinedUs.toFixed(3)} µs`
);

// Aufräumen der temporären Test-Ordner
rmSync(COLS_DB_DIR, { recursive: true, force: true });
rmSync(NERVE_DB_DIR, { recursive: true, force: true });

console.log("\n=== Zusammenfassung ===");
console.log(`| Benchmark | Messwert |`);
console.log(`| --- | ---: |`);
console.log(`| columns filterRange (1M f32) | ${filterUs.toFixed(2)} µs |`);
console.log(`| columns transformAll FMA (1M f32) | ${fmaUs.toFixed(2)} µs |`);
console.log(`| nerve + columns combined (100k Entities, 1k Runs) | ${combinedUs.toFixed(3)} µs |`);

const failed = results.filter(r => !r.passed).length;
console.log(`\nGesamt: ${results.length - failed}/${results.length} Tests bestanden.`);
if (failed > 0) process.exit(1);
