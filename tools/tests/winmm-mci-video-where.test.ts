/**
 * `where <device> source` — the frame size of a digital-video device, which is how a
 * client (MCIWnd among them) sizes a window around a movie before playing it.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { WinmmMci, aviFrameSize } from "../../src/worker/modules/winmm-mci";
import { virtualCd } from "../../src/worker/core/audio/virtual-cd";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

const MCIERR_INVALID_DEVICE_NAME = 263;
const MCIERR_UNSUPPORTED_FUNCTION = 274;

/** RIFF 'AVI ' + LIST 'hdrl' + avih, the layout every AVI starts with. */
function aviHeader(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(12 + 12 + 8 + 56);
    const view = new DataView(bytes.buffer);
    const tag = (o: number, s: string): void => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
    tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "AVI ");
    tag(12, "LIST"); view.setUint32(16, 4 + 8 + 56, true); tag(20, "hdrl");
    tag(24, "avih"); view.setUint32(28, 56, true);
    view.setUint32(32 + 32, width, true);
    view.setUint32(32 + 36, height, true);
    return bytes;
}

describe("aviFrameSize", () => {
    test("reads dwWidth/dwHeight from the main header", () => {
        expect(aviFrameSize(aviHeader(320, 240))).toEqual({ width: 320, height: 240 });
    });

    test("a header chunk behind a JUNK chunk is still found", () => {
        const head = aviHeader(640, 272);
        const shifted = new Uint8Array(head.length + 16);
        shifted.set(head.subarray(0, 12), 0);
        shifted.set([0x4a, 0x55, 0x4e, 0x4b, 8, 0, 0, 0], 12);   // 'JUNK', 8 bytes
        shifted.set(head.subarray(12), 28);
        new DataView(shifted.buffer).setUint32(4, shifted.length - 8, true);
        expect(aviFrameSize(shifted)).toEqual({ width: 640, height: 272 });
    });

    test("anything that is not an AVI answers null instead of a size", () => {
        expect(aviFrameSize(new Uint8Array(64))).toBeNull();
        expect(aviFrameSize(aviHeader(320, 240).subarray(0, 40))).toBeNull();
    });

    test("rejects another RIFF form, oversized chunks and headers outside their LIST", () => {
        const wave = aviHeader(320, 240);
        wave.set(new TextEncoder().encode("WAVE"), 8);
        expect(aviFrameSize(wave)).toBeNull();
        const shortList = aviHeader(320, 240);
        new DataView(shortList.buffer).setUint32(16, 4, true);
        expect(aviFrameSize(shortList)).toBeNull();
        const oversized = aviHeader(320, 240);
        new DataView(oversized.buffer).setUint32(28, 0xffffffff, true);
        expect(aviFrameSize(oversized)).toBeNull();
        const shortRiff = aviHeader(320, 240);
        new DataView(shortRiff.buffer).setUint32(4, 16, true);
        expect(aviFrameSize(shortRiff)).toBeNull();
        expect(aviFrameSize(aviHeader(0, 240))).toBeNull();
    });
});

describe("MCI where", () => {
    const mem = new Uint8Array(0x10000);
    let exports: Record<string, ThunkImplementation>;
    const send = (command: string): number => {
        mem.fill(0, 0x100, 0x300);
        for (let i = 0; i < command.length; i++) mem[0x100 + i] = command.charCodeAt(i);
        return exports["mciSendStringA"]!({} as never, mem, [0x100, 0, 0, 0]) as number;
    };

    beforeEach(() => {
        virtualCd().reset();
        const mci = new WinmmMci({
            readAnsiString: (ptr, max) => {
                let s = "";
                for (let i = 0; i < max && mem[ptr + i]; i++) s += String.fromCharCode(mem[ptr + i]!);
                return s;
            },
            writeAnsiString: () => true,
            readWideString: () => "",
            writeWideString: () => true,
        });
        exports = {};
        mci.registerExports(exports);
    });

    test("an unknown device is an invalid name", () => {
        expect(send("where nothing source")).toBe(MCIERR_INVALID_DEVICE_NAME);
    });

    test("a device with no picture does not support it", () => {
        expect(send("open cdaudio")).toBe(0);
        expect(send("where cdaudio source")).toBe(MCIERR_UNSUPPORTED_FUNCTION);
    });
});
