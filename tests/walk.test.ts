import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walk } from "../cli/optimize";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "walk-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const photo = async (path: string) => {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), "not really a jpeg, but walk only stats");
};

const paths = async () => (await walk(root)).map(j => j.relativePath);

describe("walk", () => {
  it("finds plain files and mirrors their relative paths", async () => {
    await photo("a.jpg");
    await photo("sub/b.JPEG");
    expect(await paths()).toEqual(["a.jpg", "sub/b.JPEG"]);
  });

  it("ignores unsupported extensions and dotfiles", async () => {
    await photo("keep.jpg");
    await photo("notes.txt");
    await photo(".hidden.jpg");
    expect(await paths()).toEqual(["keep.jpg"]);
  });

  it("follows a symlinked file", async () => {
    // entry.isFile() is false for a symlink, so a Dirent-only check drops
    // these silently — which is how a client's photo goes missing.
    await photo("real/direct.jpg");
    await symlink(join(root, "real/direct.jpg"), join(root, "linked.jpg"));
    expect(await paths()).toEqual(["linked.jpg", "real/direct.jpg"]);
  });

  it("follows a symlinked directory", async () => {
    await photo("real/direct.jpg");
    await symlink(join(root, "real"), join(root, "linked-dir"));
    expect(await paths()).toEqual(["linked-dir/direct.jpg", "real/direct.jpg"]);
  });

  it("keeps both copies when a folder is reachable two ways", async () => {
    // The guard must not dedupe by resolved path: whichever route the OS
    // listed second would lose its photos entirely.
    await photo("real/a.jpg");
    await photo("real/b.jpg");
    await symlink(join(root, "real"), join(root, "alias"));
    expect(await paths()).toEqual([
      "alias/a.jpg",
      "alias/b.jpg",
      "real/a.jpg",
      "real/b.jpg",
    ]);
  });

  it("terminates on a symlink loop", async () => {
    await photo("real/direct.jpg");
    await symlink(root, join(root, "real/loop"));
    await expect(paths()).resolves.toEqual(["real/direct.jpg"]);
  });

  it("skips a broken symlink rather than throwing", async () => {
    await photo("good.jpg");
    await symlink(join(root, "nope.jpg"), join(root, "broken.jpg"));
    await expect(paths()).resolves.toEqual(["good.jpg"]);
  });
});
