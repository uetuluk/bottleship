/**
 * DMUSIC.dll API descriptor — DirectMusic core (dmusicc.h).
 *
 * dmusic.dll is a pure COM server (its only exports are DllGetClassObject & co);
 * apps reach it through CoCreateInstance(CLSID_DirectMusic). IDirectMusic2 is the
 * binary superset of IDirectMusic (one extra slot), so a single vtable serves both.
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const makeMethod = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

export const IDirectMusic2: InterfaceDescriptor = {
    name: "IDirectMusic2",
    inherits: "IUnknown",
    iid: "6fc2cae1-bc78-11d2-afa6-00aa0024d8b6",
    methods: [
        ...IUnknown.methods,
        // IDirectMusic (slots 3-11)
        makeMethod("EnumPort", 3),            // (dwIndex, LPDMUS_PORTCAPS)
        makeMethod("CreateMusicBuffer", 4),   // (LPDMUS_BUFFERDESC, LPDIRECTMUSICBUFFER*, LPUNKNOWN)
        makeMethod("CreatePort", 5),          // (REFCLSID, LPDMUS_PORTPARAMS, LPDIRECTMUSICPORT*, LPUNKNOWN)
        makeMethod("EnumMasterClock", 3),     // (dwIndex, LPDMUS_CLOCKINFO)
        makeMethod("GetMasterClock", 3),      // (LPGUID, IReferenceClock**)
        makeMethod("SetMasterClock", 2),      // (REFGUID)
        makeMethod("Activate", 2),            // (BOOL)
        makeMethod("GetDefaultPort", 2),      // (LPGUID)
        makeMethod("SetDirectSound", 3),      // (LPDIRECTSOUND, HWND)
        // IDirectMusic2 (slot 12)
        makeMethod("SetExternalMasterClock", 2), // (IReferenceClock*)
    ],
};

export const dmusicModule: ModuleDescriptor = {
    name: "dmusic",
    version: "6.1",
    description: "DirectMusic core object (IDirectMusic / IDirectMusic2)",
    functions: [],
    interfaces: [IDirectMusic2],
};
