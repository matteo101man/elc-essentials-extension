# Contributing to ELC Essentials

Thank you for helping improve this project. The maintainers welcome pull requests, bug reports, and feature ideas from students and developers.

## Before you start

1. Read the [README](README.md), especially **Project layout** and **Run locally for testing**.
2. Load the extension unpacked in Chrome or Firefox and confirm your change works on a UGA D2L or Athena page.
3. Keep changes focused. One feature or fix per pull request is easier to review.

## Code style

This repository uses plain JavaScript with no bundler. Match the existing style in the file you edit:

- `'use strict'` and four-space indentation in `content.js`
- Descriptive function names (`showTasksPage`, `parseGradesTable`)
- HTML built from template strings; user-facing text passed through `escapeHtml()` where needed
- Prefer extending existing helpers over duplicating logic

## Where to edit

| Goal | Start here |
|------|------------|
| New D2L UI page or nav tab | `content.js` → `injectNavTab()`, `takeover()` |
| Practice test behavior | `content.js` → functions prefixed with `show`, `render`, or `pt-` |
| Course schedule / Athena | `content.js` → `showCourseSchedulePage`, `injectAthenaImportButton` |
| Tasks aggregation | `content.js` → `showTasksPage`, `fetchTasksForSingleCourse` |
| Grade calculator | `content.js` → `initGradeCalculator`, `showGradeCalculatorUI` |
| Cross-origin requests | `background.js` |
| Enable/disable toggle | `popup.html`, `popup.js` |
| Permissions or version | `manifest.json` and `manifest-firefox.json` (keep versions in sync) |

## Pull request checklist

- [ ] Tested locally with **Load unpacked** (no store publish required)
- [ ] Version bumped in both manifests if you are preparing a release
- [ ] No secrets committed (OpenAI keys stay in browser storage only)
- [ ] README updated if you add a user-visible feature

## Project maintainer

Primary maintainer: [@exearthur](https://github.com/exearthur)

For questions about direction or releases, open a GitHub issue or contact the maintainer.
