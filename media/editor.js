(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    flowFile: {
      version: 3,
      id: '',
      entryDate: '',
      lineageStartDate: '',
      attributes: {},
      content: ''
    }
  };

  const versionInput = document.getElementById('version');
  const idInput = document.getElementById('id');
  const entryDateInput = document.getElementById('entryDate');
  const lineageStartDateInput = document.getElementById('lineageStartDate');
  const contentInput = document.getElementById('content');
  const attributesContainer = document.getElementById('attributes');
  const validationList = document.getElementById('validation-list');
  const schemaHint = document.getElementById('schema-hint');
  const addAttributeButton = document.getElementById('add-attribute');
  const validateButton = document.getElementById('validate');
  const saveButton = document.getElementById('save');

  function render() {
    versionInput.value = Number(state.flowFile.version || 3);
    idInput.value = state.flowFile.id || '';
    entryDateInput.value = state.flowFile.entryDate || '';
    lineageStartDateInput.value = state.flowFile.lineageStartDate || '';
    contentInput.value = state.flowFile.content || '';

    attributesContainer.innerHTML = '';
    const entries = Object.entries(state.flowFile.attributes || {});
    if (entries.length === 0) {
      createAttributeRow('', '');
      return;
    }

    for (const [key, value] of entries) {
      createAttributeRow(key, value);
    }
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
    const attributes = {};
    const rows = attributesContainer.querySelectorAll('.attribute-row');

    rows.forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const key = inputs[0].value.trim();
      const value = inputs[1].value;
      if (key.length > 0) {
        attributes[key] = value;
      }
    });

    state.flowFile.attributes = attributes;
  }

  function readFormToState() {
    state.flowFile.version = Number(versionInput.value || 3);
    state.flowFile.id = idInput.value;
    state.flowFile.entryDate = entryDateInput.value;
    state.flowFile.lineageStartDate = lineageStartDateInput.value;
    state.flowFile.content = contentInput.value;
    rebuildAttributesFromDom();
  }

  function renderValidation(messages, parseError) {
    validationList.innerHTML = '';
    if (parseError) {
      const item = document.createElement('li');
      item.textContent = `Parse error: ${parseError}`;
      validationList.appendChild(item);
    }

    if (!messages || messages.length === 0) {
      const ok = document.createElement('li');
      ok.textContent = 'No validation errors.';
      validationList.appendChild(ok);
      return;
    }

    for (const message of messages) {
      const item = document.createElement('li');
      item.textContent = message;
      validationList.appendChild(item);
    }
  }

  addAttributeButton.addEventListener('click', () => {
    createAttributeRow('', '');
  });

  [versionInput, idInput, entryDateInput, lineageStartDateInput, contentInput].forEach((element) => {
    element.addEventListener('input', readFormToState);
  });

  validateButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({ type: 'validate', payload: state.flowFile });
  });

  saveButton.addEventListener('click', () => {
    readFormToState();
    vscode.postMessage({ type: 'save', payload: state.flowFile });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'update':
        state.flowFile = message.payload;
        schemaHint.textContent = message.schemaHint || '';
        render();
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
