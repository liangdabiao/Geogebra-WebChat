# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

GeoChat Web is a browser-based math/geometry tutoring app: user describes a problem, AI generates GeoGebra commands, and a live GeoGebra canvas renders the result.

### Stack
- **Frontend**: SolidJS + Vite (vite-plugin-solid)
- **AI**: Vercel `ai` SDK v6 (`streamText` + `tool` + `stopWhen(stepCountIs(6))`), provider `@ai-sdk/openai`
- **Markdown rendering**: `marked`
- **GeoGebra**: Official CDN (`deployggb.js`), no vendor files
- **Backend**: Single-file Bun proxy (`server/proxy.ts`) for CORS + host whitelist + optional server-side API key injection; serves `dist/` in production

### Key files
- `src/App.tsx` — Main layout: topbar (API key + model inputs), split-pane with GeoGebra canvas + chat panel
- `src/ai-client.ts` — `runChat()` sets up `streamText` with two tools (`executeGeoGebraCommands`, `resetCanvas`). Provider fetch is redirected through `/api/llm-proxy` for CORS
- `src/geogebra.ts` — Loads deployggb.js from CDN, creates GGBApplet, exposes `GeoGebraController` with `executeCommands`, `reset`, `setPerspective`, `getXML`
- `src/lib/normalize.ts` — Maps Chinese command aliases to GeoGebra 5 English commands (e.g. "中点" → "Midpoint"), normalizes lowercase point definitions
- `server/proxy.ts` — Bun single-file proxy: forwards POST to `/api/llm-proxy`, validates against `ALLOWED_HOSTS`, can inject `MODEL_API_KEY` from env

### Core flow
1. User types a math/geometry problem → `App.sendMessage()` pushes to message list
2. `runChat()` calls `streamText` with tool definitions; model auto-cycles up to 6 steps (`stopWhen: stepCountIs(6)`)
3. Model calls `executeGeoGebraCommands` → commands normalized via `normalize.ts` → executed on the GeoGebra API → XML snapshot returned to model
4. Text deltas stream into chat panel via `marked` rendering
5. Loop continues until model produces explanatory text or max steps reached

## Commands

```sh
# Install dependencies
bun install

# Dev mode (two terminals needed):
bun run proxy        # Terminal 1: LLM proxy on :8787
bun run dev          # Terminal 2: Vite dev server on :5173

# Production:
bun run build        # Outputs dist/
bun run start        # Serves dist/ + /api/llm-proxy on :8787

# Type checking (no emit)
bun run typecheck
```

- Vite dev server proxies `/api/*` to `localhost:8787` (configured in `vite.config.ts`)
- Set `MODEL_API_KEY=sk-...` env var before starting proxy to inject server-side key (frontend can leave key field empty)

## Provider switching

`ai-client.ts` uses `@ai-sdk/openai`. To switch provider: import the corresponding `@ai-sdk/*` package, change the `createOpenAI` call, and ensure the target host is in `ALLOWED_HOSTS` in `server/proxy.ts`. The proxy treats all providers identically.
