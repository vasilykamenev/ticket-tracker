// Attachment limits shared by the server and the browser components (pure constants: no imports, so the admin
// bundle can use them). Changing a limit here changes validation, multer, the Content-Length precheck, the
// messages and the browser pre-check together.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_COMMENT = 5;

/** The limit as people read it, e.g. "10 MiB". */
export const FILE_LIMIT_LABEL = `${MAX_FILE_BYTES / (1024 * 1024)} MiB`;

export type AllowedType = 'image/png' | 'image/jpeg' | 'application/pdf' | 'text/plain';

/** Extensions accepted for each type. */
export const EXTENSIONS_BY_TYPE: Record<AllowedType, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
};

export const ALLOWED_EXTENSIONS: readonly string[] = Object.values(EXTENSIONS_BY_TYPE).flat();
