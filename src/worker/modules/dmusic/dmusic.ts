/**
 * DirectMusic core object. Shipped with DirectX 6.1+, so its presence is what the SDK
 * GetDXVersion probe uses to tell 6.0 from 6.1 (LoadLibrary("dmusic.dll") and/or
 * CoCreateInstance(CLSID_DirectMusic)). No ports are enumerated: a title that wants
 * MIDI/DLS playback gets DMUS_E_NOT_FOUND / E_NOTIMPL from the port APIs, the same
 * outcome as a machine with no synthesizer port.
 */

import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Mem } from "../../core/memory/mem-accessor";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { dmusicModule } from "../../api/dmusic.api";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { ComObjectFactory, BaseComObject } from "../../core/com/base-com-object";
import { bytesToGuid } from "../ddraw/helpers";

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001;
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const DMUS_E_NOT_FOUND = 0x88780134;

export const CLSID_DIRECTMUSIC = "636b9f10-0c7d-11d1-95b2-0020afdc7421";
export const IID_IDIRECTMUSIC = "6536115a-7b2d-11d2-ba18-0000f875ac12";
export const IID_IDIRECTMUSIC2 = "6fc2cae1-bc78-11d2-afa6-00aa0024d8b6";
export const IID_IDIRECTMUSIC8 = "2d3629f7-813d-4939-8508-f05c6b75fd97";

const KNOWN_IIDS = new Set([
    "00000000-0000-0000-c000-000000000046",
    IID_IDIRECTMUSIC,
    IID_IDIRECTMUSIC2,
    IID_IDIRECTMUSIC8,
]);

class DirectMusicObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IDIRECTMUSIC2, vtableAddress);
    }

    protected destroy(): void {}
}

export class DMusic implements IModule {
    name = "dmusic";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;
        InterfaceRegistry.getInstance().registerFromModuleDescriptor(dmusicModule);
        this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);
        ComObjectFactory.register(IID_IDIRECTMUSIC2, DirectMusicObject);
        this.registerExports();
    }

    reset(): void {}

    recreateVTables(): void {
        if (this.process) this.vtables = createVTablesFromDescriptor(this.process, dmusicModule);
    }

    registerExports(): void {
        const writePtr = (mem: Uint8Array, addr: number, value: number): void => {
            if (addr && addr + 4 <= mem.length) Mem.writeUint32(addr, value);
        };

        this.exports["IDirectMusic2_QueryInterface"] = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const riid = args[1] >>> 0;
            const ppv = args[2] >>> 0;
            if (!ppv || !riid || riid + 16 > mem.length) return E_POINTER;
            const iid = bytesToGuid(mem.slice(riid, riid + 16)).replace(/[{}]/g, "").toLowerCase();
            if (KNOWN_IIDS.has(iid)) {
                writePtr(mem, ppv, thisPtr);
                return S_OK;
            }
            writePtr(mem, ppv, 0);
            Logger.log(LogCategory.COM, `IDirectMusic::QueryInterface(${iid}) -> E_NOINTERFACE`);
            return E_NOINTERFACE;
        };
        this.exports["IDirectMusic2_AddRef"] = () => 1;
        this.exports["IDirectMusic2_Release"] = () => 0;

        this.exports["IDirectMusic2_EnumPort"] = (_ctx, _mem, args) => {
            Logger.verbose(LogCategory.COM, `IDirectMusic::EnumPort(${args[1]}) -> S_FALSE (no ports)`);
            return S_FALSE;
        };
        this.exports["IDirectMusic2_CreateMusicBuffer"] = (_ctx, mem, args) => {
            writePtr(mem, args[2] >>> 0, 0);
            return E_NOTIMPL;
        };
        this.exports["IDirectMusic2_CreatePort"] = (_ctx, mem, args) => {
            writePtr(mem, args[3] >>> 0, 0);
            Logger.log(LogCategory.COM, `IDirectMusic::CreatePort -> DMUS_E_NOT_FOUND (no ports)`);
            return DMUS_E_NOT_FOUND;
        };
        this.exports["IDirectMusic2_EnumMasterClock"] = () => S_FALSE;
        this.exports["IDirectMusic2_GetMasterClock"] = (_ctx, mem, args) => {
            writePtr(mem, args[2] >>> 0, 0);
            return E_NOTIMPL;
        };
        this.exports["IDirectMusic2_SetMasterClock"] = () => S_OK;
        this.exports["IDirectMusic2_Activate"] = () => S_OK;
        this.exports["IDirectMusic2_GetDefaultPort"] = () => DMUS_E_NOT_FOUND;
        this.exports["IDirectMusic2_SetDirectSound"] = () => S_OK;
        this.exports["IDirectMusic2_SetExternalMasterClock"] = () => S_OK;
    }
}
