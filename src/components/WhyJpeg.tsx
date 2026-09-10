/**
 * The recommendation is counterintuitive enough that, without a sentence of
 * justification, the natural reaction is that the tool is broken.
 */
export default function WhyJpeg() {
  return (
    <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <summary className="cursor-pointer font-medium">
        Why JPEG, and not WebP or AVIF?
      </summary>
      <div className="mt-3 space-y-3 text-neutral-600 dark:text-neutral-400">
        <p>
          Because Wix re-encodes every image on delivery. Any URL with a{" "}
          <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">
            /v1/
          </code>{" "}
          transform in it — which is all of them, on a real site — gets decoded
          and encoded again, even at the source's own native size. A 5000×2184
          asset measured at 4,889,258 bytes as the stored original comes back
          from that transform at 1,502,892 bytes: same pixels, 31% of the
          weight.
        </p>
        <p>
          So uploading WebP or AVIF buys nothing. Wix converts to AVIF on the
          way out regardless, and feeding an already-lossy file into that
          encoder just stacks one generation of damage on another. The same
          logic caps how hard it is worth compressing here.
        </p>
        <p>
          The saving comes from <strong>pixels, not compression</strong>. Wix
          caps device pixel ratio at 2 and clamps every transform at 5000px, so
          a photo wider than about 3840px has detail that literally cannot be
          requested — you are paying storage for it and no visitor will ever
          receive it.
        </p>
      </div>
    </details>
  );
}
