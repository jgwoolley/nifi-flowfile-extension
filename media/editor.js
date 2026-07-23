(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    records: [createDefaultRecord()],
    selectedIndex: 0
  };

  const schemaHint = document.getElementById('schema-hint');
  const recordSelect = document.getElementById('record-select');
  const addRecordButton = document.getElementById('add-record');
  const removeRecordButton = document.getElementById('remove-record');
  const attributesContainer = document.getElementById('attributes');
  const addAttributeButton = document.getElementById('add-attribute');
  const contentInput = document.getElementById('content');
  const validateButton = document.getElementById('validate');
  const saveButton = document.getElementById('save');
  const validationList = document.getElementById('validation-list');

  function createDefaultRecord() {
    return {
      attributes: [['filename', 'flowfile.txt']],
      contentText: ''
    };
  }

  function normalizeRecords(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return [createDefaultRecord()];
    }

    return records.map((record) => {
      const attributes = Array.isArray(record.attributes)
        ? record.attributes
            .filter((attribute) => Array.isArray(attribute) && attribute.length >= 2)
            .map((attribute) => [String(attribute[0] ?? ''), String(attribute[1] ?? '')])
        : [];

      return {
        attributes,
        contentText: typeof record.contentText === 'string' ? record.contentText : ''
      };
    });
  }

  function getCurrentRecord() {
    if (!state.records[state.selectedIndex]) {
      state.records[state.selectedIndex] = createDefaultRecord();
    }
    return state.records[state.selectedIndex];
  }

  function renderRecordOptions() {
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

  function createAttributeRow(key, value) {
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

  function rebuildAttributesFromDom() {
    const currentRecord = getCurrentRecord();
    const attributes = [];

    attributesContainer.querySelectorAll('.attribute-row').forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const key = inputs[0].value.trim();
      const value = inputs[1].value;
      if (key.length > 0) {
        attributes.push([key, value]);
      }
    });

    currentRecord.attributes = attributes;
  }

  function readFormToState() {
    const currentRecord = getCurrentRecord();
    currentRecord.contentText = contentInput.value;
    rebuildAttributesFromDom();
  }

  function renderCurrentRecord() {
    const currentRecord = getCurrentRecord();
    attributesContainer.innerHTML = '';

    if (currentRecord.attributes.length === 0) {
      createAttributeRow('', '');
    } else {
      currentRecord.attributes.forEach(([key, value]) => createAttributeRow(key, value));
    }

    contentInput.value = currentRecord.contentText;
  }

  function renderValidation(messages, parseError) {
    validationList.innerHTML = '';

    if (parseError) {
      const parseItem = document.createElement('li');
      parseItem.textContent = `Parse error: ${parseError}`;
      validationList.appendChild(parseItem);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      const ok = document.createElement('li');
      ok.textContent = 'No validation errors.';
      validationList.appendChild(ok);
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

  contentInput.addEventListener('input', readFormToState);

  validateButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({ type: 'validate', payload: state.records });
  });

  saveButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({ type: 'save', payload: state.records });
  });

  window.addEventListener('message', (event) => {
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
