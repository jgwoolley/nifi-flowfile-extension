export type FlowFileAttribute = [string, string];

export type FlowFileRecord = {
  attributes: FlowFileAttribute[];
  contentBytes: Uint8Array;
}