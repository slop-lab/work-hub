import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const bootstrap = resolve("scripts/ci/bootstrap-node.bash");
function fixture(version: string) {
  const root = mkdtempSync(join(tmpdir(), "work-hub-node-test-"));
  const source = join(root, "source"), bin = join(root, "bin"), tools = join(root, "tools");
  mkdirSync(source); mkdirSync(bin);
  writeFileSync(join(source, ".node-version"), "24.22.1\n");
  copyFileSync(bootstrap, join(source, "bootstrap.bash"));
  writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  return { root, source, bin, tools };
}
function invoke(source: string, bin: string, tools: string) {
  return spawnSync("/bin/bash", ["-euo", "pipefail", "-c", 'source ./bootstrap.bash; work_hub_ci_bootstrap_node "$1"', "ci-node-test", tools], {
    cwd: source, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
  });
}
test("exact Node24.22.1 needs no download or generated tool directory", () => {
  const value = fixture("24.22.1");
  try {
    writeFileSync(join(value.bin, "curl"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const result = invoke(value.source, value.bin, value.tools);
    assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(value.tools), false);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
test("a mismatched Node cannot execute an archive that fails the reviewed checksum", () => {
  const value = fixture("26.12.1");
  try {
    writeFileSync(join(value.bin, "curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf invalid-archive > "$1"; exit 0; fi; shift; done\nexit 92\n', { mode: 0o755 });
    const result = invoke(value.source, value.bin, value.tools);
    assert.notEqual(result.status, 0); assert.equal(existsSync(join(value.tools, "node")), false);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
test("bootstrap refuses tool generation inside the reviewed source tree", () => {
  const value = fixture("26.12.1");
  try {
    const tools = join(value.source, "generated-tools"), result = invoke(value.source, value.bin, tools);
    assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /outside the authoritative source checkout/);
    assert.equal(existsSync(tools), false);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("metadata-free source indexes ignored reviewed inputs before npm creates derived files", () => {
  const value = fixture("24.22.1");
  try {
    mkdirSync(join(value.source, "scripts/ci"), { recursive: true });
    copyFileSync(resolve("scripts/ci/source.bash"), join(value.source, "scripts/ci/source.bash"));
    copyFileSync(bootstrap, join(value.source, "scripts/ci/bootstrap-node.bash"));
    writeFileSync(join(value.source, ".gitignore"), "ignored-input.txt\nnode_modules/\n");
    writeFileSync(join(value.source, "ignored-input.txt"), "reviewed input\n");
    writeFileSync(join(value.bin, "npm"), '#!/bin/sh\ngit ls-files > "$INDEX_CAPTURE"\nmkdir -p node_modules\nprintf derived > node_modules/generated\n', { mode: 0o755 });
    const capture = join(value.root, "indexed.txt");
    const result = spawnSync("/bin/bash", ["scripts/ci/source.bash"], { cwd: value.source, encoding: "utf8", env: {
      ...process.env, PATH: `${value.bin}:${process.env["PATH"] ?? ""}`, INDEX_CAPTURE: capture,
    } });
    assert.equal(result.status, 0, result.stderr);
    const indexed = readFileSync(capture, "utf8");
    assert.match(indexed, /^ignored-input\.txt$/m); assert.match(indexed, /^scripts\/ci\/bootstrap-node\.bash$/m);
    assert.equal(indexed.includes("node_modules"), false);
    assert.equal(existsSync(join(value.source, ".git")), false);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
