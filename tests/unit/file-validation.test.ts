import { describe, expect, it } from 'vitest';
import { PayloadTooLargeError, UnsupportedMediaError } from '../../src/domain/errors.js';
import { MAX_FILE_BYTES, sanitizeFilename, validateUpload } from '../../src/storage/file-validation.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif data')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const TEXT = Buffer.from('Логи клиента:\nline two\ttabbed\r\n', 'utf8');

const check = (originalName: string, declaredType: string, data: Buffer) => validateUpload({ originalName, declaredType, data });
const rejects = (originalName: string, declaredType: string, data: Buffer, error: typeof UnsupportedMediaError | typeof PayloadTooLargeError = UnsupportedMediaError) =>
  expect(() => check(originalName, declaredType, data)).toThrow(error);

describe('accepted files', () => {
  it('detects the type from the bytes', () => {
    expect(check('screen.png', 'image/png', PNG)).toEqual({ contentType: 'image/png', originalName: 'screen.png' });
    expect(check('photo.jpg', 'image/jpeg', JPEG).contentType).toBe('image/jpeg');
    expect(check('photo.JPEG', 'image/jpeg', JPEG).contentType).toBe('image/jpeg');
    expect(check('invoice.pdf', 'application/pdf', PDF).contentType).toBe('application/pdf');
    expect(check('notes.txt', 'text/plain', TEXT).contentType).toBe('text/plain');
  });

  it('ignores parameters on the declared type and accepts text with a BOM', () => {
    expect(check('notes.txt', 'text/plain; charset=utf-8', TEXT).contentType).toBe('text/plain');
    expect(check('bom.txt', 'text/plain', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')])).contentType).toBe('text/plain');
  });

  it('accepts exactly 10 MiB and rejects one byte more', () => {
    const header = PNG;
    const atLimit = Buffer.concat([header, Buffer.alloc(MAX_FILE_BYTES - header.length)]);
    expect(check('big.png', 'image/png', atLimit).contentType).toBe('image/png');
    rejects('big.png', 'image/png', Buffer.concat([atLimit, Buffer.from([0])]), PayloadTooLargeError);
  });
});

describe('rejected files', () => {
  it('rejects an empty file', () => rejects('empty.txt', 'text/plain', Buffer.alloc(0)));

  it('checks the signature, so a renamed executable or archive is not an image', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 7)]);
    rejects('virus.png', 'image/png', exe);
    rejects('archive.pdf', 'application/pdf', zip);
    rejects('script.txt', 'text/plain', exe); // not valid text either
  });

  it('requires the extension, the declared type and the content to agree', () => {
    rejects('screen.pdf', 'image/png', PNG); // wrong extension
    rejects('screen.png', 'application/pdf', PNG); // wrong declared type
    rejects('screen', 'image/png', PNG); // no extension
    rejects('screen.png', 'application/octet-stream', PNG);
    rejects('photo.png', 'image/jpeg', JPEG);
  });

  it('rejects SVG, HTML and XML, whatever they are called', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = Buffer.from('  \n<!DOCTYPE html><html><body>hi</body></html>');
    rejects('logo.svg', 'image/svg+xml', svg);
    rejects('page.html', 'text/html', html);
    rejects('logo.txt', 'text/plain', svg);
    rejects('page.txt', 'text/plain', html);
    rejects('data.txt', 'text/plain', Buffer.from('<?xml version="1.0"?><a/>'));
    expect(check('code.txt', 'text/plain', Buffer.from('a < b and b > c')).contentType).toBe('text/plain'); // ordinary text with angle brackets is fine
  });

  it('rejects binary content and invalid UTF-8 in a text file', () => {
    rejects('nul.txt', 'text/plain', Buffer.from('hello\u0000world'));
    rejects('ctrl.txt', 'text/plain', Buffer.from('bell\u0007'));
    rejects('latin1.txt', 'text/plain', Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1: not UTF-8
    rejects('lone.txt', 'text/plain', Buffer.from([0xc3]));
  });
});

describe('sanitizeFilename', () => {
  it('keeps only the last path segment and drops control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('bad\r\nname\u0000.txt')).toBe('badname.txt');
    expect(sanitizeFilename('  spaced   out  .png ')).toBe('spaced out .png');
  });

  it('falls back to "file" for empty names and caps the length, keeping the extension', () => {
    for (const name of ['', '   ', '.', '..', '/', '\u0000']) expect(sanitizeFilename(name), JSON.stringify(name)).toBe('file');
    const long = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(long.length).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('is applied to the stored name', () => {
    expect(check('../../x/screen.png', 'image/png', PNG).originalName).toBe('screen.png');
  });
});
