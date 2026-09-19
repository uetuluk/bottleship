// BIK file header parse: what skipVideo hands the game as an already-finished HBINK.

import { describe, expect, test } from "bun:test";
import { parseBinkFileHeader } from "../../src/worker/modules/binkw32";

function header(fields: { size: number; frames: number; width: number; height: number; fpsNum: number; fpsDiv: number }): Uint8Array {
    const b = new Uint8Array(44);
    const v = new DataView(b.buffer);
    b.set([0x42, 0x49, 0x4b, 0x69], 0); // "BIKi"
    v.setUint32(4, fields.size, true);
    v.setUint32(8, fields.frames, true);
    v.setUint32(16, fields.frames, true);
    v.setUint32(20, fields.width, true);
    v.setUint32(24, fields.height, true);
    v.setUint32(28, fields.fpsNum, true);
    v.setUint32(32, fields.fpsDiv, true);
    return b;
}

describe("parseBinkFileHeader", () => {
    test("reads dimensions, frame count, fps ratio and stream length", () => {
        const h = parseBinkFileHeader(header({ size: 1000, frames: 300, width: 640, height: 480, fpsNum: 30000, fpsDiv: 1001 }))!;
        expect(h.width).toBe(640);
        expect(h.height).toBe(480);
        expect(h.frames).toBe(300);
        expect(h.fps).toBeCloseTo(29.97, 2);
        expect(h.totalSize).toBe(1008);
    });

    test("a zero fps divisor does not produce Infinity", () => {
        const h = parseBinkFileHeader(header({ size: 8, frames: 1, width: 320, height: 240, fpsNum: 15, fpsDiv: 0 }))!;
        expect(h.fps).toBe(15);
    });

    test("rejects short buffers and non-BIK signatures", () => {
        expect(parseBinkFileHeader(new Uint8Array(10))).toBeNull();
        const b = header({ size: 8, frames: 1, width: 1, height: 1, fpsNum: 1, fpsDiv: 1 });
        b[0] = 0x53;
        expect(parseBinkFileHeader(b)).toBeNull();
    });
});
