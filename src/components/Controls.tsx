import {
  PRESETS,
  WIX_MAX_LONG_EDGE,
  type EncodeSettings,
  type OutputFormat,
  type PresetId,
} from "../lib/presets";

interface Props {
  presetId: PresetId;
  suffix: string;
  overrides: Partial<EncodeSettings>;
  settings: EncodeSettings;
  disabled: boolean;
  onChange: (next: {
    presetId?: PresetId;
    suffix?: string;
    overrides?: Partial<EncodeSettings>;
  }) => void;
}

export default function Controls({
  presetId,
  suffix,
  overrides,
  settings,
  disabled,
  onChange,
}: Props) {
  const set = (patch: Partial<EncodeSettings>) =>
    onChange({ overrides: { ...overrides, ...patch } });

  return (
    <section className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map(preset => {
          const active = preset.id === presetId;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ presetId: preset.id, overrides: {} })}
              className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
                active
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{preset.label}</span>
                <span className="tnum text-xs text-neutral-500">
                  {preset.settings.maxLongEdge}px
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                {preset.blurb}
              </p>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">
            Filename suffix
          </span>
          <input
            type="text"
            value={suffix}
            disabled={disabled}
            placeholder="none"
            onChange={e => onChange({ suffix: e.target.value })}
            className="mt-1 w-48 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <p className="pb-1 text-xs text-neutral-500">
          <code>DSC_0918.JPG</code> →{" "}
          <code>
            dsc-0918
            {suffix
              ? `-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
              : ""}
            .{settings.format === "jpeg" ? "jpg" : settings.format}
          </code>
        </p>
      </div>

      <details className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <summary className="cursor-pointer text-sm font-medium">
          Advanced
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Format">
            <select
              value={settings.format}
              disabled={disabled}
              onChange={e => set({ format: e.target.value as OutputFormat })}
              className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="jpeg">JPEG (recommended)</option>
              <option value="webp">WebP</option>
              <option value="avif">AVIF</option>
              <option value="png">PNG (lossless)</option>
            </select>
          </Field>

          <Field label={`Quality — ${settings.quality}`}>
            <input
              type="range"
              min={40}
              max={100}
              value={settings.quality}
              disabled={disabled || settings.format === "png"}
              onChange={e => set({ quality: Number(e.target.value) })}
              className="w-full"
            />
          </Field>

          <Field label={`Longest side — ${settings.maxLongEdge}px`}>
            <input
              type="range"
              min={400}
              max={WIX_MAX_LONG_EDGE}
              step={64}
              value={settings.maxLongEdge}
              disabled={disabled}
              onChange={e => set({ maxLongEdge: Number(e.target.value) })}
              className="w-full"
            />
          </Field>

          <Field label={`Sharpening — ${settings.sharpen.toFixed(1)}`}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={settings.sharpen}
              disabled={disabled}
              onChange={e => set({ sharpen: Number(e.target.value) })}
              className="w-full"
            />
          </Field>

          <Field label="Chroma">
            <select
              value={settings.chroma}
              disabled={disabled || settings.format !== "jpeg"}
              onChange={e =>
                set({ chroma: e.target.value as EncodeSettings["chroma"] })
              }
              className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="4:4:4">4:4:4 — full colour detail</option>
              <option value="4:2:0">4:2:0 — smaller</option>
            </select>
          </Field>
        </div>
        <p className="mt-4 text-xs text-neutral-500">
          Wix clamps every transform at {WIX_MAX_LONG_EDGE}px, so nothing above
          that can ever be served. 4:4:4 matters here specifically because Wix
          re-encodes: colour detail dropped now cannot be recovered later.
        </p>
      </details>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-neutral-600 dark:text-neutral-400">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
