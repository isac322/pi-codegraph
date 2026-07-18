# @isac322/pi-codegraph

CodeGraph tools for Pi and OMP, with worktree-aware index lifecycle management.

## Why this package

The extension exposes CodeGraph's structural tools with native Pi metadata and rendering while keeping OMP on its native MCP path. Indexes are separated per worktree, stored centrally, synchronized automatically, identity-checked, and garbage-collected after worktrees disappear.

## Install

```sh
pi install npm:@isac322/pi-codegraph
```

OMP loads the package-local `.mcp.json` and `omp.extensions` entry. Pi loads `pi.extensions` and starts the internal MCP facade at session start, never during extension discovery.

The package installs `@colbymchenry/codegraph` as an optional dependency and falls back to a `codegraph` executable on `PATH`.

## Tools

- `codegraph_explore`: broad architecture and flow exploration
- `codegraph_search`: symbol-name lookup
- `codegraph_node`: one known symbol and its relationships
- `codegraph_files`: indexed project structure
- `codegraph_callers`: inbound calls
- `codegraph_callees`: outbound calls
- `codegraph_impact`: transitive change impact
- `codegraph_status`: CodeGraph index health

Pi adds compact call/result rendering and `/codegraph status|sync|doctor|gc`.

## Worktrees

Each worktree gets a distinct database. New indexes are stored under the configured central index store and exposed to CodeGraph through the worktree's `.codegraph` symlink. Existing real `.codegraph` directories remain in place and receive identity metadata.

A project path is accepted only when it is inside an allowed root or resolves to a worktree with the same Git common directory as the session root. Repository and worktree identities are checked before an index is reused. Missing or replaced worktrees fail closed.

## Configuration

Global configuration is read from `~/.config/pi-codegraph/config.json`, or from `PI_CODEGRAPH_CONFIG`.

```json
{
  "autoSync": true,
  "autoGc": true,
  "indexStore": "/home/me/.cache/pi-codegraph",
  "workerIdleTimeoutMs": 300000,
  "maxWorkers": 6,
  "requestTimeoutMs": 30000,
  "syncMinIntervalMs": 15000,
  "maxOutputChars": 60000,
  "allowedProjectRoots": ["/work/company"],
  "promptInjection": true,
  "codegraphExecutable": ""
}
```

Environment overrides:

- `PI_CODEGRAPH_AUTO_SYNC`
- `PI_CODEGRAPH_AUTO_GC`
- `PI_CODEGRAPH_INDEX_STORE`
- `PI_CODEGRAPH_WORKER_IDLE_MS`
- `PI_CODEGRAPH_MAX_WORKERS`
- `PI_CODEGRAPH_REQUEST_TIMEOUT_MS`
- `PI_CODEGRAPH_SYNC_MIN_INTERVAL_MS`
- `PI_CODEGRAPH_MAX_OUTPUT_CHARS`
- `PI_CODEGRAPH_ALLOWED_ROOTS`
- `PI_CODEGRAPH_PROMPT_INJECTION`
- `PI_CODEGRAPH_EXECUTABLE`

`PI_CODEGRAPH_ALLOWED_ROOTS` uses the platform path delimiter.

## Runtime behavior

- Pi defers process startup until `session_start` and closes all resources on `session_shutdown`.
- OMP uses one package-local MCP facade and project-scoped CodeGraph workers.
- Workers are capped, evicted by least-recently-used idle order, and terminated after the idle timeout.
- Tool cancellation and timeout propagate to the worker. Diagnostics are ANSI-stripped, size-limited, and redact common token and secret forms.
- `codegraph_files` accepts absolute in-project paths and `~`, normalizing them to repo-relative POSIX prefixes.
- Large results are bounded and retain both their beginning and end with an explicit truncation marker.

## Security

Pi checks project trust before initialization or tool execution. The MCP facade resolves real paths and restricts access to the active workspace, sibling worktrees of the same repository, and explicitly configured roots.

## Pi package gallery

The npm package declares the `pi-package` keyword and an explicit `pi.extensions` manifest. After npm publication, Pi's package gallery can index it at [pi.dev/packages](https://pi.dev/packages).

Releases use npm trusted publishing from `.github/workflows/publish.yml`. Configure the npm trusted publisher for repository `isac322/pi-codegraph` and workflow `publish.yml`, then publish a GitHub Release.

## License

MIT
