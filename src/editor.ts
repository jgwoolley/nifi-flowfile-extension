import { FlowFileRecord, FlowFileAttribute } from "./schemas";

// Define types for VS Code Webview API
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;



type EditorRecord = FlowFileRecord & {
  sourceIndex?: number;
};

interface AppState {
  records: EditorRecord[];
  selectedIndex: number;
}

interface IncomingMessage {
  type: 'update' | 'validation';
  payload?: unknown;
  schemaHint?: string;
  validation?: string[];
  parseError?: string;
}

type FlowFileRecordViewModel = {
  attributes: FlowFileAttribute[];
  contentSize: number;
  filename: string;
  sourceIndex?: number;
};

(function () {
  const vscode = acquireVsCodeApi();

  const state: AppState = {
    records: [createDefaultRecord()],
    selectedIndex: 0
  };

  // DOM Elements with explicit type castings
  const schemaHint = document.getElementById('schema-hint') as HTMLDivElement;
  const recordSelect = document.getElementById('record-select') as HTMLSelectElement;
  const addRecordButton = document.getElementById('add-record') as HTMLButtonElement;
  const removeRecordButton = document.getElementById('remove-record') as HTMLButtonElement;
  const attributesContainer = document.getElementById('attributes') as HTMLDivElement;
  const addAttributeButton = document.getElementById('add-attribute') as HTMLButtonElement;
  const contentSummary = document.getElementById('content-summary') as HTMLParagraphElement;
  const openContentButton = document.getElementById('open-content') as HTMLButtonElement;
  const validateButton = document.getElementById('validate') as HTMLButtonElement;
  const saveButton = document.getElementById('save') as HTMLButtonElement;
  const validationList = document.getElementById('validation-list') as HTMLUListElement;

  function createDefaultRecord(): EditorRecord {
    return {
      attributes: [['filename', 'flowfile.txt']],
      contentBytes: new Uint8Array()
    };
  }

  function normalizeRecords(records: unknown): EditorRecord[] {
    if (!Array.isArray(records) || records.length === 0) {
      return [createDefaultRecord()];
    }

    return records.map((record: unknown): EditorRecord => {
      const viewModel = (record ?? {}) as Partial<FlowFileRecordViewModel>;
      const attributes: FlowFileAttribute[] = Array.isArray(viewModel.attributes)
        ? viewModel.attributes
            .filter((attribute: unknown) => Array.isArray(attribute) && attribute.length >= 2)
            .map((attribute: any): FlowFileAttribute => [String(attribute[0] ?? ''), String(attribute[1] ?? '')])
        : [];
      const contentSize = Number.isInteger(viewModel.contentSize) && (viewModel.contentSize ?? 0) > 0
        ? Number(viewModel.contentSize)
        : 0;

      return {
        attributes,
        contentBytes: new Uint8Array(contentSize),
        sourceIndex: Number.isInteger(viewModel.sourceIndex) ? Number(viewModel.sourceIndex) : undefined
      };
    });
  }

  function getCurrentRecord(): EditorRecord {
    if (!state.records[state.selectedIndex]) {
      state.records[state.selectedIndex] = createDefaultRecord();
    }
    return state.records[state.selectedIndex];
  }

  function renderRecordOptions(): void {
    recordSelect.innerHTML = '';

    state.records.forEach((record, index) => {
      const option = document.createElement('option');
      option.value = String(index);

      const filenameAttr = record.attributes.find(attr => attr[0] === 'filename');
      option.textContent = filenameAttr ? filenameAttr[1] : `Record ${index + 1}`;
      
      recordSelect.appendChild(option);
    });

    if (state.selectedIndex >= state.records.length) {
      state.selectedIndex = state.records.length - 1;
    }

    if (state.selectedIndex < 0) {
      state.selectedIndex = 0;
    }

    recordSelect.value = String(state.selectedIndex);
    removeRecordButton.disabled = state.records.length <= 1;
  }

  function createAttributeRow(key: string, value: string): void {
    const row = document.createElement('div');
    row.className = 'attribute-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'key';
    keyInput.value = key;

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.placeholder = 'value';
    valueInput.value = value;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      row.remove();
      rebuildAttributesFromDom();
    });

    keyInput.addEventListener('input', rebuildAttributesFromDom);
    valueInput.addEventListener('input', rebuildAttributesFromDom);

    row.append(keyInput, valueInput, removeButton);
    attributesContainer.appendChild(row);
  }

  function rebuildAttributesFromDom(): void {
    const currentRecord = getCurrentRecord();
    const attributes: FlowFileAttribute[] = [];

    attributesContainer.querySelectorAll('.attribute-row').forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const key = (inputs[0] as HTMLInputElement).value.trim();
      const value = (inputs[1] as HTMLInputElement).value;
      if (key.length > 0) {
        attributes.push([key, value]);
      }
    });

    currentRecord.attributes = attributes;
  }

  function readFormToState(): void {
    rebuildAttributesFromDom();
  }

  function renderCurrentRecord(): void {
    const currentRecord = getCurrentRecord();
    attributesContainer.innerHTML = '';

    if (currentRecord.attributes.length === 0) {
      createAttributeRow('', '');
    } else {
      currentRecord.attributes.forEach(([key, value]) => createAttributeRow(key, value));
    }

    contentSummary.textContent = `${currentRecord.contentBytes.length} bytes`;
  }

  function renderValidation(messages?: string[], parseError?: string): void {
    validationList.innerHTML = '';

    if (parseError) {
      const parseItem = document.createElement('li');
      parseItem.textContent = `Parse error: ${parseError}`;
      validationList.appendChild(parseItem);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      if (!parseError) {
        const ok = document.createElement('li');
        ok.textContent = 'No validation errors.';
        validationList.appendChild(ok);
      }
      return;
    }

    messages.forEach((message) => {
      const item = document.createElement('li');
      item.textContent = message;
      validationList.appendChild(item);
    });
  }

  recordSelect.addEventListener('change', () => {
    readFormToState();
    state.selectedIndex = Number(recordSelect.value || 0);
    renderCurrentRecord();
  });

  addRecordButton.addEventListener('click', () => {
    readFormToState();
    state.records.push(createDefaultRecord());
    state.selectedIndex = state.records.length - 1;
    renderRecordOptions();
    renderCurrentRecord();
  });

  removeRecordButton.addEventListener('click', () => {
    if (state.records.length <= 1) {
      return;
    }

    readFormToState();
    state.records.splice(state.selectedIndex, 1);
    if (state.selectedIndex >= state.records.length) {
      state.selectedIndex = state.records.length - 1;
    }

    renderRecordOptions();
    renderCurrentRecord();
  });

  addAttributeButton.addEventListener('click', () => {
    createAttributeRow('', '');
  });

  openContentButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({ type: 'openContent', recordIndex: state.selectedIndex });
  });

  validateButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({
      type: 'validate',
      payload: state.records.map((record) => ({ attributes: record.attributes, sourceIndex: record.sourceIndex }))
    });
  });

  saveButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({
      type: 'save',
      payload: state.records.map((record) => ({ attributes: record.attributes, sourceIndex: record.sourceIndex }))
    });
  });

  window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
    const message = event.data;
    switch (message.type) {
      case 'update':
        state.records = normalizeRecords(message.payload);
        if (state.selectedIndex >= state.records.length) {
          state.selectedIndex = state.records.length - 1;
        }
        if (state.selectedIndex < 0) {
          state.selectedIndex = 0;
        }
        schemaHint.textContent = message.schemaHint || '';
        renderRecordOptions();
        renderCurrentRecord();
        renderValidation(message.validation, message.parseError);
        break;
      case 'validation':
        renderValidation(message.validation);
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'requestData' });
})();