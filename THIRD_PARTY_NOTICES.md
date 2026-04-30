# Third-Party Notices

pi-workbench bundles or depends on the open-source software listed below.
Each entry is reproduced under the terms of its own license. The license
texts referenced here can be found in the corresponding package's
`node_modules/<pkg>/LICENSE` (or `LICENCE` / `license.md`) file after
`npm install`.

This file enumerates **direct dependencies**. The full transitive
dependency tree includes hundreds of additional packages; their licenses
are catalogued by your package manager (`npm ls --all` for the tree;
licenses are in each package's directory).

The pi-workbench project itself is licensed under the MIT License — see
[LICENSE](./LICENSE).

## Server runtime dependencies

| Package | Version range | License | Used for |
|---|---|---|---|
| `@fastify/cors` | ^11.0.1 | MIT | CORS support for the dev environment |
| `@fastify/multipart` | ^9.0.3 | MIT | Multipart form parsing (uploads, prompt attachments) |
| `@fastify/rate-limit` | ^10.2.2 | MIT | Per-IP rate limiting on auth routes |
| `@fastify/static` | ^9.1.3 | MIT | Static-serves the built Vite client in production |
| `@fastify/swagger` | ^9.5.0 | MIT | Generates the OpenAPI spec from route schemas |
| `@fastify/swagger-ui` | ^5.2.3 | Apache-2.0 | Serves the interactive Swagger UI at `/api/docs` |
| `@fastify/websocket` | ^11.0.2 | MIT | WebSocket support for the integrated terminal |
| `@mariozechner/pi-agent-core` | latest | MIT | Pi agent core types + Agent class |
| `@mariozechner/pi-ai` | latest | MIT | Pi LLM provider abstraction |
| `@mariozechner/pi-coding-agent` | latest | MIT | Pi coding-agent SDK (AgentSession, SessionManager, etc.) |
| `fastify` | ^5.3.2 | MIT | HTTP server framework |
| `jsonwebtoken` | ^9.0.2 | MIT | JWT signing + verification for browser auth |
| `node-pty` | ^1.0.0 | MIT | Pseudo-terminal native binding for the integrated terminal |
| `tar` | ^7.5.13 | ISC | Streaming gzip-tar of folders for the file-download route |

## Client runtime dependencies

| Package | Version range | License | Used for |
|---|---|---|---|
| `@codemirror/lang-cpp` | ^6.0.2 | MIT | C/C++ language support in the editor |
| `@codemirror/lang-css` | ^6.3.1 | MIT | CSS / SCSS support |
| `@codemirror/lang-html` | ^6.4.9 | MIT | HTML support |
| `@codemirror/lang-java` | ^6.0.1 | MIT | Java support |
| `@codemirror/lang-javascript` | ^6.2.2 | MIT | JS / TS / JSX / TSX support |
| `@codemirror/lang-json` | ^6.0.1 | MIT | JSON support |
| `@codemirror/lang-markdown` | ^6.3.2 | MIT | Markdown support |
| `@codemirror/lang-python` | ^6.1.7 | MIT | Python support |
| `@codemirror/lang-rust` | ^6.0.1 | MIT | Rust support |
| `@codemirror/lang-yaml` | ^6.1.3 | MIT | YAML support |
| `@codemirror/legacy-modes` | ^6.5.2 | MIT | Legacy CodeMirror v5 modes wrapped for v6 (jinja2, shell, toml, dockerfile, properties, lua, perl, r, powershell, ruby, go, swift, kotlin, scala, groovy, csharp, xml, sql, diff, clojure, haskell, ocaml, protobuf, cmake, nginx) |
| `@codemirror/theme-one-dark` | ^6.1.2 | MIT | Editor color theme (dark) |
| `@xterm/addon-fit` | ^0.10.0 | MIT | Terminal auto-fit-to-container addon |
| `@xterm/addon-web-links` | ^0.11.0 | MIT | Auto-detect URLs in terminal output |
| `@xterm/xterm` | ^5.5.0 | MIT | Terminal emulator |
| `codemirror` | ^6.0.1 | MIT | Code editor framework |
| `hash-wasm` | ^4.12.0 | MIT | Streaming SHA-256 in the browser (file upload checksums) |
| `lucide-react` | ^0.503.0 | ISC | Icon set used throughout the UI |
| `prism-react-renderer` | ^2.4.1 | MIT | Syntax highlighting for the diff viewer + raw JSON modal |
| `react` | ^19.1.0 | MIT | UI framework |
| `react-diff-view` | ^3.2.2 | MIT | Diff rendering (unified + side-by-side) |
| `react-dom` | ^19.1.0 | MIT | React DOM renderer |
| `react-markdown` | ^10.1.0 | MIT | Markdown rendering in chat messages |
| `refractor` | ^5.0.0 | MIT | Tokenizer for diff syntax highlighting |
| `remark-gfm` | ^4.0.1 | MIT | GitHub-Flavored Markdown extension for react-markdown |
| `zustand` | ^5.0.3 | MIT | Client-side state management |

## Build / dev dependencies

These are not included in shipped artifacts but are required to build
and develop pi-workbench from source.

### Server

| Package | Version range | License |
|---|---|---|
| `@types/jsonwebtoken` | ^9.0.9 | MIT |
| `@types/node` | ^22.15.2 | MIT |
| `@types/tar` | ^6.1.13 | MIT |
| `@types/ws` | ^8.18.1 | MIT |
| `tsx` | ^4.19.4 | MIT |
| `typescript` | ^5.8.3 | Apache-2.0 |

### Client

| Package | Version range | License |
|---|---|---|
| `@tailwindcss/vite` | ^4.1.4 | MIT |
| `@types/react` | ^19.1.2 | MIT |
| `@types/react-dom` | ^19.1.2 | MIT |
| `@vitejs/plugin-react` | ^4.4.1 | MIT |
| `tailwindcss` | ^4.1.4 | MIT |
| `typescript` | ^5.8.3 | Apache-2.0 |
| `vite` | ^6.3.3 | MIT |
| `vite-plugin-pwa` | ^0.21.1 | MIT |

## Container base images

The Docker image (`docker/Dockerfile`) builds on:

- `node:22-alpine` for both build and runtime stages — Node.js (MIT) on
  Alpine Linux (a mix of MIT, BSD, GPL-2.0 for the kernel, and various
  other licenses for individual packages — see Alpine's own license
  documentation)
- Alpine packages installed at build time: `tini` (MIT), `git` (GPL-2.0),
  `ripgrep` (MIT or Unlicense)

## Fonts and assets

- The header / favicon / PWA icon SVG (`packages/client/public/icons/icon.svg`)
  is original work for this project and falls under the project MIT license.
- The Contributor Covenant 2.1 (referenced in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md))
  is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/);
  full text at <https://www.contributor-covenant.org/>.
- The Developer Certificate of Origin v1.1 (referenced in [CLA.md](./CLA.md))
  is licensed under [CC BY-SA 3.0 US](https://creativecommons.org/licenses/by-sa/3.0/us/);
  full text at <https://developercertificate.org/>.

## License compatibility

All direct dependencies above use licenses compatible with the project's
MIT license:

- **MIT, ISC, BSD-2-Clause, BSD-3-Clause:** permissive, fully compatible
- **Apache-2.0:** permissive with a patent grant; compatible with MIT for
  redistribution under MIT, but the Apache-2.0 NOTICE file (if present in
  the dependency) must be preserved
- **No GPL or AGPL** in the runtime tree. (Alpine ships GPL-licensed
  components in the base image, but those are container-OS-level and do
  not link with the workbench code.)

If you fork pi-workbench and add a dependency under a copyleft license
(GPL, AGPL, LGPL with linking restrictions), update this file and review
whether the project's license needs to change.

## Updates

This file lists dependencies as of the current `main`. Adding or removing a
direct dependency should include an update to this file in the same PR.
The PR template's checklist includes a reminder.

If you spot a missing or incorrect entry, open a PR. Accuracy here matters
for downstream redistributors.
