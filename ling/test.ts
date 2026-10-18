import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../packages/omo-opencode/src/v2/orchestration.test.ts")],
  outdir: resolve(import.meta.dir, ".test"),
  target: "bun",
  external: ["bun:test"],
  plugins: [{ name: "standalone-test-dependencies", setup(build) {
    build.onResolve({ filter: /^zod$/ }, args => ({
      path: fileURLToPath(import.meta.resolve(args.path)),
    }))
  } }],
})
if (!result.success) throw new AggregateError(result.logs, "test build failed")
process.exit(await Bun.spawn([process.execPath, "test", result.outputs[0].path], { stdout: "inherit", stderr: "inherit" }).exited)
