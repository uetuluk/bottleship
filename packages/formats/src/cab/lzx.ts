/**
 * LZX decompressor for Microsoft Cabinet folders (CFFOLDER.typeCompress = 3).
 *
 * The cabinet variant of LZX (not LZX DELTA): LZ77 over a 2^15..2^21 window,
 * canonical Huffman for literals/match-slots/lengths, an optional aligned-offset
 * tree, a repeated-offset LRU (R0/R1/R2), and the x86 "E8 call" translation that
 * rewrites CALL rel32 operands to absolute-from-image-start so executables
 * compress better.
 *
 * Two details drive the shape of this code:
 *  - The bitstream is a sequence of 16-bit LITTLE-ENDIAN words whose bits are
 *    consumed MOST-significant-first, so the bit buffer is kept left-aligned in
 *    a u32 and refilled a whole word at a time.
 *  - Output is framed at 32 KiB. E8 translation is applied per frame to a COPY:
 *    the LZ window must keep the untranslated bytes, or later matches decode
 *    garbage. Matches never cross a frame boundary (the format guarantees it),
 *    but they may overrun a block boundary — the overrun is charged to the next
 *    block's remaining count.
 *
 * Reference: Microsoft `[MS-PATCH]` §2.2 (LZX DELTA shares the core coding) and
 * the cabinet SDK; symbol/slot tables below are the canonical ones.
 */

const NUM_CHARS = 256;
const MIN_MATCH = 2;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_ELEMENTS = 20;
const ALIGNED_ELEMENTS = 8;
const FRAME_SIZE = 32768;
/** E8 translation covers the first 1 GiB of output (32768 frames). */
const E8_MAX_FRAME = 32768;

const BLOCKTYPE_VERBATIM = 1;
const BLOCKTYPE_ALIGNED = 2;
const BLOCKTYPE_UNCOMPRESSED = 3;

// prettier-ignore
const EXTRA_BITS = new Uint8Array([
     0,  0,  0,  0,  1,  1,  2,  2,  3,  3,  4,  4,  5,  5,  6,  6,
     7,  7,  8,  8,  9,  9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14,
    15, 15, 16, 16, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
    17, 17, 17,
]);

// prettier-ignore
const POSITION_BASE = new Int32Array([
          0,       1,       2,       3,       4,       6,       8,      12,
         16,      24,      32,      48,      64,      96,     128,     192,
        256,     384,     512,     768,    1024,    1536,    2048,    3072,
       4096,    6144,    8192,   12288,   16384,   24576,   32768,   49152,
      65536,   98304,  131072,  196608,  262144,  393216,  524288,  655360,
     786432,  917504, 1048576, 1179648, 1310720, 1441792, 1572864, 1703936,
    1835008, 1966080, 2097152,
]);

/** Position slots per window size — index is (windowBits - 15). */
const POSITION_SLOTS = [30, 32, 34, 36, 38, 42, 50];

interface HuffTable {
    /** Flat lookup indexed by the next `bits` bits: (symbol << 5) | codeLength, or -1 for an invalid code. */
    table: Int32Array;
    bits: number;
    empty: boolean;
}

const EMPTY_TABLE: HuffTable = { table: new Int32Array(0), bits: 0, empty: true };

/**
 * Build a flat canonical-Huffman lookup sized to the longest code present.
 * Flat (rather than libmspack's two-level) table: the longest LZX code is 16
 * bits, so the worst case is a 64 K-entry Int32Array rebuilt per block — cheaper
 * than the per-symbol tree walk it replaces.
 */
function buildTable(lens: Uint8Array, count: number): HuffTable {
    let maxLen = 0;
    for (let i = 0; i < count; i++) if (lens[i]! > maxLen) maxLen = lens[i]!;
    if (maxLen === 0) return EMPTY_TABLE;

    const blCount = new Int32Array(maxLen + 1);
    for (let i = 0; i < count; i++) blCount[lens[i]!]!++;
    blCount[0] = 0;

    const nextCode = new Int32Array(maxLen + 1);
    let code = 0;
    for (let b = 1; b <= maxLen; b++) {
        code = (code + blCount[b - 1]!) << 1;
        nextCode[b] = code;
    }

    const table = new Int32Array(1 << maxLen).fill(-1);
    for (let sym = 0; sym < count; sym++) {
        const l = lens[sym]!;
        if (l === 0) continue;
        const start = nextCode[l]!++ << (maxLen - l);
        const span = 1 << (maxLen - l);
        table.fill((sym << 5) | l, start, start + span);
    }
    return { table, bits: maxLen, empty: false };
}

export interface LzxOptions {
    /** Called after each 32 KiB frame is emitted (progress reporting). */
    onProgress?: (done: number, total: number) => void;
}

/**
 * Decode one cabinet folder's LZX stream.
 *
 * @param input   the folder's concatenated CFDATA payloads (one continuous stream)
 * @param outputLength  total uncompressed size (sum of the folder's CFDATA.cbUncomp)
 * @param windowBits    15..21, from the high byte of CFFOLDER.typeCompress
 */
export function lzxDecompress(input: Uint8Array, outputLength: number, windowBits: number, opts: LzxOptions = {}): Uint8Array {
    const numPositionSlots = POSITION_SLOTS[windowBits - 15];
    if (numPositionSlots === undefined) throw new Error(`unsupported LZX window size 2^${windowBits}`);
    const mainElements = NUM_CHARS + (numPositionSlots << 3);

    // The LZ window IS the output buffer: the folder stream is contiguous and a
    // match reaches back at most 2^windowBits, so no circular wrap is needed.
    const win = new Uint8Array(outputLength);
    let winPos = 0;

    const inLen = input.length;
    let bitBuf = 0; // left-aligned in 32 bits: the next bit is the MSB
    let bitsLeft = 0;
    let pos = 0;

    function ensure(n: number): void {
        while (bitsLeft < n) {
            const lo = pos < inLen ? input[pos]! : 0;
            const hi = pos + 1 < inLen ? input[pos + 1]! : 0;
            pos += 2;
            bitBuf = (bitBuf | ((lo | (hi << 8)) << (16 - bitsLeft))) >>> 0;
            bitsLeft += 16;
        }
    }
    function readBits(n: number): number {
        if (n === 0) return 0;
        ensure(n);
        const v = bitBuf >>> (32 - n);
        bitBuf = (bitBuf << n) >>> 0;
        bitsLeft -= n;
        return v;
    }
    function decode(t: HuffTable): number {
        if (t.empty) throw new Error("LZX: symbol read from an empty Huffman tree");
        ensure(t.bits);
        const e = t.table[bitBuf >>> (32 - t.bits)]!;
        if (e < 0) throw new Error("LZX: invalid Huffman code");
        const len = e & 31;
        bitBuf = (bitBuf << len) >>> 0;
        bitsLeft -= len;
        return e >>> 5;
    }

    const preLens = new Uint8Array(PRETREE_ELEMENTS);
    /** Decode `lens[first..last)` as pretree-coded deltas against the previous block's lengths. */
    function readLengths(lens: Uint8Array, first: number, last: number): void {
        for (let i = 0; i < PRETREE_ELEMENTS; i++) preLens[i] = readBits(4);
        const pre = buildTable(preLens, PRETREE_ELEMENTS);
        let x = first;
        while (x < last) {
            let z = decode(pre);
            if (z === 17) {
                let y = readBits(4) + 4;
                while (y-- > 0) lens[x++] = 0;
            } else if (z === 18) {
                let y = readBits(5) + 20;
                while (y-- > 0) lens[x++] = 0;
            } else if (z === 19) {
                let y = readBits(1) + 4;
                z = decode(pre);
                z = lens[x]! - z;
                if (z < 0) z += 17;
                while (y-- > 0) lens[x++] = z;
            } else {
                z = lens[x]! - z;
                if (z < 0) z += 17;
                lens[x++] = z;
            }
        }
    }

    // Stream header: an optional 32-bit "Intel file size" enabling E8 translation.
    let intelFilesize = 0;
    if (readBits(1)) intelFilesize = ((readBits(16) << 16) | readBits(16)) | 0;
    let intelStarted = false;

    const out = intelFilesize !== 0 ? new Uint8Array(outputLength) : win;

    const mainLens = new Uint8Array(mainElements);
    const lenLens = new Uint8Array(NUM_SECONDARY_LENGTHS);
    const alignLens = new Uint8Array(ALIGNED_ELEMENTS);
    let mainTab = EMPTY_TABLE;
    let lenTab = EMPTY_TABLE;
    let alignTab = EMPTY_TABLE;

    let R0 = 1;
    let R1 = 1;
    let R2 = 1;
    let blockType = 0;
    let blockLength = 0;
    let blockRemaining = 0;

    for (let frame = 0; winPos < outputLength; frame++) {
        const frameStart = winPos;
        const frameEnd = Math.min(frameStart + FRAME_SIZE, outputLength);

        while (winPos < frameEnd) {
            if (blockRemaining === 0) {
                // An odd-length uncompressed block leaves the stream byte-aligned; skip its pad byte.
                if (blockType === BLOCKTYPE_UNCOMPRESSED && blockLength & 1) pos++;

                blockType = readBits(3);
                const hi = readBits(16);
                blockLength = (hi << 8) | readBits(8);
                blockRemaining = blockLength;

                if (blockType === BLOCKTYPE_ALIGNED) {
                    for (let i = 0; i < ALIGNED_ELEMENTS; i++) alignLens[i] = readBits(3);
                    alignTab = buildTable(alignLens, ALIGNED_ELEMENTS);
                }
                if (blockType === BLOCKTYPE_ALIGNED || blockType === BLOCKTYPE_VERBATIM) {
                    readLengths(mainLens, 0, NUM_CHARS);
                    readLengths(mainLens, NUM_CHARS, mainElements);
                    mainTab = buildTable(mainLens, mainElements);
                    // A coded 0xE8 literal is the signal that E8-translated data has begun.
                    if (mainLens[0xe8] !== 0) intelStarted = true;
                    readLengths(lenLens, 0, NUM_SECONDARY_LENGTHS);
                    lenTab = buildTable(lenLens, NUM_SECONDARY_LENGTHS);
                } else if (blockType === BLOCKTYPE_UNCOMPRESSED) {
                    intelStarted = true; // stored bytes may be anything
                    // Align to the next 16-bit boundary (1..16 pad bits), then read the LRU state.
                    ensure(16);
                    if (bitsLeft > 16) pos -= 2;
                    bitsLeft = 0;
                    bitBuf = 0;
                    if (pos + 12 > inLen) throw new Error("LZX: truncated uncompressed block header");
                    const dv = new DataView(input.buffer, input.byteOffset + pos, 12);
                    R0 = dv.getUint32(0, true);
                    R1 = dv.getUint32(4, true);
                    R2 = dv.getUint32(8, true);
                    pos += 12;
                } else {
                    throw new Error(`LZX: invalid block type ${blockType}`);
                }
            }

            const runStart = winPos;
            const target = Math.min(winPos + blockRemaining, frameEnd);

            if (blockType === BLOCKTYPE_UNCOMPRESSED) {
                const run = target - winPos;
                win.set(input.subarray(pos, pos + run), winPos);
                pos += run;
                winPos += run;
                blockRemaining -= run;
                continue;
            }

            while (winPos < target) {
                const sym = decode(mainTab);
                if (sym < NUM_CHARS) {
                    win[winPos++] = sym;
                    continue;
                }
                const packed = sym - NUM_CHARS;
                let matchLen = packed & 7;
                if (matchLen === 7) matchLen += decode(lenTab);
                matchLen += MIN_MATCH;

                const slot = packed >> 3;
                let matchOff: number;
                if (slot === 0) {
                    matchOff = R0;
                } else if (slot === 1) {
                    matchOff = R1;
                    R1 = R0;
                    R0 = matchOff;
                } else if (slot === 2) {
                    matchOff = R2;
                    R2 = R0;
                    R0 = matchOff;
                } else {
                    const extra = EXTRA_BITS[slot]!;
                    matchOff = POSITION_BASE[slot]! - 2;
                    if (blockType === BLOCKTYPE_ALIGNED) {
                        // The low 3 bits of a long offset come from the aligned tree, not the raw stream.
                        if (extra > 3) matchOff += (readBits(extra - 3) << 3) + decode(alignTab);
                        else if (extra === 3) matchOff += decode(alignTab);
                        else matchOff += readBits(extra);
                    } else {
                        matchOff += readBits(extra);
                    }
                    R2 = R1;
                    R1 = R0;
                    R0 = matchOff;
                }

                let src = winPos - matchOff;
                if (src < 0) throw new Error("LZX: match reaches before the start of the window");
                // A match may overrun the block (charged below) but never the frame;
                // clamp at outputLength so a trailing padded block can't overflow.
                const copy = Math.min(matchLen, outputLength - winPos);
                for (let k = 0; k < copy; k++) win[winPos++] = win[src++]!;
            }

            // The final match of a run may overrun the block boundary; charge every
            // byte actually produced, overrun included.
            blockRemaining -= winPos - runStart;
            if (blockRemaining < 0) throw new Error("LZX: match overran the end of its block");
        }

        // Every frame ends on a 16-bit boundary: the encoder pads the bitstream so a
        // cabinet's CFDATA blocks line up 1:1 with frames. Drop the pad bits.
        if (bitsLeft > 0) ensure(16);
        if (bitsLeft & 15) {
            bitBuf = (bitBuf << (bitsLeft & 15)) >>> 0;
            bitsLeft -= bitsLeft & 15;
        }

        // E8 translation is per frame and must not touch the LZ window.
        if (out !== win) {
            out.set(win.subarray(frameStart, frameEnd), frameStart);
            const size = frameEnd - frameStart;
            if (intelStarted && frame <= E8_MAX_FRAME && size > 10) {
                const end = frameEnd - 10;
                let i = frameStart;
                let curpos = frameStart;
                while (i < end) {
                    if (out[i++] !== 0xe8) {
                        curpos++;
                        continue;
                    }
                    const absOff = (out[i]! | (out[i + 1]! << 8) | (out[i + 2]! << 16) | (out[i + 3]! << 24)) | 0;
                    if (absOff >= -curpos && absOff < intelFilesize) {
                        const rel = absOff >= 0 ? absOff - curpos : absOff + intelFilesize;
                        out[i] = rel & 0xff;
                        out[i + 1] = (rel >>> 8) & 0xff;
                        out[i + 2] = (rel >>> 16) & 0xff;
                        out[i + 3] = (rel >>> 24) & 0xff;
                    }
                    i += 4;
                    curpos += 5;
                }
            }
        }

        opts.onProgress?.(winPos, outputLength);
    }

    return out;
}
