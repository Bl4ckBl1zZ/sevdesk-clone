/**
 * Uploaded file → detected kind and (for CSV) decoded table (F09 IMP-016). Encoding (UTF-8 with/without BOM,
 * Windows-1252), separator and header are detected per file; PDFs/XML/ZIP by magic bytes and extension.
 */
import { type CsvEncoding, type CsvRecord, type CsvSeparator, readCsvRecords } from "../../csv/csv";
import { classifyFile, type ImportFileKind } from "./mapping";

/** IMP-016 upload limits: per file 50 MB, per import 2 GB. CSV files additionally obey the 10 MB CSV limit. */
export const IMPORT_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const IMPORT_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface InspectedFile {
  readonly kind: ImportFileKind;
  readonly encoding?: CsvEncoding;
  readonly delimiter?: CsvSeparator;
  readonly headers?: string[];
  readonly table?: { headers: string[]; records: CsvRecord[] };
  /** Why a text file could not be read as CSV (shown with E-IMP-15/E-IMP-20). */
  readonly readError?: string;
}

const looksBinary = (head: Uint8Array) =>
  (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) || // %PDF
  (head[0] === 0x50 && head[1] === 0x4b) || // PK (ZIP)
  (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) || // JPEG (IMP-025 voucher files)
  (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47); // PNG

export function inspectFile(name: string, bytes: Uint8Array): InspectedFile {
  const head = bytes.subarray(0, 16);
  if (looksBinary(head)) return { kind: classifyFile({ name, head }) };
  const firstLine = new TextDecoder("utf-8").decode(bytes.subarray(0, 512)).split(/\r?\n/)[0] ?? "";
  if (/\.xml$/i.test(name) || /^\s*﻿?<\?xml/.test(firstLine)) return { kind: classifyFile({ name, head, firstLine }) };
  const csv = readCsvRecords(bytes);
  if (!csv.ok) return { kind: classifyFile({ name, head, firstLine }), readError: csv.error.message };
  const { headers, records, encoding, separator } = csv.value;
  return {
    kind: classifyFile({ name, head, firstLine, headers }),
    encoding,
    delimiter: separator,
    headers,
    table: { headers, records },
  };
}
