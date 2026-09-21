/**
 * Video for Windows (msvfw32.dll) API Descriptor
 *
 * DrawDib (render an AVI frame to a DC), the ICM compressor query, and the
 * MCIWnd control games use to host a movie in a child window.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const msvfw32Module: ModuleDescriptor = {
    name: "msvfw32",
    functions: [
        // DrawDib API
        makeFunc("DrawDibOpen", 0),              // → HDRAWDIB
        makeFunc("DrawDibClose", 1),             // hdd
        makeFunc("DrawDibDraw", 13),             // hdd, hdc, xDst, yDst, dxDst, dyDst, lpbi, lpBits, xSrc, ySrc, dxSrc, dySrc, wFlags

        // ICM (Installable Compression Manager)
        makeFunc("ICInfo", 3),                   // fccType, fccHandler, lpicinfo → BOOL

        // MCIWnd control
        makeFunc("MCIWndCreateA", 4),            // hwndParent, hInstance, dwStyle, szFile → HWND
    ]
};
