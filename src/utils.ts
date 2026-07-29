import { FlowFileAttribute, FlowFileRecord } from "./schemas";

const MAGIC_HEADER = 'NiFiFF3';
const TWO_BYTE_LIMIT = 0xffff;

export type ParseResult = {
  records: FlowFileRecord[];
  parseError?: string;
};

export function createDefaultRecord(): FlowFileRecord {
  return {
    attributes: [['filename', 'flowfile.txt']],
    contentBytes: new Uint8Array()
  };
}


export function cloneRecords(records: FlowFileRecord[]): FlowFileRecord[] {
  return records.map((record) => ({
    attributes: record.attributes.map(([key, value]) => [key, value]),
    contentBytes: record.contentBytes.slice()
  }));
}

class ByteCursor {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) { }

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

export function parseFlowFileStream(bytes: Uint8Array): ParseResult {
  if (bytes.length === 0) {
    return { records: [createDefaultRecord()] };
  }

  const cursor = new ByteCursor(bytes);
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
        contentBytes
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

export function serializeFlowFileStream(records: FlowFileRecord[]): Uint8Array {
  const output: number[] = [];

  for (const record of records) {
    writeAscii(output, MAGIC_HEADER);

    writeFieldLength(output, record.attributes.length);
    for (const [key, value] of record.attributes) {
      writeString(output, key);
      writeString(output, value);
    }

    const contentBytes = record.contentBytes;
    writeLong(output, contentBytes.length);
    for (const byte of contentBytes) {
      output.push(byte);
    }
  }

  return Uint8Array.from(output);
}

export function validateRecords(records: FlowFileRecord[]): string[] {
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
