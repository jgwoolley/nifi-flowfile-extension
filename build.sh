#!/bin/bash
npm ci && npm test && npx @vscode/vsce package --no-dependencies