# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The full
development chronology lives in `WORKLOG.md`.

## [Unreleased]

### Added

- Infrastructure layer for the MCP server: configuration contract (24 `X_MCP_*` environment
  variables with defaults and validation), two-axis policy engine (12 `operation:domain` cells,
  five presets, deny > allow > preset), session credit budget (`warn`/`hard`), the
  registry-as-data tool contract (`ToolDef`), the host-scoped HTTP client with rate-limit
  tracking, the error taxonomy, and the render/resolve/paginate helpers.
- Packaging and presentation layer: `README`, `SECURITY`, `CONTRIBUTING`, this changelog,
  the MCP Registry manifest (`server.json`), and repository metadata in `package.json`
  (`mcpName`, `repository`, `homepage`, `bugs`, `keywords`, `trademark`).
- Continuous integration (build/lint/format/test on Node 22 and 24), CodeQL scanning, and
  Dependabot for npm and GitHub Actions.

### Notes

- Pre-1.0. The user-facing tool surface (50 tools across 12 packages) is designed in
  `docs/03-tool-catalog.md` and is being implemented package by package; not all tools are
  shipped yet. The public API is unstable until `1.0.0` — pin an exact version.
