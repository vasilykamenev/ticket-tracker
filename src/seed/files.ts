import { crc32, deflateSync } from 'node:zlib';
import type { Rng } from './rng.js';

// Small, valid and harmless demo files, built byte by byte from the random stream (no external libraries and no
// binary fixtures in the repository). They are uploaded to Storage through the normal storage service.

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

/** A square RGB image of smooth colour bands with some noise; about `targetBytes` long. */
export function makePng(rng: Rng, targetBytes: number): Buffer {
  const side = Math.max(16, Math.floor(Math.sqrt(targetBytes / 2.7)));
  const base = [rng.int(40, 215), rng.int(40, 215), rng.int(40, 215)];
  const raw = Buffer.alloc(side * (1 + side * 3));
  for (let y = 0; y < side; y++) {
    const row = y * (1 + side * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < side; x++) {
      for (let c = 0; c < 3; c++) {
        const band = Math.floor((x + y) / 24) % 2 === 0 ? 18 : -18;
        raw[row + 1 + x * 3 + c] = Math.max(0, Math.min(255, base[c]! + band + rng.int(-14, 14)));
      }
    }
  }
  const header = Buffer.concat([u32(side), u32(side), Buffer.from([8, 2, 0, 0, 0])]); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A baseline grayscale JPEG: every 8x8 block is flat (DC only), coded with a tiny custom Huffman table, so it
 * decodes everywhere. A COM (comment) segment pads it towards `targetBytes`.
 */
export function makeJpeg(rng: Rng, targetBytes: number): Buffer {
  const blocks = 24; // 192 x 192 pixels
  const size = blocks * 8;
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      bits = (bits << 1) | ((value >> i) & 1);
      if (++bitCount === 8) {
        out.push(bits);
        if (bits === 0xff) out.push(0x00); // byte stuffing
        bits = 0;
        bitCount = 0;
      }
    }
  };

  const start = rng.int(60, 190);
  let previous = 0;
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      const level = Math.max(-128, Math.min(127, start - 128 + Math.round(Math.sin(bx / 3) * 40 + Math.cos(by / 4) * 30) + rng.int(-6, 6)));
      const diff = level - previous;
      previous = level;
      const magnitude = Math.abs(diff);
      const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
      put(category, 4); // custom DC table: the 4-bit code of a category is the category itself
      if (category > 0) put(diff >= 0 ? diff : diff + (1 << category) - 1, category);
      put(0, 1); // AC table with one symbol: end of block
    }
  }
  while (bitCount !== 0) put(1, 1); // pad the last byte with ones

  const segment = (marker: number, payload: Buffer) => {
    const length = payload.length + 2; // the length field counts itself
    return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload]);
  };
  const quant = segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 8)])); // all steps 8: DC = pixel - 128
  const frame = segment(0xc0, Buffer.from([8, size >> 8, size & 0xff, size >> 8, size & 0xff, 1, 1, 0x11, 0]));
  const dcTable = segment(0xc4, Buffer.concat([Buffer.from([0x00, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8])]));
  const acTable = segment(0xc4, Buffer.concat([Buffer.from([0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]));
  const scan = segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));
  const core = Buffer.concat([quant, frame, dcTable, acTable, scan, Buffer.from(out), Buffer.from([0xff, 0xd9])]);

  const padding = Math.max(0, targetBytes - core.length - 2);
  const comments: Buffer[] = [];
  for (let left = padding; left > 8; left -= 65000) {
    const n = Math.min(left - 4, 65000);
    comments.push(segment(0xfe, Buffer.from(Array.from({ length: n }, () => 97 + rng.int(0, 25)))));
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...comments, core]);
}

/** A one-page PDF with correct cross-reference offsets; filler lines pad the content stream. */
export function makePdf(rng: Rng, targetBytes: number, title: string): Buffer {
  const ascii = title.replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, ' ');
  const lines = [`BT /F1 16 Tf 56 760 Td (${ascii}) Tj ET`, 'BT /F1 11 Tf 56 730 Td (Demo document, generated for the take-home dataset.) Tj ET'];
  let stream = lines.join('\n');
  while (stream.length < targetBytes - 520) stream += '\n' + `% ${rng.int(100000, 999999)} ` + 'x'.repeat(rng.int(20, 60));

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const TEXT_LINES = [
  '2026-10-01 09:12:44 INFO  request accepted',
  '2026-10-01 09:12:45 WARN  retrying after timeout (attempt 2 of 3)',
  '2026-10-01 09:12:47 ERROR export failed: connection reset by peer',
  'Заметка: ошибка воспроизводится только при больших выгрузках.',
  'Шаги: открыть отчёт, нажать «Экспорт», дождаться сообщения об ошибке.',
  'Browser: Chrome 130, Windows 11, window 1440x900',
  'Номер заказа: 48213, сумма не совпадает с итогом в личном кабинете.',
];

/** Plain UTF-8 text with Cyrillic lines, about `targetBytes` long. */
export function makeText(rng: Rng, targetBytes: number): Buffer {
  let text = 'Demo log excerpt (fictional)\n';
  while (Buffer.byteLength(text) < targetBytes - 80) text += `${rng.pick(TEXT_LINES)} #${rng.int(1000, 9999)}\n`;
  return Buffer.from(text, 'utf8');
}
