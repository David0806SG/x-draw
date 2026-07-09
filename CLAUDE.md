# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

x-draw is a local-first, hand-drawn-style whiteboard: vanilla JavaScript + rough.js, one HTML page,
no build step, no backend, no framework. All user data (scenes) lives in the browser's localStorage —
the repo contains only the app. Live deployment: https://david0806sg.github.io/x-draw/ (GitHub Pages,
serves the `main` branch root; every push to `main` redeploys).

## Commands

```bash
python3 -m http.server 8642        # run locally → http://localhost:8642 (any static server works)
```

- There is no build, lint, or test command. There are no automated tests — verify changes by
  exercising the app in a browser (draw/move/resize, bind an arrow, label a box, undo, reload, export).
- `window.__xdraw` (defined at the end of app.js) exposes `{ state, toScreen, toScene }` in the
  console for debugging and scripted verification.
- **After editing app.js / style.css / fonts.css, bump the `?v=N` query stamps in index.html** —
  browsers cache these assets heuristically and users will otherwise see stale code.

## Architecture (all logic is in app.js, ~1,900 lines)

**Two coordinate systems.** Elements live in *scene* coordinates; the viewport is `state.scroll` +
`state.zoom`. `toScene()`/`toScreen()` convert. Pan/zoom never mutate elements.

**One state object, plain-JSON elements.** `state.elements` is the scene graph — an array of plain
objects (`{id, type, x, y, w, h, points?, text?, angle, strokeColor, ..., seed, v}`). It is what gets
saved, exported, snapshotted for undo, and serialized to `.xdraw` files. Undo/redo = whole-array JSON
snapshots (`pushHistory()` **before** mutating, capped at 100).

**Versioned render cache.** rough.js drawables are cached per element, keyed on the element's version
counter `el.v`. Any geometry/style mutation MUST call `touch(el)` or the canvas keeps showing the old
shape. Rendering is coalesced into one rAF frame via `requestRender()`.

**Pointer input is a flat state machine.** `onPointerDown/Move/Up` drive a single `action` object
(types documented in a comment block near `onPointerDown`: pan/create/draw/move/marquee/resize/rotate/
erase). Multi-point arrow placement is a separate `multiPoint` session, not an action. Two subtleties:
the resize action rewrites its own just-pushed history entry so undo restores pre-resize geometry, and
resizing rotated elements works in the element's local frame then re-anchors the opposite corner.

**Derived geometry — never stored.** Two subsystems recompute positions instead of storing them:
- *Arrow binding*: arrows carry `startBinding`/`endBinding = {elementId}`; `recomputeBoundArrow()`
  pulls endpoints to the shape border (per-type math in `borderPoint()`). Call `updateArrowsBoundTo(ids)`
  from any code path that changes a bindable shape's geometry.
- *Shape labels*: a label is a text element with `containerId`; the container has `labelId`.
  `syncLabel(container)` re-wraps (`rawText` → wrapped `text`), re-centers, and copies rotation. Every
  container-geometry mutation site must call it — grep existing call sites before adding a new path.
  Labels are not independently selectable: clicks redirect to the container, marquee skips them, and
  delete/duplicate/reorder expand through `withLabels()`.

**Persistence.** localStorage keys: `xdraw.scenes` (index), `xdraw.scene.<id>` (element arrays),
`xdraw.thumb.<id>`, `xdraw.lastScene`, `xdraw.theme`. Saves are debounced 400 ms via `scheduleSave()`
and flushed on `beforeunload`. Quota exhaustion is caught and only console-warned — pasted images
(base64 in scene JSON) are the usual cause. Never write code that clears `xdraw.*` keys.

**Dark mode is a CSS filter, not a data change.** `render()` always paints light-mode colors on a
white background; `body.dark` applies `invert(93%) hue-rotate(180deg)` to the canvas element
(style.css). PNG export and `.xdraw` files therefore always use the true stored colors.

**Fonts.** The x-draw handwriting font is vendored in `fonts/` as unicode-range subsets
declared in `fonts.css`; canvas text measurement (`measureText`) depends on it being loaded.

## Repo conventions

- `.gitignore` excludes `*.png`/`*.xdraw` so canvas exports never get committed; repo images go in
  `docs/` (`!docs/*.png` exception).
- `lib/rough.js` is vendored (minified); index.html has an unpkg CDN fallback only if the global is
  missing. Keep the app fully offline-capable.
- High-blast-radius functions — manual browser pass required before merging changes to them:
  `recomputeBoundArrow`, `applyResize` (rotated-anchor math), `syncLabel`.
