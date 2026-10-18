import { copyFile, readFile, appendFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = import.meta.dir
const output = resolve(root, "dist")
await mkdir(output, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "index.ts")],
  outdir: output,
  target: "bun",
  format: "esm",
  minify: false,
  plugins: [{ name: "standalone-dependencies", setup(build) {
    build.onResolve({ filter: /^(@opencode\/plugin|zod|yaml)$/ }, args => ({
      path: fileURLToPath(import.meta.resolve(args.path)),
    }))
  } }],

})
if (!result.success) throw new AggregateError(result.logs, "omo-ling build failed")
for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]) {
  await copyFile(resolve(root, "..", file), resolve(output, file))
}
await appendFile(resolve(output, "THIRD-PARTY-NOTICES.md"),
  "\n\n## Bundled Zod 4.6.5\n\n" + await readFile(resolve(root, "node_modules/zod/LICENSE"), "utf8"))
await appendFile(resolve(output, "THIRD-PARTY-NOTICES.md"),
  "\n\n## Bundled Effect 4.0.1\n\n" + await readFile(resolve(root, "node_modules/effect/LICENSE"), "utf8") +
  "\n\n## Bundled @opencode/schema 2.0.32\n\n" + await readFile(resolve(root, "OPENCODE-LICENSE.txt"), "utf8"))
await appendFile(resolve(output, "THIRD-PARTY-NOTICES.md"), "\n\n## Bundled YAML 2.9.1\n\n" + await readFile(resolve(root, "node_modules/yaml/LICENSE"), "utf8"))
await copyFile(resolve(root, "README.md"), resolve(output, "README.md"))
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
delete manifest.scripts
delete manifest.devDependencies
await writeFile(resolve(output, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log(`Built omo-ling: ${result.outputs.map(o => o.size).join(", ")} bytes`)
