export type FlowFileAttribute = [string, string];

export type FlowFileRecord = {
  attributes: FlowFileAttribute[];
  contentText: string;
}