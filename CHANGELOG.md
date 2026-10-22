# Changelog

## 0.0.6

- Added a read-only **NiFi Flow Definition Canvas** viewer for flow definition JSON files (right-click a `.json` file → **NiFi: Open Flow Definition as Canvas**, or *Open With…*). Renders processors, process groups, ports, funnels, labels and connections at their canvas positions; double-click a process group to enter it, click a component to see its configuration.
- Flow definition canvas: the current group's controller services are listed in a table; clicking a row opens a popup with the service's settings and properties. Sensitive property values are never shown.
- Flow definition canvas: clicking and double-clicking components now works while panning is enabled, and rendering errors are shown in a banner instead of failing silently.
- Added **NiFi: Open FlowFile v3 in Editor**, available from the Explorer context menu on `.flowfile` / `.flowfile-v3` files and the Command Palette, matching the flow definition canvas's open command.

## 0.0.5

- Renamed command wording from **NiFi: Create Empty FlowFile v3** to **NiFi: Create FlowFile v3** to match behavior.
- Updated custom editor controls to use "FlowFile" wording instead of "Record".
- Added **NiFi: Merge FlowFiles v3** which will merge records in multiple FlowFiles together.
- **NiFi: Create FlowFile v3** and **NiFi: Merge FlowFiles v3** now both use InputForms relative to project directory rather than opening a file dialoge.