// LoadLibrary / MessageBox diagnostic rings and their exit-report rendering: a game that
// LoadLibrary's a missing DLL, shows an error box and exits must name both in the report.

import { describe, expect, test } from "bun:test";
import { loadLibraryRegistry } from "../../src/worker/core/diagnostics/load-library-registry";
import { messageBoxRegistry } from "../../src/worker/core/diagnostics/message-box-registry";
import { formatGuestReport } from "../../src/guest-report";

describe("loadLibraryRegistry", () => {
    test("keeps chronological order and exposes failures", () => {
        loadLibraryRegistry.clear();
        loadLibraryRegistry.record("LoadLibraryA", "DDRAW.DLL", 0x72770000, "hle ddraw", 0x4032ce);
        loadLibraryRegistry.record("LoadLibraryA", "d3ddll.dll", 0, "not found on VFS or HLE catalog (err=126)", 0x44db66);
        const recent = loadLibraryRegistry.recent();
        expect(recent.map((r) => r.name)).toEqual(["DDRAW.DLL", "d3ddll.dll"]);
        expect(loadLibraryRegistry.failures().map((r) => r.caller)).toEqual([0x44db66]);
    });

    test("ring wraps without losing the newest entries", () => {
        loadLibraryRegistry.clear();
        for (let i = 0; i < 40; i++) loadLibraryRegistry.record("LoadLibraryA", `m${i}.dll`, 1, "hle", i);
        const recent = loadLibraryRegistry.recent(4);
        expect(recent.map((r) => r.name)).toEqual(["m36.dll", "m37.dll", "m38.dll", "m39.dll"]);
    });
});

describe("messageBoxRegistry", () => {
    test("records caption, text and style, newest last", () => {
        messageBoxRegistry.clear();
        messageBoxRegistry.record("MessageBoxA", "GTA2", "Cannot load d3ddll.dll", 0x10, 0x4d0919);
        const [m] = messageBoxRegistry.recent();
        expect(m.caption).toBe("GTA2");
        expect(m.text).toBe("Cannot load d3ddll.dll");
        expect(m.uType).toBe(0x10);
    });
});

describe("formatGuestReport", () => {
    test("renders the LoadLibrary and MessageBox sections", () => {
        const text = formatGuestReport({
            reason: "ExitProcess(code=4294967295)",
            eip: 0x21046ffb,
            faultAddr: 0,
            recentLoadLibrary: [
                { api: "LoadLibraryA", name: "DINPUT.DLL", handle: "0x72850000", note: "hle dinput", caller: "0x4033d4", callerSym: "gta2.exe+0x33d4" },
                { api: "LoadLibraryA", name: "d3ddll.dll", handle: null, note: "not found on VFS or HLE catalog (err=126)", caller: "0x44db66", callerSym: null },
            ],
            recentMessageBoxes: [
                { api: "MessageBoxA", caption: "GTA2", text: "Cannot load d3ddll.dll", uType: "0x10", caller: "0x4d0919", callerSym: "gta2.exe+0xd0919" },
            ],
        }, "GTA 2", false);
        expect(text).toContain('LoadLibraryA("d3ddll.dll") → NULL  not found on VFS or HLE catalog (err=126)  caller=0x44db66');
        expect(text).toContain('LoadLibraryA("DINPUT.DLL") → 0x72850000  hle dinput  caller=0x4033d4 gta2.exe+0x33d4');
        expect(text).toContain('MessageBoxA "GTA2": "Cannot load d3ddll.dll"  type=0x10  caller=0x4d0919 gta2.exe+0xd0919');
    });
});
