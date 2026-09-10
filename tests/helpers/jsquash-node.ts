/**
 * Run the browser codecs under Node, for the parity test.
 *
 * jSquash resolves its `.wasm` files by URL and fetches them, which is right
 * in a browser and impossible in Node. Both families of module accept the
 * bytes directly instead — wasm-bindgen through its init argument, Emscripten
 * through `wasmBinary` — so this reads them off disk and hands them over.
 *
 * Test-only. Nothing here ships in the bundle.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * jSquash's codecs need `ImageData`, which Node has no reason to provide.
 * Only the three properties they read are needed.
 */
class NodeImageData {
  readonly colorSpace = "srgb" as const;
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number
  ) {}
}

let ready: Promise<void> | undefined;

export function initJsquashForNode(): Promise<void> {
  ready ??= (async () => {
    (globalThis as Record<string, unknown>).ImageData ??= NodeImageData;

    const bytes = (specifier: string) =>
      readFile(require.resolve(specifier));

    const { initResize } = await import("@jsquash/resize");
    await initResize(
      await WebAssembly.compile(
        await bytes("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm")
      )
    );

    const { init: initJpegEncode } = await import("@jsquash/jpeg/encode.js");
    await initJpegEncode({
      wasmBinary: await bytes("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"),
    });
  })();
  return ready;
}
