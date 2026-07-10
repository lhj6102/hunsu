#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_GUI_SUBSYSTEM = 2;
const WINDOWS_CUI_SUBSYSTEM = 3;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultExecutable = join(packageRoot, "src-tauri", "target", "release", "hunsu-bridge.exe");

try {
  const executable = executablePath(process.argv.slice(2));
  verifyWindowsGuiSubsystem(executable);
  console.log(`Verified ${executable}: PE Optional Header Subsystem is Windows GUI (2).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function executablePath(args) {
  if (args.length === 0) return defaultExecutable;
  if (args.length !== 2 || args[0] !== "--executable" || !args[1]) {
    throw new Error("Usage: verify-windows-gui-subsystem.mjs [--executable <path>]");
  }
  return resolve(args[1]);
}

function verifyWindowsGuiSubsystem(executable) {
  if (!existsSync(executable)) {
    throw new Error(
      `Windows release executable is missing: ${executable}\nExpected Cargo package "hunsu-bridge" to produce src-tauri/target/release/hunsu-bridge.exe.`
    );
  }
  if (!statSync(executable).isFile()) {
    throw new Error(`Windows release executable is not a file: ${executable}`);
  }

  const subsystem = readPeSubsystem(readFileSync(executable), executable);
  if (subsystem !== WINDOWS_GUI_SUBSYSTEM) {
    const actual = subsystem === WINDOWS_CUI_SUBSYSTEM
      ? "Windows CUI (3)"
      : `subsystem value ${subsystem}`;
    throw new Error(
      `Invalid Windows subsystem for ${executable}: expected Windows GUI (2), found ${actual}.`
    );
  }
}

function readPeSubsystem(bytes, executable) {
  requireRange(bytes, 0, 64, executable, "DOS header");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Invalid PE executable ${executable}: missing MZ signature.`);
  }

  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 24, executable, "PE and COFF headers");
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Invalid PE executable ${executable}: missing PE signature.`);
  }

  const coffOffset = peOffset + 4;
  const optionalHeaderSize = bytes.readUInt16LE(coffOffset + 16);
  const optionalHeaderOffset = coffOffset + 20;
  if (optionalHeaderSize < 70) {
    throw new Error(`Invalid PE executable ${executable}: Optional Header is too small for Subsystem.`);
  }
  requireRange(bytes, optionalHeaderOffset, optionalHeaderSize, executable, "Optional Header");

  const magic = bytes.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`Invalid PE executable ${executable}: unsupported Optional Header magic 0x${magic.toString(16)}.`);
  }
  return bytes.readUInt16LE(optionalHeaderOffset + 68);
}

function requireRange(bytes, offset, length, executable, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset > bytes.length - length) {
    throw new Error(`Invalid PE executable ${executable}: truncated ${label}.`);
  }
}
