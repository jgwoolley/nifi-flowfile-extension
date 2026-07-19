# NiFi FlowFile v3 VS Code Extension

This extension adds a custom editor for FlowFile v3 documents and opens `*.flowfile` and `*.flowfile-v3` files in a structured editor instead of plain text.

## Project structure

- `package.json`: extension manifest, custom editor contribution, activation events, scripts
- `src/extension.ts`: activation logic and `CustomTextEditorProvider`
- `media/editor.js`: basic webview UI logic
- `media/editor.css`: editor styling
- `tsconfig.json`: TypeScript build config
- `.eslintrc.cjs`: lint rules for TypeScript source

## FlowFile v3 schema assumptions

Because exact schema details can vary, the current implementation assumes a configurable JSON structure:

```json
{
  "version": 3,
  "id": "optional-string",
  "entryDate": "optional-iso-string",
  "lineageStartDate": "optional-iso-string",
  "attributes": {
    "key": "value"
  },
  "content": "optional-string"
}
```

Validation is intentionally minimal and can be adjusted in `src/extension.ts` (`FlowFileSchema` and `validateFlowFile`).

## Development

```bash
npm install
npm run compile
npm run lint
```
