# omo-ling

OpenCode plugin for LING Studio. Maintained at https://github.com/aqcool/omo-ling.

## Install

Requires **OpenCode 2.0.32**. Until npm publication, build a fixed commit with the recipe below, copy the resulting `ling/dist/` directory to a permanent writable directory, and add that absolute directory through the selected OpenCode:

```sh
/path/to/bundled/opencode plugin add /absolute/path/to/omo-ling/commit
```

Keep a source commit and file digests alongside the copy. Install directories must not be temporary worktrees or signed application resources. Back up the selected configuration before removing the previous `oh-my-openagent` entry. Reconnect and verify `omo-ling` is active.

After the npm version is published, replace the local directory entry with:

```sh
opencode plugin add omo-ling@0.1.0
```

LING users should add the same fixed version through the application's plugin manager, using its bundled OpenCode. Reconnect and check that the plugin is **active**. An installed configuration entry alone is not proof of successful loading. Remove the old `oh-my-openagent` entry from the same configuration when switching, preserving other settings.

## Included

- Community port's agent definitions, glob/grep tools, hooks and background task manager.
- Background tasks use the current hosting OpenCode instance, including private `serve --stdio` instances; native child sessions carry the parent's ID.
- Todo RPC persistence in the current host's session metadata; failed reads return an error.
- Host-owned MCP servers and skills; no extra default remote servers or home-directory skill scan.

Goal mode and long-term memory are **not implemented**. The community port's shortened agent prompts and partial hook/tool surface are not equivalent to all features of the original plugin. TUI extensions are not included in this desktop server package. No model-provider defaults or credentials are bundled.

## Reproduce the package

From the repository root, with Node/npm and Bun 1.2.19 or later:

```sh
npm ci --prefix ling --ignore-scripts
cd ling
bun run build
npm pack ./dist --ignore-scripts
python3 qa.py --cli /absolute/path/to/opencode
```

The build produces a standalone `dist/` directory without TypeScript sources or node_modules and bundles runtime dependencies into `index.js`; end users need no install scripts, compiler, or runtime dependency download beyond the package. Build dependencies are pinned in `package-lock.json`. The no-inference QA starts a private OpenCode server with isolated HOME/XDG roots and tests actual loading, agents, todo roundtrip, missing-session errors, and filesystem tools.

Source: `fazulfi/omo-v2` commit `8907576a64e6c1357581033f0195e742946059bc`, itself based on `code-yeongyu/oh-my-openagent` 5.1.4. Sustainable Use License 1.0 and original third-party notices are included. The name change does not change those license terms.
