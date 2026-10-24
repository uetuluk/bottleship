import { expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";

test("rect clears and padded color passes share the bound oversized depth surface", () => {
    const pixels = new Float32Array(5 * 4);
    const boundView = { pixels };
    const depth = { width: 5, height: 4, format: "depth24plus-stencil8", sampleCount: 1,
        texture: { width: 5, height: 4 }, view: boundView };
    const device = Object.create(D3D9Device.prototype) as any;
    let scratchAllocations = 0, clears = 0;
    const overrides = {
        gpuGone: false, role: "local", depthTextureIndex: null, activeStandaloneDepthSurface: 123,
        renderTargetIndices: [1], frameSnapshot: {},
        activeRenderTargetSampleCount: () => 1,
        standaloneDepthBinding: () => depth,
        ensureStandaloneDepthSurface: () => depth,
        activeDepthTargetFormat: () => depth.format,
        activeRenderScale: () => 1,
        getCurrentTargetSize: () => ({ w: 3, h: 2 }),
        getRtDepthView: () => { scratchAllocations++; return { pixels: new Float32Array(6) }; },
        submitFrame: () => {}, getGdiContext: () => null,
        backendExecutor: {
            clearDepthStencilRect(view: typeof boundView, _format: string, w: number, h: number,
                rect: { left: number; top: number; right: number; bottom: number }, z: number) {
                clears++;
                expect(view).toBe(boundView);
                expect([w, h]).toEqual([5, 4]);
                for (let y = rect.top; y < rect.bottom; y++) for (let x = rect.left; x < rect.right; x++) view.pixels[y * w + x] = z;
                return true;
            },
        },
    };
    for (const [name, value] of Object.entries(overrides)) {
        Object.defineProperty(device, name, { value, writable: true, configurable: true });
    }
    const passDepth = device.resolveDepthAttachment(3, 2, 1, true);
    expect(passDepth.view).toBe(boundView);
    expect(device.clearTargetRects([{ left: 1, top: 0, right: 3, bottom: 2 }], 0, 2, 1, 0)).toBe(true);
    expect(clears).toBe(1);
    expect(scratchAllocations).toBe(0);
    expect([...pixels]).toEqual([0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});
