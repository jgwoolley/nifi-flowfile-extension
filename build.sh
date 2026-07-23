#!/bin/bash
npm install
npm run compile
npm run lint
npm test
npx @vscode/vsce package --no-dependencies