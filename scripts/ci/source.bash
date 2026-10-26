#!/usr/bin/env bash
set -euo pipefail

# DIM runs the verified script copy with this repository checkout as its cwd.
# Keep source verification independent of browser runtime installation.
npm ci --no-audit --no-fund
npm run quality
