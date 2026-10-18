import { copyFile, readFile, appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = import.meta.dir
const result = await Bun.build({
  entrypoints: [resolve(root, "index.ts")],
  outdir: root,
  target: "bun",
  format: "esm",
  minify: false,
  plugins: [{ name: "standalone-dependencies", setup(build) {
    build.onResolve({ filter: /^(@opencode\/plugin|zod)$/ }, args => ({
      path: fileURLToPath(import.meta.resolve(args.path)),
    }))
  } }],

})
if (!result.success) throw new AggregateError(result.logs, "omo-ling build failed")
for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]) {
  await copyFile(resolve(root, "..", file), resolve(root, file))
}
await appendFile(resolve(root, "THIRD-PARTY-NOTICES.md"),
  "\n\n## Bundled Zod 4.6.5\n\n" + await readFile(resolve(root, "node_modules/zod/LICENSE"), "utf8"))
await appendFile(resolve(root, "THIRD-PARTY-NOTICES.md"),
  "\n\n## Bundled Effect 4.0.1\n\n" + await readFile(resolve(root, "node_modules/effect/LICENSE"), "utf8") +
  "\n\n## Bundled @opencode/schema 2.0.32\n\n" + await readFile(resolve(root, "OPENCODE-LICENSE.txt"), "utf8"))
console.log(`Built omo-ling: ${result.outputs.map(o => o.size).join(", ")} bytes`)
