import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repositoryRoot, "test/fixtures");
const destinationRoot = resolve(repositoryRoot, "dist/test/fixtures");

async function copyTree(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  const ordered = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const entry of ordered) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Test fixture must not be a symbolic link");
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Test fixture is not a regular file: ${sourcePath}`);
    const sourceRealPath = await realpath(sourcePath);
    if (sourceRealPath !== sourcePath) throw new Error("Test fixture source must not be a link");
    const info = await lstat(sourceRealPath);
    if (info.size <= 0 || info.size > 4 * 1024 * 1024)
      throw new Error("Test fixture is not a bounded regular file");
    const temporaryPath = join(
      dirname(destinationPath),
      `.${basename(destinationPath)}.${process.pid}.tmp`,
    );
    const temporaryInfo = await lstat(temporaryPath).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (temporaryInfo) {
      if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink())
        throw new Error(`Refusing to replace unsafe fixture temporary: ${temporaryPath}`);
      await unlink(temporaryPath);
    }
    try {
      await copyFile(sourceRealPath, temporaryPath, constants.COPYFILE_EXCL);
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

await copyTree(sourceRoot, destinationRoot);
