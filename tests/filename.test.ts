import { describe, expect, it } from "vitest";
import {
  outputFileName,
  outputRelativePath,
  sanitizeDirName,
  slugify,
  splitExtension,
  splitPath,
  uniquePath,
} from "@/lib/filename";

describe("slugify", () => {
  it("lowercases and hyphenates a real client filename", () => {
    expect(slugify("2024-09-SkyMatt-Wedding-Meadowlark-FINALDSC_09180918621")).toBe(
      "2024-09-sky-matt-wedding-meadowlark-finaldsc-09180918621"
    );
  });

  it("breaks camelCase but keeps runs of capitals and digits intact", () => {
    expect(slugify("SkyMatt")).toBe("sky-matt");
    expect(slugify("FINALDSC")).toBe("finaldsc");
    expect(slugify("IMG_09180918621")).toBe("img-09180918621");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugify("Café Münster")).toBe("cafe-munster");
  });

  it("collapses punctuation and trims stray hyphens", () => {
    expect(slugify("  photo (final)__v2!!  ")).toBe("photo-final-v2");
  });

  it("falls back rather than returning an empty name", () => {
    expect(slugify("!!!")).toBe("image");
    expect(slugify("")).toBe("image");
  });
});

describe("splitPath / splitExtension", () => {
  it("separates directories from the filename", () => {
    expect(splitPath("Wedding/ceremony/DSC_1.jpg")).toEqual({
      dirs: ["Wedding", "ceremony"],
      file: "DSC_1.jpg",
    });
  });

  it("refuses to climb out of the output root", () => {
    expect(splitPath("../../etc/passwd.jpg").dirs).toEqual(["etc"]);
    expect(splitPath("./a//b/c.jpg").dirs).toEqual(["a", "b"]);
  });

  it("handles windows separators", () => {
    expect(splitPath("a\\b\\c.jpg")).toEqual({ dirs: ["a", "b"], file: "c.jpg" });
  });

  it("keeps dots inside the stem", () => {
    expect(splitExtension("photo.final.JPG")).toEqual({
      stem: "photo.final",
      ext: "JPG",
    });
  });

  it("treats a dotfile as having no extension", () => {
    expect(splitExtension(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });
});

describe("outputFileName", () => {
  it("applies the suffix and the new extension", () => {
    expect(outputFileName("DSC_0918.JPG", { suffix: "-optimized", ext: "jpg" })).toBe(
      "dsc-0918-optimized.jpg"
    );
  });

  it("accepts a suffix with or without a leading hyphen", () => {
    const a = outputFileName("a.png", { suffix: "-web", ext: "jpg" });
    const b = outputFileName("a.png", { suffix: "web", ext: "jpg" });
    expect(a).toBe("a-web.jpg");
    expect(b).toBe("a-web.jpg");
  });

  it("omits the suffix entirely when it is empty", () => {
    expect(outputFileName("a.png", { suffix: "", ext: "jpg" })).toBe("a.jpg");
  });
});

describe("outputRelativePath", () => {
  it("mirrors the folder tree and only slugifies the filename", () => {
    expect(
      outputRelativePath("Wedding Photos (Grouped)/ceremony/DSC_0918.JPG", {
        suffix: "-optimized",
        ext: "jpg",
      })
    ).toBe("Wedding Photos (Grouped)/ceremony/dsc-0918-optimized.jpg");
  });

  it("handles a file at the root", () => {
    expect(outputRelativePath("a.JPG", { suffix: "", ext: "jpg" })).toBe("a.jpg");
  });
});

describe("sanitizeDirName", () => {
  it("keeps ordinary folder names untouched", () => {
    expect(sanitizeDirName("Wedding Photos (Grouped)")).toBe(
      "Wedding Photos (Grouped)"
    );
  });

  it("replaces path-hostile characters", () => {
    expect(sanitizeDirName('a:b"c|d?e*f')).toBe("a-b-c-d-e-f");
  });

  it("never returns an empty segment", () => {
    expect(sanitizeDirName("...")).toBe("folder");
  });
});

describe("uniquePath", () => {
  it("passes through the first use", () => {
    const taken = new Set<string>();
    expect(uniquePath("a/b.jpg", taken)).toBe("a/b.jpg");
  });

  it("numbers subsequent collisions", () => {
    const taken = new Set<string>();
    expect(uniquePath("a/b.jpg", taken)).toBe("a/b.jpg");
    expect(uniquePath("a/b.jpg", taken)).toBe("a/b-2.jpg");
    expect(uniquePath("a/b.jpg", taken)).toBe("a/b-3.jpg");
  });

  it("keeps two differently-cased sources from overwriting each other", () => {
    const taken = new Set<string>();
    const opts = { suffix: "", ext: "jpg" } as const;
    const first = uniquePath(outputRelativePath("IMG_0001.jpg", opts), taken);
    const second = uniquePath(outputRelativePath("img 0001.JPG", opts), taken);
    expect(first).toBe("img-0001.jpg");
    expect(second).toBe("img-0001-2.jpg");
  });

  it("scopes collisions per folder", () => {
    const taken = new Set<string>();
    expect(uniquePath("x/b.jpg", taken)).toBe("x/b.jpg");
    expect(uniquePath("y/b.jpg", taken)).toBe("y/b.jpg");
  });
});
