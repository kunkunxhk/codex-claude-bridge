import fs from "node:fs/promises";
import path from "node:path";

const rootFiles = new Set(["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", ".gitignore", "run.cmd", "install.cmd", "configure.cmd", "doctor.cmd", "test.cmd", "uninstall.cmd"]);
const directories = new Set(["src", "bin", "test", "docs", "vendor", "skills"]);
export async function distributionFiles(root) {
  const files = [];
  async function walk(relative) {
    const full = path.join(root, relative), info = await fs.lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Refusing to distribute a filesystem link: ${relative}`);
    if (info.isDirectory()) {
      for (const child of await fs.readdir(full)) await walk(path.join(relative, child));
    } else if (info.isFile()) files.push(relative.split(path.sep).join("/"));
  }
  for (const name of await fs.readdir(root)) if (rootFiles.has(name) || directories.has(name)) await walk(name);
  return files.sort();
}
