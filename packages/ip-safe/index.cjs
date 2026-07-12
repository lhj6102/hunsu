"use strict";

const ipaddr = require("ipaddr.js");

function parseAddress(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("IP address must be a bounded string.");
  }
  if (value.includes(".")) {
    const dotted = value.slice(value.lastIndexOf(":") + 1);
    if (!ipaddr.IPv4.isValidFourPartDecimal(dotted)) {
      throw new TypeError("IPv4 text must use strict four-part decimal notation.");
    }
  }
  return ipaddr.parse(value);
}

function isLoopback(value) {
  try {
    const address = parseAddress(value);
    if (address.kind() === "ipv6" && address.isIPv4MappedAddress()) {
      return address.toIPv4Address().range() === "loopback";
    }
    return address.range() === "loopback";
  } catch {
    return false;
  }
}

function isV4Format(value) {
  return typeof value === "string" && ipaddr.IPv4.isValidFourPartDecimal(value);
}

function toBuffer(value, target, offset = 0) {
  const bytes = Uint8Array.from(parseAddress(value).toByteArray());
  if (target === undefined) return Buffer.from(bytes);
  if (!(target instanceof Uint8Array)
    || !Number.isSafeInteger(offset)
    || offset < 0
    || offset + bytes.byteLength > target.byteLength) {
    throw new RangeError("IP buffer target is too small or has an invalid offset.");
  }
  target.set(bytes, offset);
  return target;
}

function toString(value, offset = 0, length) {
  if (!(value instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("IP bytes and offset are invalid.");
  }
  const available = value.byteLength - offset;
  const byteLength = length === undefined ? available : length;
  if (!Number.isSafeInteger(byteLength)
    || (byteLength !== 4 && byteLength !== 16)
    || byteLength > available) {
    throw new RangeError("IP byte length must be exactly 4 or 16.");
  }
  return ipaddr.fromByteArray([...value.subarray(offset, offset + byteLength)]).toString();
}

module.exports = Object.freeze({ isLoopback, isV4Format, toBuffer, toString });
