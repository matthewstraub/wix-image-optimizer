/**
 * libheif-js ships no types. Only the surface we use is declared here.
 */
declare module "libheif-js/wasm-bundle" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (result: unknown) => void
    ): void;
  }
  interface HeifDecoder {
    decode(data: Uint8Array): HeifImage[];
  }
  const libheif: { HeifDecoder: new () => HeifDecoder };
  export default libheif;
}
