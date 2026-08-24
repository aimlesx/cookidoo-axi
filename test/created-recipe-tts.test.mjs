import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidCreatedRecipeTtsAnnotations,
  inferCreatedRecipeTtsAnnotations,
} from "../dist/created-recipe-tts.js";

function usageCode(code) {
  return (error) => {
    assert.equal(error?.name, "UsageError");
    assert.equal(error?.code, code);
    assert.equal(error?.exitCode, 2);
    return true;
  };
}

function tts(text, fragment, data) {
  return {
    type: "TTS",
    data,
    position: { offset: text.indexOf(fragment), length: fragment.length },
  };
}

test("Thermomix inference creates exact TTS data and is idempotent without mutating input", () => {
  const secondsText = "Miksuj 2 s/obr. 6.";
  const longSecondsText = "Blenduj 40 s/obr. 8.";
  const heatedText = "Podgrzewaj 5 min/80°C/obr. 3.";
  const reverseText = "Mieszaj 10 s/obr. wsteczne 2.";
  const unmatchedText = "Gotuj 5 min/Varoma/obr. 2.";
  const marker = { type: "INGREDIENT", data: { id: "fixture" } };
  const unrelatedTts = tts(secondsText, "Miksuj", { speed: "1" });
  const staleSameSpan = tts(secondsText, "2 s/obr. 6", { time: 999, speed: "1" });
  const unmatchedTts = tts(unmatchedText, "Varoma", { temperature: { value: "Varoma", unit: "C" } });
  const input = {
    name: "Fixture",
    instructions: [
      { type: "STEP", text: secondsText, annotations: [unrelatedTts, staleSameSpan, marker] },
      { type: "STEP", text: longSecondsText },
      { type: "STEP", text: heatedText },
      { type: "STEP", text: reverseText },
      { type: "STEP", text: unmatchedText, annotations: [unmatchedTts] },
    ],
  };
  const untouched = structuredClone(input);

  const inferred = inferCreatedRecipeTtsAnnotations(input);
  assert.deepEqual(input, untouched);
  assert.deepEqual(inferred.instructions[0].annotations, [
    unrelatedTts,
    marker,
    tts(secondsText, "2 s/obr. 6", { time: 2, speed: "6" }),
  ]);
  assert.deepEqual(inferred.instructions[1].annotations, [
    tts(longSecondsText, "40 s/obr. 8", { time: 40, speed: "8" }),
  ]);
  assert.deepEqual(inferred.instructions[2].annotations, [
    tts(heatedText, "5 min/80°C/obr. 3", {
      time: 300,
      speed: "3",
      temperature: { value: "80", unit: "C" },
    }),
  ]);
  assert.deepEqual(inferred.instructions[3].annotations, [
    tts(reverseText, "10 s/obr. wsteczne 2", { time: 10, speed: "2", direction: "CCW" }),
  ]);
  assert.deepEqual(inferred.instructions[4], input.instructions[4]);
  assert.deepEqual(inferCreatedRecipeTtsAnnotations(inferred), inferred);
});

test("Thermomix inference fails closed for absent instructions, no matches, and uncertain syntax", () => {
  assert.throws(() => inferCreatedRecipeTtsAnnotations({ name: "fixture" }),
    usageCode("THERMOMIX_INSTRUCTIONS_REQUIRED"));
  assert.throws(() => inferCreatedRecipeTtsAnnotations({ instructions: [] }),
    usageCode("THERMOMIX_SETTINGS_NOT_FOUND"));
  for (const text of [
    "Gotuj 5 min/Varoma/obr. 2.",
    "Mieszaj 1-2 min/obr. 3.",
    "Mieszaj 1 do 2 min/obr. 3.",
    "Mieszaj 1−2 min/obr. 3.",
    "Mieszaj 1 … 2 min/obr. 3.",
    "Mieszaj 1...2 min/obr. 3.",
    "Mieszaj 1⋯2 min/obr. 3.",
    "Mieszaj 2 min/obr. 3-4.",
    "Mieszaj -2 min/obr. 3.",
    "Mieszaj +2 min/obr. 3.",
    "Mieszaj - 2 min/obr. 3.",
    "Mieszaj − 2 min/obr. 3.",
    "Mieszaj + 2 min/obr. 3.",
    "Mieszaj 2.5 min/obr. 3.",
    "Mieszaj 2,5 min/obr. 3.",
    "Mieszaj .5 min/obr. 3.",
    "Mieszaj ,5 min/obr. 3.",
    "Mieszaj 2 min/obr. 10.5.",
    "Mieszaj 2 min/obr. 10,5.",
    "Użyj trybu blendowanie.",
  ]) {
    assert.throws(
      () => inferCreatedRecipeTtsAnnotations({ instructions: [{ type: "STEP", text }] }),
      usageCode("THERMOMIX_SETTINGS_NOT_FOUND"),
      text,
    );
  }
});

test("Thermomix inference bounds annotation amplification and transformed body size", () => {
  const setting = "Miksuj 2 s/obr. 6.";
  assert.throws(
    () => inferCreatedRecipeTtsAnnotations({
      instructions: [{ type: "STEP", text: Array(33).fill(setting).join(" ") }],
    }),
    usageCode("THERMOMIX_SETTINGS_LIMIT_EXCEEDED"),
  );

  assert.throws(
    () => inferCreatedRecipeTtsAnnotations({
      instructions: Array.from({ length: 5 }, () => ({
        type: "STEP",
        text: Array(32).fill(setting).join(" "),
      })),
    }),
    usageCode("THERMOMIX_SETTINGS_LIMIT_EXCEEDED"),
  );

  assert.throws(
    () => inferCreatedRecipeTtsAnnotations({
      instructions: [{ type: "STEP", text: `${"x".repeat(999_900)} ${setting}` }],
    }),
    usageCode("BODY_TOO_LARGE"),
  );
});

test("TTS validation accepts forward-compatible non-TTS data and enforces types and UTF-16 spans", () => {
  const text = "🍨 Miksuj 2 s/obr. 6.";
  const fragment = "2 s/obr. 6";
  const valid = {
    instructions: [{
      type: "STEP",
      text,
      annotations: [
        { type: "FUTURE", arbitrary: { shape: true } },
        tts(text, fragment, { time: 2, speed: "6", direction: "CW" }),
      ],
    }],
  };
  assert.doesNotThrow(() => assertValidCreatedRecipeTtsAnnotations(valid));
  assert.equal(text.slice(valid.instructions[0].annotations[1].position.offset,
    valid.instructions[0].annotations[1].position.offset +
      valid.instructions[0].annotations[1].position.length), fragment);

  const malformed = [
    { type: "TTS", position: { offset: 0, length: 1 } },
    { type: "TTS", data: { time: 1.5 }, position: { offset: 0, length: 1 } },
    { type: "TTS", data: { speed: 3 }, position: { offset: 0, length: 1 } },
    { type: "TTS", data: { direction: "REVERSE" }, position: { offset: 0, length: 1 } },
    { type: "TTS", data: { temperature: { value: 80, unit: "C" } }, position: { offset: 0, length: 1 } },
    { type: "TTS", data: {}, position: { offset: -1, length: 1 } },
    { type: "TTS", data: {}, position: { offset: text.length, length: 2 } },
    { type: "TTS", data: {}, position: { offset: 1, length: 1 } },
    { type: "TTS", data: {}, position: { offset: 0, length: 1 } },
  ];
  for (const annotation of malformed) {
    assert.throws(
      () => assertValidCreatedRecipeTtsAnnotations({
        instructions: [{ type: "STEP", text, annotations: [annotation] }],
      }),
      (error) => {
        assert.equal(usageCode("INVALID_TTS_ANNOTATION")(error), true);
        assert.deepEqual(error.details, {
          bodyField: "instructions",
          instructionIndex: 0,
          annotationIndex: 0,
        });
        assert.doesNotMatch(JSON.stringify(error.toJSON()), /Miksuj/u);
        return true;
      },
    );
  }
});
