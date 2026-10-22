// Webview script that renders a NiFi flow definition the way the NiFi canvas does.

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type Json = Record<string, any>;

interface Box {
  id: string;
  kind: 'processor' | 'group' | 'inputPort' | 'outputPort' | 'funnel' | 'label' | 'remoteGroup';
  data: Json;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZES = {
  processor: [350, 130],
  group: [380, 172],
  remoteGroup: [380, 172],
  inputPort: [240, 48],
  outputPort: [240, 48],
  funnel: [48, 48],
  label: [150, 150]
} as const;

(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('canvas') as unknown as SVGSVGElement;
  const viewport = document.getElementById('viewport') as unknown as SVGGElement;
  const crumbs = document.getElementById('breadcrumbs') as HTMLElement;
  const details = document.getElementById('details') as HTMLElement;
  const status = document.getElementById('status') as HTMLElement;

  let root: Json | undefined;
  let path: Json[] = [];
  let selectedId: string | undefined;
  let view = { x: 0, y: 0, k: 1 };
  let parameterContexts: Json = {};
  let sized = false;

  window.addEventListener('message', (event) => {
    const message = event.data as { type?: string; payload?: unknown; error?: string };
    if (message.type !== 'flow') {
      return;
    }
    if (message.error || !message.payload) {
      status.textContent = message.error ?? 'No flow data.';
      status.hidden = false;
      return;
    }
    const flow = message.payload as Json;
    const group = (flow.flowContents ?? flow.flow?.flowContents ?? flow.snapshot?.flowContents ?? flow) as Json;
    if (group.componentType !== 'PROCESS_GROUP' && !group.processors && !group.processGroups) {
      status.textContent = 'This JSON file does not look like a NiFi flow definition.';
      status.hidden = false;
      return;
    }
    status.hidden = true;
    parameterContexts = flow.parameterContexts ?? {};
    const previousPath = path.map((g) => String(g.identifier));
    root = group;
    path = [group];
    // Keep the user's place in the group hierarchy across reloads of the file.
    for (const id of previousPath.slice(1)) {
      const child = ((path[path.length - 1].processGroups ?? []) as Json[]).find((g) => String(g.identifier) === id);
      if (!child) {
        break;
      }
      path.push(child);
    }
    const reloaded = previousPath.length > 0;
    if (!reloaded || path.length !== previousPath.length) {
      selectedId = undefined;
    }
    try {
      render(!reloaded);
    } catch (error) {
      status.textContent = `Failed to render flow: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
      status.hidden = false;
    }
  });
  window.addEventListener('error', (event) => {
    status.textContent = `Error: ${event.message}`;
    status.hidden = false;
  });
  new ResizeObserver(() => {
    if (root && !sized && canvas.getBoundingClientRect().width > 0) {
      render(true);
    }
  }).observe(canvas);

  function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, String(value));
    }
    parent?.appendChild(node);
    return node;
  }

  function html<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string, parent?: Element): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) {
      node.textContent = text;
    }
    if (className) {
      node.className = className;
    }
    parent?.appendChild(node);
    return node;
  }

  function shortType(type: unknown): string {
    return String(type ?? '').split('.').pop() ?? '';
  }

  function collectBoxes(group: Json): Box[] {
    const boxes: Box[] = [];
    const add = (list: Json[] | undefined, kind: Box['kind']) => {
      for (const data of list ?? []) {
        const [dw, dh] = SIZES[kind];
        boxes.push({
          id: String(data.identifier),
          kind,
          data,
          x: Number(data.position?.x ?? 0),
          y: Number(data.position?.y ?? 0),
          w: Number(data.width ?? dw),
          h: Number(data.height ?? dh)
        });
      }
    };
    add(group.labels, 'label');
    add(group.processGroups, 'group');
    add(group.remoteProcessGroups, 'remoteGroup');
    add(group.processors, 'processor');
    add(group.inputPorts, 'inputPort');
    add(group.outputPorts, 'outputPort');
    add(group.funnels, 'funnel');
    return boxes;
  }

  function findEndpoint(boxes: Box[], endpoint: Json): Box | undefined {
    return (
      boxes.find((box) => box.id === endpoint.id) ??
      boxes.find((box) => (box.kind === 'group' || box.kind === 'remoteGroup') && box.id === endpoint.groupId)
    );
  }

  /** Point where the ray from the box centre toward (tx, ty) leaves the box. */
  function edgePoint(box: Box, tx: number, ty: number): [number, number] {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) {
      return [cx, cy];
    }
    const scale = Math.min(dx !== 0 ? box.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? box.h / 2 / Math.abs(dy) : Infinity);
    return [cx + dx * scale, cy + dy * scale];
  }

  function render(fit: boolean): void {
    const group = path[path.length - 1];
    renderBreadcrumbs();
    viewport.replaceChildren();
    const boxes = collectBoxes(group);

    const connectionLayer = el('g', {}, viewport);
    const boxLayer = el('g', {}, viewport);

    for (const connection of (group.connections ?? []) as Json[]) {
      drawConnection(connectionLayer, boxes, connection);
    }
    // Labels first so they sit behind components, as on the NiFi canvas.
    for (const box of [...boxes].sort((a, b) => Number(b.kind === 'label') - Number(a.kind === 'label'))) {
      drawBox(boxLayer, box);
    }

    if (fit) {
      fitView(boxes);
    } else {
      applyView();
    }
    renderDetails();
  }

  function renderBreadcrumbs(): void {
    crumbs.replaceChildren();
    path.forEach((group, index) => {
      if (index > 0) {
        html('span', '›', 'sep', crumbs);
      }
      const last = index === path.length - 1;
      const button = html('button', String(group.name ?? 'Process Group'), last ? 'crumb current' : 'crumb', crumbs);
      button.type = 'button';
      button.disabled = last;
      button.addEventListener('click', () => {
        path = path.slice(0, index + 1);
        selectedId = undefined;
        render(true);
      });
    });
  }

  function drawBox(layer: Element, box: Box): void {
    const g = el('g', { class: `node ${box.kind}${box.id === selectedId ? ' selected' : ''}`, transform: `translate(${box.x},${box.y})` }, layer);
    const data = box.data;
    const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

    switch (box.kind) {
      case 'label': {
        el('rect', { class: 'body', width: box.w, height: box.h }, g);
        const text = el('text', { class: 'label-text', x: 8, y: 20 }, g);
        String(data.label ?? '').split('\n').slice(0, Math.floor((box.h - 8) / 18)).forEach((line, i) => {
          const tspan = el('tspan', { x: 8, dy: i === 0 ? 0 : 18 }, text);
          tspan.textContent = line;
        });
        break;
      }
      case 'funnel': {
        el('rect', { class: 'body', width: box.w, height: box.h, rx: 4 }, g);
        el('path', { class: 'funnel-icon', d: 'M12 12 H36 L27 26 V38 L21 34 V26 Z' }, g);
        break;
      }
      case 'inputPort':
      case 'outputPort': {
        el('rect', { class: 'body', width: box.w, height: box.h, rx: 4 }, g);
        el('text', { class: 'name', x: 12, y: 21 }, g).textContent = clip(String(data.name ?? ''), 30);
        el('text', { class: 'sub', x: 12, y: 39 }, g).textContent = box.kind === 'inputPort' ? 'Input Port' : 'Output Port';
        break;
      }
      default: {
        const isGroup = box.kind === 'group' || box.kind === 'remoteGroup';
        el('rect', { class: 'body', width: box.w, height: box.h, rx: 4 }, g);
        el('rect', { class: `header ${statusClass(data)}`, width: box.w, height: 32, rx: 4 }, g);
        el('text', { class: 'name', x: 12, y: 21 }, g).textContent = clip(String(data.name ?? data.targetUri ?? ''), 36);
        if (isGroup) {
          drawGroupBody(g, box);
        } else {
          drawProcessorBody(g, box);
        }
      }
    }

    if (box.kind !== 'label') {
      g.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedId = box.id;
        viewport.querySelectorAll('.node.selected').forEach((node) => node.classList.remove('selected'));
        g.classList.add('selected');
        renderDetails();
      });
    }
    if (box.kind === 'group') {
      g.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        path = [...path, box.data];
        selectedId = undefined;
        render(true);
      });
      el('title', {}, g).textContent = 'Double-click to enter this process group';
    }
  }

  function statusClass(data: Json): string {
    switch (data.scheduledState) {
      case 'RUNNING': return 'running';
      case 'DISABLED': return 'disabled';
      default: return 'stopped';
    }
  }

  function drawProcessorBody(g: Element, box: Box): void {
    const data = box.data;
    const lines: Array<[string, string]> = [
      ['Type', `${shortType(data.type)} ${data.bundle?.version ?? ''}`.trim()],
      ['Bundle', String(data.bundle?.artifact ?? '')],
      ['Run', `${data.schedulingStrategy ?? ''} ${data.schedulingPeriod ?? ''}`.trim()],
      ['State', String(data.scheduledState ?? '')]
    ];
    lines.forEach(([key, value], i) => {
      const y = 54 + i * 20;
      el('text', { class: 'sub key', x: 12, y }, g).textContent = key;
      el('text', { class: 'sub', x: 72, y }, g).textContent = value.length > 36 ? `${value.slice(0, 35)}…` : value;
    });
  }

  function drawGroupBody(g: Element, box: Box): void {
    const data = box.data;
    if (box.kind === 'remoteGroup') {
      el('text', { class: 'sub', x: 12, y: 54 }, g).textContent = 'Remote Process Group';
      return;
    }
    const counts: Array<[string, number]> = [
      ['Processors', (data.processors ?? []).length],
      ['Process Groups', (data.processGroups ?? []).length],
      ['Input Ports', (data.inputPorts ?? []).length],
      ['Output Ports', (data.outputPorts ?? []).length],
      ['Connections', (data.connections ?? []).length]
    ];
    counts.forEach(([key, value], i) => {
      const y = 54 + i * 20;
      el('text', { class: 'sub key', x: 12, y }, g).textContent = key;
      el('text', { class: 'sub', x: 130, y }, g).textContent = String(value);
    });
  }

  function drawConnection(layer: Element, boxes: Box[], connection: Json): void {
    const source = findEndpoint(boxes, connection.source ?? {});
    const destination = findEndpoint(boxes, connection.destination ?? {});
    if (!source || !destination) {
      return;
    }
    const bends = ((connection.bends ?? []) as Json[]).map((bend): [number, number] => [Number(bend.x), Number(bend.y)]);
    const center = (box: Box): [number, number] => [box.x + box.w / 2, box.y + box.h / 2];
    const start = edgePoint(source, ...(bends[0] ?? center(destination)));
    const end = edgePoint(destination, ...(bends[bends.length - 1] ?? center(source)));
    const points = [start, ...bends, end];
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');

    const g = el('g', { class: `connection${connection.identifier === selectedId ? ' selected' : ''}` }, layer);
    el('path', { class: 'hit', d }, g);
    el('path', { class: 'line', d, 'marker-end': 'url(#arrow)' }, g);

    const relationships = ((connection.selectedRelationships ?? []) as string[]).join(', ');
    const label = connection.name ? `${connection.name} (${relationships})` : relationships;
    if (label) {
      const mid = points[Math.floor((points.length - 1) / 2)];
      const next = points[Math.floor((points.length - 1) / 2) + 1];
      const lx = (mid[0] + next[0]) / 2;
      const ly = (mid[1] + next[1]) / 2;
      const width = Math.max(60, label.length * 7 + 16);
      el('rect', { class: 'conn-label-bg', x: lx - width / 2, y: ly - 11, width, height: 22, rx: 3 }, g);
      el('text', { class: 'conn-label', x: lx, y: ly + 4, 'text-anchor': 'middle' }, g).textContent = label;
    }
    g.addEventListener('click', (event) => {
      event.stopPropagation();
      selectedId = String(connection.identifier);
      viewport.querySelectorAll('.selected').forEach((node) => node.classList.remove('selected'));
      g.classList.add('selected');
      renderDetails();
    });
  }

  function fitView(boxes: Box[]): void {
    const rect = canvas.getBoundingClientRect();
    sized = rect.width > 0 && rect.height > 0;
    if (boxes.length === 0 || !sized) {
      view = { x: 20, y: 20, k: 1 };
      applyView();
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = 40;
    const k = Math.max(0.05, Math.min(1, (rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)));
    view = {
      k,
      x: (rect.width - (maxX - minX) * k) / 2 - minX * k,
      y: (rect.height - (maxY - minY) * k) / 2 - minY * k
    };
    applyView();
  }

  function applyView(): void {
    viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  }

  // Pan and zoom.
  let drag: { x: number; y: number } | undefined;
  let dragging = false;
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX - view.x, y: event.clientY - view.y };
    dragging = false;
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag) {
      if (!dragging && Math.hypot(event.clientX - view.x - drag.x, event.clientY - view.y - drag.y) < 4) {
        return;
      }
      dragging = true;
      view.x = event.clientX - drag.x;
      view.y = event.clientY - drag.y;
      applyView();
    }
  });
  canvas.addEventListener('pointerup', () => { drag = undefined; setTimeout(() => { dragging = false; }, 0); });
  canvas.addEventListener('pointerleave', () => { drag = undefined; dragging = false; });
  canvas.addEventListener('click', () => {
    if (dragging) {
      dragging = false;
      return;
    }
    if (selectedId) {
      selectedId = undefined;
      viewport.querySelectorAll('.selected').forEach((node) => node.classList.remove('selected'));
      renderDetails();
    }
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const k = Math.min(4, Math.max(0.05, view.k * Math.exp(-event.deltaY * 0.0015)));
    view = { x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k, k };
    applyView();
  }, { passive: false });
  document.getElementById('fit')?.addEventListener('click', () => render(true));

  // Details panel.
  function findSelected(): { kind: string; data: Json } | undefined {
    if (!selectedId) {
      return undefined;
    }
    const group = path[path.length - 1];
    const box = collectBoxes(group).find((b) => b.id === selectedId);
    if (box) {
      return { kind: box.kind, data: box.data };
    }
    const connection = ((group.connections ?? []) as Json[]).find((c) => c.identifier === selectedId);
    return connection ? { kind: 'connection', data: connection } : undefined;
  }

  function section(title: string, parent: Element): HTMLElement {
    const wrap = html('section', undefined, undefined, parent);
    html('h3', title, undefined, wrap);
    return wrap;
  }

  function rows(parent: Element, entries: Array<[string, unknown]>): void {
    const dl = html('dl', undefined, undefined, parent);
    for (const [key, value] of entries) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      html('dt', key, undefined, dl);
      html('dd', typeof value === 'object' ? JSON.stringify(value) : String(value), undefined, dl);
    }
  }

  function renderDetails(): void {
    details.replaceChildren();
    const selected = findSelected();
    if (!selected) {
      renderGroupDetails();
      return;
    }
    const { kind, data } = selected;
    html('h2', String(data.name ?? (kind === 'connection' ? 'Connection' : kind)), undefined, details);
    html('div', kind === 'processor' ? String(data.type ?? '') : kind, 'muted', details);

    switch (kind) {
      case 'processor': return renderProcessor(data);
      case 'connection': return renderConnection(data);
      case 'group': {
        const body = section('Process Group', details);
        rows(body, [
          ['Identifier', data.identifier],
          ['Comments', data.comments],
          ['Parameter Context', data.parameterContextName],
          ['FlowFile Concurrency', data.flowFileConcurrency],
          ['Outbound Policy', data.flowFileOutboundPolicy],
          ['Default Back Pressure', data.defaultBackPressureObjectThreshold !== undefined && data.defaultBackPressureDataSizeThreshold !== undefined
            ? `${data.defaultBackPressureObjectThreshold} objects / ${data.defaultBackPressureDataSizeThreshold}`
            : undefined]
        ]);
        const open = html('button', 'Enter group', 'primary', body);
        open.type = 'button';
        open.addEventListener('click', () => {
          path = [...path, data];
          selectedId = undefined;
          render(true);
        });
        return;
      }
      default:
        rows(section('Component', details), Object.entries(data).filter(([, v]) => typeof v !== 'object' || v === null));
    }
  }

  function renderGroupDetails(): void {
    const group = path[path.length - 1];
    html('h2', String(group.name ?? 'Process Group'), undefined, details);
    html('div', 'Click a component to see its configuration. Double-click a process group to enter it.', 'muted', details);
    rows(section('Process Group', details), [
      ['Identifier', group.identifier],
      ['Comments', group.comments],
      ['Parameter Context', group.parameterContextName],
      ['Processors', (group.processors ?? []).length],
      ['Process Groups', (group.processGroups ?? []).length],
      ['Connections', (group.connections ?? []).length]
    ]);

    const services = (group.controllerServices ?? []) as Json[];
    if (services.length > 0) {
      const body = section('Controller Services', details);
      const table = html('table', undefined, 'props clickable', body);
      for (const service of services) {
        const tr = html('tr', undefined, undefined, table);
        tr.tabIndex = 0;
        html('td', String(service.name), 'key', tr);
        html('td', shortType(service.type), undefined, tr);
        html('td', String(service.scheduledState ?? ''), 'muted', tr);
        tr.addEventListener('click', () => showServiceDialog(service));
        tr.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            showServiceDialog(service);
          }
        });
      }
    }
    const context = parameterContexts[String(group.parameterContextName)] as Json | undefined;
    if (context) {
      const body = section(`Parameter Context: ${context.name}`, details);
      rows(body, [['Description', context.description]]);
      const table = html('table', undefined, 'props', body);
      for (const parameter of (context.parameters ?? []) as Json[]) {
        const tr = html('tr', undefined, undefined, table);
        html('td', String(parameter.name), 'key', tr);
        html('td', parameter.sensitive ? 'Sensitive value' : String(parameter.value ?? ''), parameter.sensitive ? 'muted' : undefined, tr);
      }
    }
  }

  function showServiceDialog(service: Json): void {
    const overlay = html('div', undefined, 'overlay', document.body);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close();
      }
    });

    const dialog = html('div', undefined, 'dialog', overlay);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const header = html('header', undefined, undefined, dialog);
    const titles = html('div', undefined, undefined, header);
    html('h2', String(service.name ?? 'Controller Service'), undefined, titles);
    html('div', String(service.type ?? ''), 'muted', titles);
    const closeButton = html('button', 'Close', undefined, header);
    closeButton.type = 'button';
    closeButton.addEventListener('click', close);

    const content = html('div', undefined, 'dialog-body', dialog);
    rows(section('Settings', content), [
      ['Identifier', service.identifier],
      ['Bundle', service.bundle ? `${service.bundle.group}:${service.bundle.artifact}:${service.bundle.version}` : undefined],
      ['State', service.scheduledState],
      ['Comments', service.comments],
      ['Bulletin Level', service.bulletinLevel],
      ['APIs', ((service.controllerServiceApis ?? []) as Json[]).map((api) => shortType(api.type)).join(', ')]
    ]);
    renderProperties(section('Properties', content), service);
    closeButton.focus();
  }

  function renderProcessor(data: Json): void {
    rows(section('Settings', details), [
      ['Identifier', data.identifier],
      ['Bundle', data.bundle ? `${data.bundle.group}:${data.bundle.artifact}:${data.bundle.version}` : undefined],
      ['State', data.scheduledState],
      ['Comments', data.comments],
      ['Penalty Duration', data.penaltyDuration],
      ['Yield Duration', data.yieldDuration],
      ['Bulletin Level', data.bulletinLevel]
    ]);
    rows(section('Scheduling', details), [
      ['Strategy', data.schedulingStrategy],
      ['Run Schedule', data.schedulingPeriod],
      ['Concurrent Tasks', data.concurrentlySchedulableTaskCount],
      ['Execution', data.executionNode],
      ['Run Duration (ms)', data.runDurationMillis]
    ]);

    const terminated = (data.autoTerminatedRelationships ?? []) as string[];
    const retried = (data.retriedRelationships ?? []) as string[];
    if (terminated.length > 0 || retried.length > 0) {
      const body = section('Relationships', details);
      rows(body, [
        ['Auto-terminated', terminated.join(', ')],
        ['Retried', retried.join(', ')],
        ['Retry Count', data.retryCount],
        ['Backoff', data.backoffMechanism],
        ['Max Backoff', data.maxBackoffPeriod]
      ]);
    }
    renderProperties(section('Properties', details), data);
  }

  function renderProperties(parent: Element, data: Json): void {
    const properties = (data.properties ?? {}) as Json;
    const descriptors = (data.propertyDescriptors ?? {}) as Json;
    const names = Object.keys(properties);
    if (names.length === 0) {
      html('div', 'No properties.', 'muted', parent);
      return;
    }
    const table = html('table', undefined, 'props', parent);
    for (const name of names) {
      const descriptor = descriptors[name] as Json | undefined;
      const value = properties[name];
      const tr = html('tr', undefined, undefined, table);
      html('td', String(descriptor?.displayName ?? name), 'key', tr);
      const cell = html('td', undefined, undefined, tr);
      if (descriptor?.sensitive) {
        html('span', 'Sensitive value set', 'muted', cell);
      } else if (value === null || value === undefined) {
        html('span', 'No value set', 'muted', cell);
      } else {
        cell.textContent = String(value);
        if (descriptor?.identifiesControllerService) {
          cell.title = 'Controller service reference';
        }
      }
    }
  }

  function renderConnection(data: Json): void {
    rows(section('Details', details), [
      ['Identifier', data.identifier],
      ['From', `${data.source?.name} (${data.source?.type})`],
      ['To', `${data.destination?.name} (${data.destination?.type})`],
      ['Relationships', (data.selectedRelationships ?? []).join(', ')],
      ['Back Pressure Objects', data.backPressureObjectThreshold],
      ['Back Pressure Data Size', data.backPressureDataSizeThreshold],
      ['FlowFile Expiration', data.flowFileExpiration],
      ['Prioritizers', (data.prioritizers ?? []).join(', ')],
      ['Load Balance', data.loadBalanceStrategy]
    ]);
  }

  vscode.postMessage({ type: 'requestFlow' });
})();
