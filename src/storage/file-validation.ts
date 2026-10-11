import { PayloadTooLargeError, UnsupportedMediaError } from '../domain/errors.js';
import { type AllowedType, EXTENSIONS_BY_TYPE, FILE_LIMIT_LABEL, MAX_FILE_BYTES } from './limits.js';

export { type AllowedType, MAX_FILE_BYTES };

export interface CheckedFile {
  /** Decided from the bytes, never taken from the client. */
  contentType: AllowedType;
  /** Sanitized: metadata only, never used as a path or object key. */
  originalName: string;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PDF = Buffer.from('%PDF-');

const startsWith = (data: Buffer, signature: Buffer) => data.length >= signature.length && data.subarray(0, signature.length).equals(signature);

/** Strict UTF-8 text: valid encoding, no NUL and no control characters other than tab, line breaks and form feed. */
function isPlainText(data: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
}

/** Markup that must not be accepted even under a .txt name (the requirements reject SVG and HTML). */
function looksLikeMarkup(data: Buffer): boolean {
  const head = data.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return /^<(!doctype|html|svg|\?xml|script|head|body)/.test(head);
}

function detect(data: Buffer): AllowedType | null {
  if (startsWith(data, PNG)) return 'image/png';
  if (startsWith(data, JPEG)) return 'image/jpeg';
  if (startsWith(data, PDF)) return 'application/pdf';
  if (isPlainText(data) && !looksLikeMarkup(data)) return 'text/plain';
  return null;
}

/** Last path segment, without control characters, at most 200 characters (the extension is kept). */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (clean === '' || clean === '.' || clean === '..') return 'file';
  if (clean.length <= 200) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, 200 - ext.length) + ext;
}

const extensionOf = (name: string) => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '');
const mediaTypeOf = (declared: string) => declared.split(';')[0]!.trim().toLowerCase();

/**
 * Accepts PNG, JPEG, PDF and UTF-8 text up to 10 MiB (see limits.ts). The extension, the declared content type and the actual
 * bytes must all agree: an executable renamed to .png fails the signature check, and SVG, HTML, archives and
 * executables are not on the list at all. This is not antivirus protection.
 */
export function validateUpload(file: { originalName: string; declaredType: string; data: Buffer }): CheckedFile {
  if (file.data.length === 0) throw new UnsupportedMediaError('The file is empty.');
  if (file.data.length > MAX_FILE_BYTES) throw new PayloadTooLargeError(`The file is larger than ${FILE_LIMIT_LABEL}.`);

  const originalName = sanitizeFilename(file.originalName);
  const detected = detect(file.data);
  if (!detected) throw new UnsupportedMediaError('Only PNG, JPEG, PDF and plain text (UTF-8) files can be attached.');

  if (!EXTENSIONS_BY_TYPE[detected].includes(extensionOf(originalName))) {
    throw new UnsupportedMediaError('The file name extension does not match the file content.');
  }
  if (mediaTypeOf(file.declaredType) !== detected) {
    throw new UnsupportedMediaError('The declared file type does not match the file content.');
  }
  return { contentType: detected, originalName };
}
