/**
 * `LIST DMRF` — a reference from one DirectMusic object to another (a segment's style, a
 * band instrument's DLS collection). It carries the fields of a DMUS_OBJECTDESC; the loader
 * that owns the load resolves it.
 */
import { type RiffChunk, dataView, guidString, riffChunks, wideString } from "./riff";

export const DMUS_OBJ_OBJECT = 1 << 0;
export const DMUS_OBJ_CLASS = 1 << 1;
export const DMUS_OBJ_NAME = 1 << 2;
export const DMUS_OBJ_CATEGORY = 1 << 3;
export const DMUS_OBJ_FILENAME = 1 << 4;
export const DMUS_OBJ_FULLPATH = 1 << 5;
export const DMUS_OBJ_URL = 1 << 6;
export const DMUS_OBJ_VERSION = 1 << 7;
export const DMUS_OBJ_DATE = 1 << 8;
export const DMUS_OBJ_LOADED = 1 << 9;
export const DMUS_OBJ_MEMORY = 1 << 10;

export interface ObjectReference {
    /** DMUS_OBJ_* bits for the fields that were present. */
    validData: number;
    classId: string;
    objectId: string;
    name: string;
    category: string;
    fileName: string;
    versionMS: number;
    versionLS: number;
}

export function parseReference(buf: Uint8Array, list: RiffChunk): ObjectReference {
    const view = dataView(buf);
    const ref: ObjectReference = {
        validData: 0, classId: "", objectId: "", name: "", category: "", fileName: "", versionMS: 0, versionLS: 0,
    };
    for (const c of riffChunks(buf, list.start, list.end)) {
        const size = c.end - c.start;
        if (c.id === "refh" && size >= 20) {
            ref.classId = guidString(buf, c.start);
            ref.validData |= DMUS_OBJ_CLASS;
        } else if (c.id === "guid" && size >= 16) {
            ref.objectId = guidString(buf, c.start);
            ref.validData |= DMUS_OBJ_OBJECT;
        } else if (c.id === "name") {
            ref.name = wideString(buf, c);
            ref.validData |= DMUS_OBJ_NAME;
        } else if (c.id === "file") {
            ref.fileName = wideString(buf, c);
            ref.validData |= DMUS_OBJ_FILENAME;
        } else if (c.id === "catg") {
            ref.category = wideString(buf, c);
            ref.validData |= DMUS_OBJ_CATEGORY;
        } else if (c.id === "vers" && size >= 8) {
            ref.versionMS = view.getUint32(c.start, true);
            ref.versionLS = view.getUint32(c.start + 4, true);
            ref.validData |= DMUS_OBJ_VERSION;
        }
    }
    return ref;
}

/** The identity chunks every DirectMusic object file may carry at its top level. */
export interface ObjectIdentity {
    objectId: string;
    name: string;
    versionMS: number;
    versionLS: number;
    hasVersion: boolean;
}

export function parseIdentity(buf: Uint8Array, root: RiffChunk): ObjectIdentity {
    const view = dataView(buf);
    const id: ObjectIdentity = { objectId: "", name: "", versionMS: 0, versionLS: 0, hasVersion: false };
    for (const c of riffChunks(buf, root.start, root.end)) {
        if (c.id === "guid" && c.end - c.start >= 16) {
            id.objectId = guidString(buf, c.start);
        } else if (c.id === "vers" && c.end - c.start >= 8) {
            id.versionMS = view.getUint32(c.start, true);
            id.versionLS = view.getUint32(c.start + 4, true);
            id.hasVersion = true;
        } else if (c.id === "LIST" && c.type === "UNFO") {
            for (const u of riffChunks(buf, c.start, c.end)) {
                if (u.id === "UNAM") id.name = wideString(buf, u);
            }
        }
    }
    return id;
}
