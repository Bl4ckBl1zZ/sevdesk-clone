/** pdfjs-dist ships no types for its worker entry; it is only registered as `globalThis.pdfjsWorker` (hybrid.ts). */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
