import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { FlowFileAttribute, FlowFileRecord } from './schemas';
import { cloneRecords, createDefaultRecord, parseFlowFileStream, serializeFlowFileStream, validateRecords } from './utils';

const CUSTOM_EDITOR_VIEW_TYPE = 'nifiFlowFile.flowFileV3Editor';

async function extractCoreAttributes(fileUri: vscode.Uri): Promise<FlowFileAttribute[]> {
  // Get file metadata (size, creation time, modified time)
  const stat = await vscode.workspace.fs.stat(fileUri);

  // Extract absolute path directory (web-compatible, excluding filename)
  const absolutePathSegments = fileUri.path.split('/');
  absolutePathSegments.pop(); // Remove filename
  const absolutePath = absolutePathSegments.join('/') || '/';

  // Extract relative path directory
  const relativePath = vscode.workspace.asRelativePath(fileUri);
  const relativePathSegments = relativePath.split('/');
  const filename = relativePathSegments.pop() || 'unknown';
  const relativeDirPath = relativePathSegments.join('/') || '/';

  // Read the file metadata
  // https://github.com/apache/nifi/blob/main/nifi-api/src/main/java/org/apache/nifi/flowfile/attributes/CoreAttributes.java
  return [
    // The filename of the FlowFile. The filename should not contain any directory structure.
    ['filename', filename],
    // The FlowFile’s path indicates the relative directory to which a FlowFile belongs and does not contain the filename.
    ['path', relativeDirPath],
    // The FlowFile’s absolute path indicates the absolute directory to which a FlowFile belongs and does not contain the filename.
    ['absolute.path', absolutePath],
    ['size', stat.size.toString()],
    ['file.creationTime', new Date(stat.ctime).toISOString()],
    ['file.lastModifiedTime', new Date(stat.mtime).toISOString()],
  ];
}

async function readUriAsFlowFile(fileUri: vscode.Uri) {
  const attributes = extractCoreAttributes(fileUri);

  // Read the file as a Uint8Array
  const fileData = await vscode.workspace.fs.readFile(fileUri);

  const result: FlowFileRecord = {
    attributes: await attributes,
    contentBytes: fileData,
  };

  return result;
}

async function createFlowFile() {
  const contentFiles = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: true,
  })

  if (!contentFiles) {
    return;
  }

  // Get the current workspace folder
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No active workspace folder found.');
    return;
  }

  // Show the input box at the Command Palette position
  const relativePath = await vscode.window.showInputBox({
    prompt: 'Enter relative file path to save',
    value: 'output.flowfile-v3',
    valueSelection: [0, 6],
    placeHolder: 'output.flowfile-v3',
    validateInput: (text) => {
      return text.trim().length === 0 ? 'Path cannot be empty' : null;
    }
  });

  // User pressed Escape or submitted an empty string
  if (!relativePath) {
    return;
  }

  // 3. Resolve the relative path against the workspace root
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

  try {
    const defaultRecords = await Promise.all(
      contentFiles.map(readUriAsFlowFile)
    );
    const bytes = serializeFlowFileStream(defaultRecords);

    // Write the binary data to the selected file
    await vscode.workspace.fs.writeFile(uri, bytes);

    // Open the newly created file using your custom editor
    await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE);

    vscode.window.showInformationMessage('FlowFile created successfully.');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`Failed to create FlowFile: ${errorMessage}`);
  }
}

async function mergeFlowFiles() {
  const flowFilePaths = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: true,
  })

  if (!flowFilePaths) {
    return;
  }

  // Get the current workspace folder
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No active workspace folder found.');
    return;
  }

  // Show the input box at the Command Palette position
  const relativePath = await vscode.window.showInputBox({
    prompt: 'Enter relative file path to save',
    value: 'output.flowfile-v3',
    valueSelection: [0, 6],
    placeHolder: 'output.flowfile-v3',
    validateInput: (text) => {
      return text.trim().length === 0 ? 'Path cannot be empty' : null;
    }
  });

  // User pressed Escape or submitted an empty string
  if (!relativePath) {
    return;
  }

  // 3. Resolve the relative path against the workspace root
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

  const flowFiles: FlowFileRecord[] = [];
  for(const flowFilePath of flowFilePaths) {
    // Read the file as a Uint8Array
    const flowFileRaw = await vscode.workspace.fs.readFile(flowFilePath);
    const parsedFlowFilesResult = parseFlowFileStream(flowFileRaw);
    for(const flowFile of parsedFlowFilesResult.records) {
      flowFiles.push(flowFile);
    }
    
  }

  const bytes = serializeFlowFileStream(flowFiles);
  // Write the binary data to the selected file
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      new FlowFileBinaryEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );

  // Register the command to create a new, empty FlowFile
  context.subscriptions.push(
    vscode.commands.registerCommand('nifiFlowFile.createFlowFile', createFlowFile)
  );

  // Register the command to create a new, empty FlowFile
  context.subscriptions.push(
    vscode.commands.registerCommand('nifiFlowFile.mergeFlowFiles', mergeFlowFiles)
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

  constructor(private readonly context: vscode.ExtensionContext) { }

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
      const incoming = message as {
        type?: unknown;
        payload?: unknown;
        recordIndex?: unknown;
      };

      const messageType = typeof incoming.type === 'string' ? incoming.type : '';

      switch (messageType) {
        case 'requestData': {
          this.postUpdate(webviewPanel, document);
          break;
        }
        case 'validate': {
          const records = normalizeIncomingRecords(incoming.payload, document.records);
          const validation = validateRecords(records);
          webviewPanel.webview.postMessage({ type: 'validation', validation });
          break;
        }
        case 'save': {
          const records = normalizeIncomingRecords(incoming.payload, document.records);
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
        case 'openContent': {
          const recordIndex = Number(incoming.recordIndex);
          if (!Number.isInteger(recordIndex)) {
            break;
          }

          await this.openRecordContent(document, recordIndex);
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
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    void cancellation;
    const bytes = serializeFlowFileStream(document.records);
    await vscode.workspace.fs.writeFile(document.uri, bytes);
  }

  async saveCustomDocumentAs(
    document: FlowFileBinaryDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    void cancellation;
    const bytes = serializeFlowFileStream(document.records);
    await vscode.workspace.fs.writeFile(destination, bytes);
  }

  async revertCustomDocument(
    document: FlowFileBinaryDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    void cancellation;
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const parseResult = parseFlowFileStream(bytes);
    document.setRecords(parseResult.records);
    document.parseError = parseResult.parseError;
    this.refreshAllWebviews(document);
  }

  async backupCustomDocument(
    document: FlowFileBinaryDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    void cancellation;
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
      payload: document.records.map((record, index) => ({
        attributes: record.attributes,
        contentSize: record.contentBytes.length,
        filename: getRecordFilename(record, index),
        sourceIndex: index
      })),
      validation: validateRecords(document.records),
      parseError: document.parseError,
      schemaHint:
        'FlowFile v3 binary format: NiFiFF3 header + attributes + 8-byte content length + content bytes; multiple records are supported. Content remains binary and can be opened externally per record.'
    });
  }

  private async openRecordContent(document: FlowFileBinaryDocument, recordIndex: number): Promise<void> {
    const record = document.records[recordIndex];
    if (!record) {
      return;
    }

    const filename = getRecordFilename(record, recordIndex);
    const tempDir = path.join(os.tmpdir(), 'nifi-flowfile-extension-content');
    const uniqueId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
    const contentPath = path.join(tempDir, `${uniqueId}-${filename}`);
    const contentUri = vscode.Uri.file(contentPath);

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir));
    await vscode.workspace.fs.writeFile(contentUri, record.contentBytes);
    await vscode.commands.executeCommand('vscode.open', contentUri, vscode.ViewColumn.Beside);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';" />
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
      <h2>Content</h2>
      <p id="content-summary"></p>
      <button id="open-content" type="button">Open Content</button>
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

  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

type FlowFileRecordPayload = {
  attributes?: unknown;
  sourceIndex?: unknown;
};

function normalizeIncomingRecords(payload: unknown, previousRecords: FlowFileRecord[]): FlowFileRecord[] {
  if (!Array.isArray(payload)) {
    return previousRecords.length > 0 ? cloneRecords(previousRecords) : [createDefaultRecord()];
  }

  const records: FlowFileRecord[] = payload.map((record): FlowFileRecord => {
    const candidate = (record ?? {}) as FlowFileRecordPayload;

    const attributes =
      Array.isArray(candidate.attributes)
        ? candidate.attributes
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
      contentBytes: new Uint8Array()
    };
  });

  records.forEach((record, index) => {
    const candidate = (payload[index] ?? {}) as FlowFileRecordPayload;
    const sourceIndex = Number(candidate.sourceIndex);
    const previousRecord = Number.isInteger(sourceIndex) ? previousRecords[sourceIndex] : undefined;
    record.contentBytes = previousRecord?.contentBytes?.slice() ?? new Uint8Array();
  });

  return records.length > 0 ? records : [createDefaultRecord()];
}

function getRecordFilename(record: FlowFileRecord, index: number): string {
  const filename = record.attributes.find(([key]) => key === 'filename')?.[1]?.trim();
  const safeFilename = filename ? path.basename(filename) : '';
  return safeFilename.length > 0 ? safeFilename : `record-${index + 1}.bin`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}