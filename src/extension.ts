import * as vscode from 'vscode';

type FlowFileSchema = {
  version: number;
  id?: string;
  entryDate?: string;
  lineageStartDate?: string;
  attributes: Record<string, string>;
  content?: string;
};

const CUSTOM_EDITOR_VIEW_TYPE = 'nifiFlowFile.flowFileV3Editor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      new FlowFileCustomEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );
}

export function deactivate(): void {
  // No-op.
}

class FlowFileCustomEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    const updateWebview = (): void => {
      const parseResult = parseFlowFile(document.getText());
      webviewPanel.webview.postMessage({
        type: 'update',
        payload: parseResult.flowFile,
        validation: parseResult.errors,
        parseError: parseResult.parseError,
        schemaHint:
          'Schema assumptions are configurable in src/extension.ts (FlowFileSchema). Update validation rules there for exact FlowFile v3 requirements.'
      });
    };

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'requestData': {
          updateWebview();
          break;
        }
        case 'validate': {
          const validation = validateFlowFile(message.payload);
          webviewPanel.webview.postMessage({ type: 'validation', validation });
          break;
        }
        case 'save': {
          const validation = validateFlowFile(message.payload);
          webviewPanel.webview.postMessage({ type: 'validation', validation });
          if (validation.length > 0) {
            void vscode.window.showErrorMessage('Cannot save FlowFile: fix validation errors first.');
            break;
          }

          await this.updateTextDocument(document, message.payload);
          await document.save();
          void vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(document.uri)}`);
          break;
        }
        default:
          break;
      }
    });

    updateWebview();
  }

  private async updateTextDocument(document: vscode.TextDocument, flowFile: FlowFileSchema): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    edit.replace(document.uri, fullRange, `${JSON.stringify(flowFile, null, 2)}\n`);
    await vscode.workspace.applyEdit(edit);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
    );
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

    <section class="grid">
      <label for="version">Version</label>
      <input id="version" type="number" min="0" />

      <label for="id">ID</label>
      <input id="id" type="text" />

      <label for="entryDate">Entry Date</label>
      <input id="entryDate" type="text" placeholder="ISO-8601 string" />

      <label for="lineageStartDate">Lineage Start Date</label>
      <input id="lineageStartDate" type="text" placeholder="ISO-8601 string" />
    </section>

    <section>
      <h2>Attributes</h2>
      <div id="attributes"></div>
      <button id="add-attribute" type="button">Add Attribute</button>
    </section>

    <section>
      <h2>Content</h2>
      <textarea id="content" rows="8"></textarea>
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

function parseFlowFile(text: string): {
  flowFile: FlowFileSchema;
  errors: string[];
  parseError?: string;
} {
  const fallback: FlowFileSchema = {
    version: 3,
    attributes: {},
    content: ''
  };

  if (text.trim().length === 0) {
    return { flowFile: fallback, errors: [] };
  }

  try {
    const parsed = JSON.parse(text) as Partial<FlowFileSchema>;
    const flowFile: FlowFileSchema = {
      version: typeof parsed.version === 'number' ? parsed.version : 3,
      id: parsed.id,
      entryDate: parsed.entryDate,
      lineageStartDate: parsed.lineageStartDate,
      attributes: sanitizeAttributes(parsed.attributes),
      content: typeof parsed.content === 'string' ? parsed.content : ''
    };

    return { flowFile, errors: validateFlowFile(flowFile) };
  } catch (error) {
    return {
      flowFile: fallback,
      errors: ['File must be valid JSON before saving.'],
      parseError: error instanceof Error ? error.message : 'Unknown parse error'
    };
  }
}

function sanitizeAttributes(attributes: unknown): Record<string, string> {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(attributes as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])
  );
}

function validateFlowFile(flowFile: Partial<FlowFileSchema>): string[] {
  const errors: string[] = [];

  if (flowFile.version !== 3) {
    errors.push('FlowFile version must be 3.');
  }

  if (!flowFile.attributes || typeof flowFile.attributes !== 'object' || Array.isArray(flowFile.attributes)) {
    errors.push('Attributes must be a key/value object.');
  }

  if (flowFile.id !== undefined && typeof flowFile.id !== 'string') {
    errors.push('ID must be a string when provided.');
  }

  if (flowFile.content !== undefined && typeof flowFile.content !== 'string') {
    errors.push('Content must be a string when provided.');
  }

  return errors;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
