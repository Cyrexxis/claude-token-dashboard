import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function entrySource(repo: string, files: string[]): string {
  const imports = files.map(
    (f, i) => `import f${i} from "${repo}/web/dist/${f}" with { type: "file" };`,
  );
  const map = files.map((f, i) => `"/${f}": f${i}`).join(", ");
  return [
    `import { setEmbeddedWeb } from "${repo}/server/src/embedded.ts";`,
    ...imports,
    `setEmbeddedWeb({ ${map} });`,
    `await import("${repo}/server/src/cli.ts"); // dynamic: cli.ts runs main() on load, after the line above`,
    "",
  ].join("\n");
}

function run(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

function main() {
  const repo = resolve(import.meta.dir, "..");
  const arg = (name: string, dflt: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
  };
  // a literal "--" passed through by `bun run` is ignored: only named flags are read
  const targets = arg("--targets", "linux-x64,linux-arm64").split(",");
  const out = resolve(repo, arg("--out", "dist/release"));

  run(["bun", "run", "build:web"], repo);
  const webDist = join(repo, "web/dist");
  const files = (readdirSync(webDist, { recursive: true }) as string[])
    .filter((f) => statSync(join(webDist, f)).isFile())
    .map((f) => f.split("\\").join("/"))
    .sort();
  const entry = join(repo, "dist/build/entry.ts");
  mkdirSync(join(repo, "dist/build"), { recursive: true });
  writeFileSync(entry, entrySource(repo, files));
  mkdirSync(out, { recursive: true });

  const sums: string[] = [];
  for (const t of targets) {
    const name = `token-dashboard-${t}`;
    run(
      ["bun", "build", "--compile", `--target=bun-${t}`, entry, "--outfile", join(out, name)],
      repo,
    );
    const h = new Bun.CryptoHasher("sha256");
    h.update(readFileSync(join(out, name)));
    sums.push(`${h.digest("hex")}  ${name}`);
  }
  writeFileSync(join(out, "checksums.txt"), `${sums.join("\n")}\n`);
}

if (import.meta.main) main();
