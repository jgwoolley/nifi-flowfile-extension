import * as vscode from 'vscode';

const CUSTOM_EDITOR_VIEW_TYPE = 'nifiFlowFile.flowFileV3Editor';
const MAGIC_HEADER = 'NiFiFF3';
const TWO_BYTE_LIMIT = 0xffff;

type FlowFileAttribute = [string, string];

type FlowFileRecord = {
  attributes: FlowFileAttribute[];
  contentText: string;
};

type ParseResult = {
  records: FlowFileRecord[];
  parseError?: string;
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      new FlowFileBinaryEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );
}

export function deactivate(): void {
  // No-op.
}

class FlowFileBinaryDocument implements vscode.CustomDocument {
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  private _records: FlowFileRecord[];

  constructor(
    public readonly uri: vscode.Uri,
    records: FlowFileRecord[],
    public parseError?: string
  ) {
    this._records = cloneRecords(records);
  }

  get records(): FlowFileRecord[] {
    return cloneRecords(this._records);
  }

  setRecords(records: FlowFileRecord[]): void {
    this._records = cloneRecords(records);
  }

  dispose(): void {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

class FlowFileBinaryEditorProvider implements vscode.CustomEditorProvider<FlowFileBinaryDocument> {
  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<FlowFileBinaryDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private readonly webviewsByDocumentUri = new Map<string, Set<vscode.WebviewPanel>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<FlowFileBinaryDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parseResult = parseFlowFileStream(bytes);
    return new FlowFileBinaryDocument(uri, parseResult.records, parseResult.parseError);
  }

  async resolveCustomEditor(
    document: FlowFileBinaryDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
    this.addWebview(document, webviewPanel);

    webviewPanel.onDidDispose(() => {
      this.removeWebview(document, webviewPanel);
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'requestData': {
          this.postUpdate(webviewPanel, document);
          break;
        }
        case 'validate': {
          const records = normalizeIncomingRecords(message.payload);
          const validation = validateRecords(records);
          webviewPanel.webview.postMessage({ type: 'validation', validation });
          break;
        }
        case 'save': {
          const records = normalizeIncomingRecords(message.payload);
          const validation = validateRecords(records);
          webviewPanel.webview.postMessage({ type: 'validation', validation });
          if (validation.length > 0) {
            void vscode.window.showErrorMessage('Cannot save FlowFile: fix validation errors first.');
            break;
          }

          document.setRecords(records);
          this._onDidChangeCustomDocument.fire({ document });
          await this.saveCustomDocument(document, new vscode.CancellationTokenSource().token);
          this.postUpdate(webviewPanel, document);
          void vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(document.uri)}`);
          break;
        }
        default:
          break;
      }
    });

    this.postUpdate(webviewPanel, document);
  }

  async saveCustomDocument(
    document: FlowFileBinaryDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const bytes = serializeFlowFileStream(document.records);
    await vscode.workspace.fs.writeFile(document.uri, bytes);
  }

  async saveCustomDocumentAs(
    document: FlowFileBinaryDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const bytes = serializeFlowFileStream(document.records);
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(
    document: FlowFileBinaryDocument,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const parseResult = parseFlowFileStream(bytes);
    document.setRecords(parseResult.records);
    document.parseError = parseResult.parseError;
    this.refreshAllWebviews(document);
  }

  async backupCustomDocument(
    document: FlowFileBinaryDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const bytes = serializeFlowFileStream(document.records);
    await vscode.workspace.fs.writeFile(context.destination, bytes);

    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Ignore cleanup failures.
        }
      }
    };
  }

  private refreshAllWebviews(document: FlowFileBinaryDocument): void {
    const webviews = this.webviewsByDocumentUri.get(document.uri.toString());
    if (!webviews) {
      return;
    }

    for (const panel of webviews) {
      this.postUpdate(panel, document);
    }
  }

  private postUpdate(webviewPanel: vscode.WebviewPanel, document: FlowFileBinaryDocument): void {
    webviewPanel.webview.postMessage({
      type: 'update',
      payload: document.records,
      validation: validateRecords(document.records),
      parseError: document.parseError,
      schemaHint:
        'FlowFile v3 binary format: NiFiFF3 header + attributes + 8-byte content length + content bytes; multiple records are supported in one file. Content editing assumes UTF-8 text.'
    });
  }

  private addWebview(document: FlowFileBinaryDocument, webviewPanel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const current = this.webviewsByDocumentUri.get(key) ?? new Set<vscode.WebviewPanel>();
    current.add(webviewPanel);
    this.webviewsByDocumentUri.set(key, current);
  }

  private removeWebview(document: FlowFileBinaryDocument, webviewPanel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const current = this.webviewsByDocumentUri.get(key);
    if (!current) {
      return;
    }

    current.delete(webviewPanel);
    if (current.size === 0) {
      this.webviewsByDocumentUri.delete(key);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>FlowFile v3 Editor</title>
</head>
<body>
  <main>
    <h1>FlowFile v3 Editor</h1>
    <p id="schema-hint"></p>

    <section class="records-toolbar">
      <label for="record-select">Record</label>
      <select id="record-select"></select>
      <button id="add-record" type="button">Add Record</button>
      <button id="remove-record" type="button">Remove Record</button>
    </section>

    <section>
      <h2>Attributes</h2>
      <div id="attributes"></div>
      <button id="add-attribute" type="button">Add Attribute</button>
    </section>

    <section>
      <h2>Content (UTF-8 text)</h2>
      <textarea id="content" rows="10"></textarea>
    </section>

    <section>
      <h2>Validation</h2>
      <ul id="validation-list"></ul>
    </section>

    <div class="actions">
      <button id="validate" type="button">Validate</button>
      <button id="save" type="button">Save</button>
    </div>
  </main>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseFlowFileStream(bytes: Uint8Array): ParseResult {
  if (bytes.length === 0) {
    return { records: [createDefaultRecord()] };
  }

  const cursor = new ByteCursor(bytes);
  const decoder = new TextDecoder();
  const records: FlowFileRecord[] = [];

  try {
    while (cursor.hasMoreData()) {
      assertMagicHeader(cursor);

      const attributeCount = readFieldLength(cursor);
      if (attributeCount <= 0) {
        throw new Error('FlowFile records must contain at least one attribute.');
      }

      const attributes: FlowFileAttribute[] = [];
      for (let index = 0; index < attributeCount; index += 1) {
        attributes.push([readString(cursor), readString(cursor)]);
      }

      const contentLength = readLongAsNumber(cursor);
      const contentBytes = cursor.readBytes(contentLength);
      records.push({
        attributes,
        contentText: decoder.decode(contentBytes)
      });
    }

    return {
      records: records.length > 0 ? records : [createDefaultRecord()]
    };
  } catch (error) {
    return {
      records: records.length > 0 ? records : [createDefaultRecord()],
      parseError: error instanceof Error ? error.message : 'Unknown parse error'
    };
  }
}

function serializeFlowFileStream(records: FlowFileRecord[]): Uint8Array {
  const encoder = new TextEncoder();
  const output: number[] = [];

  for (const record of records) {
    writeAscii(output, MAGIC_HEADER);

    writeFieldLength(output, record.attributes.length);
    for (const [key, value] of record.attributes) {
      writeString(output, key);
      writeString(output, value);
    }

    const contentBytes = encoder.encode(record.contentText);
    writeLong(output, contentBytes.length);
    for (const byte of contentBytes) {
      output.push(byte);
    }
  }

  return Uint8Array.from(output);
}

function validateRecords(records: FlowFileRecord[]): string[] {
  const errors: string[] = [];

  if (records.length === 0) {
    errors.push('At least one FlowFile record is required.');
    return errors;
  }

  records.forEach((record, recordIndex) => {
    if (record.attributes.length === 0) {
      errors.push(`Record ${recordIndex + 1}: at least one attribute is required.`);
    }

    const keys = new Set<string>();
    for (const [key] of record.attributes) {
      if (key.trim().length === 0) {
        errors.push(`Record ${recordIndex + 1}: attribute keys cannot be empty.`);
      } else if (keys.has(key)) {
        errors.push(`Record ${recordIndex + 1}: duplicate attribute key '${key}'.`);
      } else {
        keys.add(key);
      }
    }
  });

  return errors;
}

function normalizeIncomingRecords(payload: unknown): FlowFileRecord[] {
  if (!Array.isArray(payload)) {
    return [createDefaultRecord()];
  }

  const records: FlowFileRecord[] = payload.map((record): FlowFileRecord => {
    const contentText =
      record && typeof record === 'object' && 'contentText' in record && typeof record.contentText === 'string'
        ? record.contentText
        : '';

    const attributes =
      record &&
      typeof record === 'object' &&
      'attributes' in record &&
      Array.isArray(record.attributes)
        ? record.attributes
            .map((attribute): FlowFileAttribute | null => {
              if (!Array.isArray(attribute) || attribute.length < 2) {
                return null;
              }

              return [String(attribute[0] ?? ''), String(attribute[1] ?? '')];
            })
            .filter((attribute): attribute is FlowFileAttribute => attribute !== null)
        : [];

    return {
      attributes,
      contentText
    };
  });

  return records.length > 0 ? records : [createDefaultRecord()];
}

function cloneRecords(records: FlowFileRecord[]): FlowFileRecord[] {
  return records.map((record) => ({
    attributes: record.attributes.map(([key, value]) => [key, value]),
    contentText: record.contentText
  }));
}

function createDefaultRecord(): FlowFileRecord {
  return {
    attributes: [['filename', 'flowfile.txt']],
    contentText: ''
  };
}

class ByteCursor {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  hasMoreData(): boolean {
    return this.offset < this.bytes.length;
  }

  readUint8(): number {
    if (!this.hasMoreData()) {
      throw new Error('Unexpected end of file.');
    }

    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Unexpected end of file while reading bytes.');
    }

    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
}

function assertMagicHeader(cursor: ByteCursor): void {
  for (let index = 0; index < MAGIC_HEADER.length; index += 1) {
    const expected = MAGIC_HEADER.charCodeAt(index);
    const actual = cursor.readUint8();
    if (actual !== expected) {
      throw new Error(`Invalid FlowFile v3 header at byte ${index}.`);
    }
  }
}

function readFieldLength(cursor: ByteCursor): number {
  const first = cursor.readUint8();
  const second = cursor.readUint8();

  if (first === 0xff && second === 0xff) {
    const extended =
      (cursor.readUint8() << 24) |
      (cursor.readUint8() << 16) |
      (cursor.readUint8() << 8) |
      cursor.readUint8();

    return extended >>> 0;
  }

  return (first << 8) | second;
}

function readString(cursor: ByteCursor): string {
  const length = readFieldLength(cursor);
  const bytes = cursor.readBytes(length);
  return String.fromCharCode(...bytes);
}

function readLongAsNumber(cursor: ByteCursor): number {
  let value = 0n;

  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(cursor.readUint8());
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Content length is larger than supported safe integer range.');
  }

  return Number(value);
}

function writeFieldLength(output: number[], length: number): void {
  if (length < TWO_BYTE_LIMIT) {
    output.push((length >>> 8) & 0xff, length & 0xff);
    return;
  }

  output.push(0xff, 0xff);
  output.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
}

function writeAscii(output: number[], text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    output.push(text.charCodeAt(index));
  }
}

function writeString(output: number[], value: string): void {
  const bytes = Array.from(new TextEncoder().encode(value));
  writeFieldLength(output, bytes.length);
  output.push(...bytes);
}

function writeLong(output: number[], value: number): void {
  let remaining = BigInt(value);
  const bytes = new Array<number>(8).fill(0);

  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  output.push(...bytes);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
