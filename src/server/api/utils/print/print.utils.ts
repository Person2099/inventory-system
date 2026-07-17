import { createHash } from "node:crypto";

const MAX_GCODE_SIZE_BYTES = 50 * 1024 * 1024;
const ALLOWED_GCODE_EXTENSIONS = [".gcode", ".gco", ".gc", ".bgcode"] as const;

export const sanitizeFilename = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

const toHyphenSlug = (value: string) => value.trim().replace(/[\s_]+/g, "-");

/**
 * Builds the {name}_{project}_{filename} print file name so downstream
 * systems (and humans) can split on "_" to recover uploader/project.
 * Spaces and underscores inside each segment become hyphens first so the
 * top-level underscores stay unambiguous delimiters.
 */
export const buildPrintUploadFilename = (
  userName: string,
  projectName: string,
  originalFilename: string,
) =>
  [userName, projectName, originalFilename]
    .map(toHyphenSlug)
    .join("_");

/**
 * Splits a print upload filename back into its {name}, {project}, and
 * {file} segments. Returns null if the filename doesn't match the
 * name_project_file convention (e.g. a legacy pre-rename upload).
 */
export const parsePrintUploadFilename = (
  filename: string,
): { name: string; project: string; file: string } | null => {
  const parts = filename.split("_");
  if (parts.length < 3) return null;
  const [name, project, ...rest] = parts;
  return { name, project, file: rest.join("_") };
};

const splitFilenameExtension = (
  filename: string,
): { base: string; ext: string } => {
  const compound = /\.gcode\.3mf$/i.exec(filename);
  if (compound) {
    return {
      base: filename.slice(0, filename.length - compound[0].length),
      ext: filename.slice(filename.length - compound[0].length),
    };
  }
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, idx), ext: filename.slice(idx) };
};

export const appendVersionSuffix = (filename: string, version: number) => {
  const { base, ext } = splitFilenameExtension(filename);
  return `${base}-v${version}${ext}`;
};

/**
 * Appends -v2, -v3, ... before the extension until `exists` reports no
 * collision, so two uploads that would otherwise share the same print
 * name stay distinguishable.
 */
export const resolveUniqueFilename = async (
  baseFilename: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> => {
  if (!(await exists(baseFilename))) return baseFilename;
  let version = 2;
  let candidate = appendVersionSuffix(baseFilename, version);
  while (await exists(candidate)) {
    version += 1;
    candidate = appendVersionSuffix(baseFilename, version);
  }
  return candidate;
};

export const hasAllowedGcodeExtension = (name: string) => {
  const lower = name.toLowerCase();
  return ALLOWED_GCODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

export const hashBufferSha256 = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

export const validateGcodePayload = (fileName: string, fileBuffer: Buffer) => {
  if (!fileName.trim()) {
    throw new Error("File name is required.");
  }

  if (!hasAllowedGcodeExtension(fileName)) {
    throw new Error("Only .gcode, .gco, .gc, and .bgcode files are supported.");
  }

  if (fileBuffer.length === 0) {
    throw new Error("G-code file cannot be empty.");
  }

  if (fileBuffer.length > MAX_GCODE_SIZE_BYTES) {
    throw new Error("G-code file is too large. Max size is 50MB.");
  }
};
