# NiFi FlowFile v3 VS Code Extension

This extension adds a custom editor for FlowFile v3 documents and opens `*.flowfile` and `*.flowfile-v3` files in a structured editor instead of plain text.

## Project structure

- `package.json`: extension manifest, custom editor contribution, activation events, scripts
- `src/extension.ts`: activation logic, binary parser/serializer, and custom editor provider
- `media/editor.js`: webview UI logic for editing multiple FlowFile records
- `media/editor.css`: editor styling
- `tsconfig.json`: TypeScript build config
- `.eslintrc.cjs`: lint rules for TypeScript source

## FlowFile v3 binary format support

The editor now uses a real FlowFile v3 binary stream model based on `NiFiFF3` packaging:

- Each record starts with ASCII magic header: `NiFiFF3`
- Then attribute count (length encoded)
- Then repeated attribute key/value strings (each length encoded)
- Then 8-byte content length (big-endian)
- Then content bytes
- Multiple records can be concatenated in one file and are fully supported in the UI

Length encoding uses:

- 2-byte unsigned length when value is `< 65535`
- `0xFFFF` marker followed by 4-byte unsigned length for larger values

## UI behavior and assumptions

- The custom editor lets you add/remove/select multiple records in one file.
- Each record supports editing attributes and content.
- Content is presented and edited as UTF-8 text in the UI; saving writes UTF-8 bytes back into the FlowFile record.

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```
