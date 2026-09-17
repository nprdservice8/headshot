import assert from "node:assert/strict";
import { test } from "node:test";
import { NAME_MAX_LENGTH } from "./constants.ts";
import {
  BUTTON,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  type InputMessage,
  sanitizeName,
} from "./protocol.ts";

const validInput: InputMessage = {
  type: "input",
  seq: 42,
  buttons: BUTTON.FORWARD | BUTTON.FIRE,
  yaw: 1.5,
  pitch: -0.3,
  viewTick: 1234.5,
  weapon: 0,
};

test("input messages round-trip", () => {
  assert.deepEqual(decodeClientMessage(encodeMessage(validInput)), validInput);
});

test("join messages round-trip with a cleaned name", () => {
  assert.deepEqual(decodeClientMessage('{"type":"join","name":"  Ana\\u0007 "}'), {
    type: "join",
    name: "Ana",
  });
});

test("server messages decode to what was encoded", () => {
  const message = { type: "match", state: "ended", winnerId: 3 } as const;
  assert.deepEqual(decodeServerMessage(encodeMessage(message)), message);
});

test("rejects malformed client messages", () => {
  const bad = [
    "not json",
    "null",
    "42",
    "[]",
    '{"type":"teleport","x":0}',
    '{"type":"join"}',
    '{"type":"join","name":"   "}',
    '{"type":"join","name":7}',
    JSON.stringify({ ...validInput, seq: -1 }),
    JSON.stringify({ ...validInput, seq: 1.5 }),
    JSON.stringify({ ...validInput, buttons: 512 }),
    JSON.stringify({ ...validInput, buttons: "1" }),
    JSON.stringify({ ...validInput, yaw: 10 }),
    JSON.stringify({ ...validInput, pitch: 2 }),
    JSON.stringify({ ...validInput, yaw: null }),
    JSON.stringify({ ...validInput, viewTick: -5 }),
    JSON.stringify({ ...validInput, viewTick: undefined }),
  ];
  for (const text of bad) assert.equal(decodeClientMessage(text), null, text);
});

test("sanitizeName trims, strips control characters and caps the length", () => {
  assert.equal(sanitizeName("x".repeat(40)), "x".repeat(NAME_MAX_LENGTH));
  assert.equal(sanitizeName("a\nb\tc"), "abc");
  assert.equal(sanitizeName("x".repeat(NAME_MAX_LENGTH * 4 + 1)), null);
  assert.equal(sanitizeName(""), null);
});
