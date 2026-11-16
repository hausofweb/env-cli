import { describe, expect, it } from "vitest";

import { parseEnvContent, serializeEnvContent } from "./env-parser";

describe(parseEnvContent, () => {
  // An empty value read as undefined would be written back as KEY=undefined.
  it("keeps an empty quoted value as an empty string", () => {
    const parsed = parseEnvContent(`EMPTY_DOUBLE=""\nEMPTY_SINGLE=''\nSET="x"`);

    expect(parsed).toStrictEqual({
      EMPTY_DOUBLE: "",
      EMPTY_SINGLE: "",
      SET: "x",
    });
    expect(serializeEnvContent(parsed)).not.toContain("undefined");
  });
});
