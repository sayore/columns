// crates/columns-core/src/lib.rs
use std::os::raw::{c_char, c_int, c_void};
use std::slice;

pub const MODE_VOLATILE: u32 = 0;
pub const MODE_FAST_WAL: u32 = 1;
pub const MODE_STRICT_ACID: u32 = 2;

extern "C" {
    fn open(path: *const c_char, oflag: c_int, ...) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    fn fsync(fd: c_int) -> c_int;
    fn rename(old: *const c_char, new: *const c_char) -> c_int;
}

const O_WRONLY: c_int = 1;
const O_CREAT: c_int = 0o100;
const O_TRUNC: c_int = 0o1000;

/// SIMD-auto-vektorisierter Range-Filter über ein gesamtes f32-Column-Array:
/// Schreibt alle `entity_id`s mit `min <= col[id] <= max` (und aktivem Bit im `active_bits`) in `out_ids`.
#[no_mangle]
pub unsafe extern "C" fn col_filter_range_f32(
    col_ptr: *const f32,
    len: usize,
    min_val: f32,
    max_val: f32,
    active_bits_ptr: *const u32,
    out_ids_ptr: *mut u32,
    max_out: usize,
) -> usize {
    if col_ptr.is_null() || out_ids_ptr.is_null() || len == 0 || max_out == 0 {
        return 0;
    }

    let col = slice::from_raw_parts(col_ptr, len);
    let mut count = 0usize;

    if active_bits_ptr.is_null() {
        for i in 0..len {
            let v = *col.get_unchecked(i);
            if v >= min_val && v <= max_val {
                if count < max_out {
                    *out_ids_ptr.add(count) = i as u32;
                    count += 1;
                } else {
                    break;
                }
            }
        }
    } else {
        // Blockweise über 32er-Bitset-Words iterieren: Überspringt leere 32er-Blöcke in 1 Takt!
        let num_words = (len + 31) / 32;
        for w in 0..num_words {
            let mut mask = *active_bits_ptr.add(w);
            if mask == 0 {
                continue;
            }
            let base = w * 32;
            while mask != 0 {
                let bit = mask.trailing_zeros() as usize;
                let id = base + bit;
                if id < len {
                    let v = *col.get_unchecked(id);
                    if v >= min_val && v <= max_val {
                        if count < max_out {
                            *out_ids_ptr.add(count) = id as u32;
                            count += 1;
                        } else {
                            return count;
                        }
                    }
                }
                mask &= mask - 1;
            }
        }
    }

    count
}

/// Filtert eine bestehende ID-Liste (z. B. das Ergebnis aus `Nerve`) in-place weiter herunter.
#[no_mangle]
pub unsafe extern "C" fn col_refine_ids_f32(
    col_ptr: *const f32,
    col_len: usize,
    in_ids_ptr: *const u32,
    in_len: usize,
    min_val: f32,
    max_val: f32,
    out_ids_ptr: *mut u32,
) -> usize {
    if col_ptr.is_null() || in_ids_ptr.is_null() || out_ids_ptr.is_null() {
        return 0;
    }
    let mut k = 0usize;
    for i in 0..in_len {
        let id = *in_ids_ptr.add(i) as usize;
        if id < col_len {
            let v = *col_ptr.add(id);
            if v >= min_val && v <= max_val {
                *out_ids_ptr.add(k) = id as u32;
                k += 1;
            }
        }
    }
    k
}

/// SIMD-Batch-Operation: `col[i] = col[i] * mul + add` über alle Entities
#[no_mangle]
pub unsafe extern "C" fn col_fma_all_f32(
    col_ptr: *mut f32,
    len: usize,
    mul: f32,
    add: f32,
) {
    if col_ptr.is_null() || len == 0 {
        return;
    }
    let col = slice::from_raw_parts_mut(col_ptr, len);
    for v in col.iter_mut() {
        *v = *v * mul + add;
    }
}

/// SIMD-Aggregation: Berechnet Summe & Trefferanzahl über alle aktiven Entities in einem Pass
#[no_mangle]
pub unsafe extern "C" fn col_sum_active_f32(
    col_ptr: *const f32,
    len: usize,
    active_bits_ptr: *const u32,
    out_count_ptr: *mut u64,
) -> f64 {
    if col_ptr.is_null() || len == 0 {
        return 0.0;
    }
    let col = slice::from_raw_parts(col_ptr, len);
    let mut sum = 0.0f64;
    let mut count = 0u64;

    if active_bits_ptr.is_null() {
        for &v in col {
            sum += v as f64;
        }
        count = len as u64;
    } else {
        let num_words = (len + 31) / 32;
        for w in 0..num_words {
            let mut mask = *active_bits_ptr.add(w);
            let base = w * 32;
            while mask != 0 {
                let bit = mask.trailing_zeros() as usize;
                let id = base + bit;
                if id < len {
                    sum += *col.get_unchecked(id) as f64;
                    count += 1;
                }
                mask &= mask - 1;
            }
        }
    }

    if !out_count_ptr.is_null() {
        *out_count_ptr = count;
    }
    sum
}

/// Setzt zwei Entity-ID-Bitsets per Bitwise-AND zusammen (`out = a & b`)
#[no_mangle]
pub unsafe extern "C" fn bitset_and(
    a_ptr: *const u32,
    b_ptr: *const u32,
    out_ptr: *mut u32,
    words: usize,
) {
    if a_ptr.is_null() || b_ptr.is_null() || out_ptr.is_null() {
        return;
    }
    let a = slice::from_raw_parts(a_ptr, words);
    let b = slice::from_raw_parts(b_ptr, words);
    let out = slice::from_raw_parts_mut(out_ptr, words);
    for i in 0..words {
        *out.get_unchecked_mut(i) = *a.get_unchecked(i) & *b.get_unchecked(i);
    }
}

#[no_mangle]
pub unsafe extern "C" fn col_atomic_snapshot(
    col_ptr: *const u8,
    byte_len: usize,
    tmp_path_ptr: *const c_char,
    dst_path_ptr: *const c_char,
    mode: u32,
) -> c_int {
    if mode == MODE_VOLATILE || tmp_path_ptr.is_null() || dst_path_ptr.is_null() {
        return 0;
    }
    let fd = open(tmp_path_ptr, O_WRONLY | O_CREAT | O_TRUNC, 0o644u32);
    if fd < 0 {
        return -1;
    }
    if byte_len > 0 && !col_ptr.is_null() {
        if write(fd, col_ptr as *const c_void, byte_len) != byte_len as isize {
            close(fd);
            return -1;
        }
    }
    if mode == MODE_STRICT_ACID {
        fsync(fd);
    }
    close(fd);
    rename(tmp_path_ptr, dst_path_ptr)
}
