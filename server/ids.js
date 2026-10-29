// Time-sortable 64-bit IDs ("snowflakes"): 42 bits of milliseconds since
// the epoch below, 10 bits of node id, 12 bits of per-millisecond sequence.
// Sorting by ID sorts by creation time, and several server nodes can create
// IDs at once without coordinating.
'use strict';
const crypto = require('node:crypto');
const { nodeId } = require('./config');

const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z
let lastMs = 0n;
let seq = 0n;

function newId() {
  let now = BigInt(Date.now());
  if (now === lastMs) {
    seq = (seq + 1n) & 0xfffn;
    if (seq === 0n) { while (BigInt(Date.now()) <= lastMs); now = BigInt(Date.now()); }
  } else {
    seq = 0n;
  }
  lastMs = now;
  return (((now - EPOCH) << 22n) | (BigInt(nodeId & 0x3ff) << 12n) | seq).toString();
}

function idTime(id) {
  return Number((BigInt(id) >> 22n) + EPOCH);
}

// Random URL-safe string for tokens and invite codes.
function randomCode(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { newId, idTime, randomCode };
