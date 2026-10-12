/**
 * EPC QR (GiroCode) as vector graphics (F04 DOC-51): the payload from `src/domain/epc/girocode.ts`, error correction
 * level M, drawn as one SVG path so the PDF stays PDF/A-clean (no raster image, no transparency).
 */
import { Path, Svg } from "@react-pdf/renderer";
import QRCode from "qrcode";

/** Module matrix of the QR (true = dark), incl. no quiet zone. */
export function qrMatrix(payload: string): boolean[][] {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const { size, data } = qr.modules;
  return Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => data[r * size + c] === 1));
}

/** SVG path data with one unit square per dark module, offset by a 4-module quiet zone. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) parts.push(`M${c + 4} ${r + 4}h1v1h-1z`);
    });
  });
  return parts.join("");
}

export function EpcQr({ payload, size }: { payload: string; size: number }) {
  const matrix = qrMatrix(payload);
  const units = matrix.length + 8;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${units} ${units}`}>
      <Path d={qrPath(matrix)} fill="#000000" />
    </Svg>
  );
}
