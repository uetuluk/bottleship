/**
 * Undo Inno Setup call/jmp compression on executables — port of stream/exefilter.hpp.
 *
 * Three variants, picked by the version that WROTE the installer (setup/data.cpp):
 * < 5.2.0 uses the 4108 decoder, [5.2.0, 5.3.9) the 5200 decoder, and 5.3.9+ the same
 * 5200 decoder with high-byte flipping. Using the wrong one yields plausible-looking
 * bytes that only fail at the file checksum.
 */

import type { InnoVersion } from "./version";

const BLOCK_SIZE = 0x10000;

export interface InnoExeDecoder {
    push(input: Uint8Array): Uint8Array;
    finish(): Uint8Array;
}

/**
 * InstructionFilter4108 — Inno Setup < 5.2.0. A running-sum decoder with no block
 * framing: every byte after an E8/E9 opcode feeds a 4-byte rolling add.
 */
export class InnoExeDecoder4108 implements InnoExeDecoder {
    private addr = 0;
    private addrBytesLeft = 0;
    private addrOffset = 5;

    push(input: Uint8Array): Uint8Array {
        const out = new Uint8Array(input.length);
        for (let i = 0; i < input.length; i++, this.addrOffset = (this.addrOffset + 1) >>> 0) {
            let byte = input[i]!;
            if (this.addrBytesLeft === 0) {
                if (byte === 0xe8 || byte === 0xe9) {
                    this.addr = (~this.addrOffset + 1) >>> 0;
                    this.addrBytesLeft = 4;
                }
            } else {
                this.addr = (this.addr + byte) >>> 0;
                byte = this.addr & 0xff;
                this.addr = this.addr >>> 8;
                this.addrBytesLeft--;
            }
            out[i] = byte;
        }
        return out;
    }

    finish(): Uint8Array {
        return new Uint8Array(0);
    }
}

/** InstructionFilter5200/5309 — Inno Setup ≥ 5.2.0; `flipHighByte` from 5.3.9 on. */
export class InnoExeDecoder5200 implements InnoExeDecoder {
    private offset = 0;
    private flushBytes = 0;
    private buffer = new Uint8Array(4);

    constructor(private readonly flipHighByte: boolean) {}

    push(input: Uint8Array): Uint8Array {
        const out: number[] = [];
        let i = 0;

        while (i < input.length || this.flushBytes !== 0) {
            if (this.flushBytes > 0 && this.flushBytes <= 4) {
                out.push(this.buffer[4 - this.flushBytes]!);
                this.flushBytes--;
                continue;
            }

            if (this.flushBytes < 0) {
                const need = -this.flushBytes;
                const take = Math.min(need, input.length - i);
                for (let j = 0; j < take; j++) {
                    this.buffer[4 + this.flushBytes + j] = input[i + j]!;
                }
                this.flushBytes += take;
                i += take;
                this.offset += take;
                if (this.flushBytes < 0) break;
                this.applyAddressTransform();
                this.flushBytes = 4;
                continue;
            }

            if (i >= input.length) break;

            const byte = input[i++]!;
            out.push(byte);
            this.offset++;

            if (byte !== 0xe8 && byte !== 0xe9) continue;

            const blockLeft = BLOCK_SIZE - ((this.offset - 1) % BLOCK_SIZE);
            if (blockLeft < 5) continue;

            this.flushBytes = -4;
        }

        return new Uint8Array(out);
    }

    /** Flush trailing call/jmp operand bytes at end of stream — innoextract end-of-stream path. */
    finish(): Uint8Array {
        const out: number[] = [];
        while (this.flushBytes > 0 && this.flushBytes <= 4) {
            out.push(this.buffer[4 - this.flushBytes]!);
            this.flushBytes--;
        }
        return new Uint8Array(out);
    }

    private applyAddressTransform(): void {
        if (this.buffer[3] === 0x00 || this.buffer[3] === 0xff) {
            const addr = this.offset & 0xffffff;
            let rel = this.buffer[0]! | (this.buffer[1]! << 8) | (this.buffer[2]! << 16);
            rel = (rel - addr) >>> 0;
            this.buffer[0] = rel & 0xff;
            this.buffer[1] = (rel >> 8) & 0xff;
            this.buffer[2] = (rel >> 16) & 0xff;
            // 5.3.9+ only: the original high byte is the sign extension of bit 23, so
            // toggling it when bit 23 is set makes both jump directions compress to 0x00.
            if (this.flipHighByte && rel & 0x800000) {
                this.buffer[3] = (~this.buffer[3]!) & 0xff;
            }
        }
    }
}

/** setup/data.cpp — CallInstructionOptimized (≥ 4.1.8) stored at bit 5 in our flag ladder. */
export function needsExeFilter(options: number): boolean {
    return (options & (1 << 5)) !== 0;
}

/** setup/data.cpp:load — the filter variant the writing version used. */
export function createExeDecoder(version: InnoVersion): InnoExeDecoder {
    if (!version.atLeast(5, 2, 0)) return new InnoExeDecoder4108();
    return new InnoExeDecoder5200(version.atLeast(5, 3, 9));
}
