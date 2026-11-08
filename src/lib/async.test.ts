import { describe, expect, it } from "vitest";

import { mapSequentially } from "./async";

describe(mapSequentially, () => {
  it("never starts a task before the previous one settles", async () => {
    const log: string[] = [];

    const results = await mapSequentially([1, 2, 3], async (item) => {
      log.push(`start ${item}`);
      await Promise.resolve();
      log.push(`end ${item}`);

      return item * 10;
    });

    expect(results).toStrictEqual([10, 20, 30]);
    expect(log).toStrictEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
    ]);
  });

  it("stops at the first rejection without running later items", async () => {
    const started: number[] = [];

    await expect(
      mapSequentially([1, 2, 3], async (item) => {
        started.push(item);
        await Promise.resolve();

        if (item === 2) {
          throw new Error("item 2 failed");
        }

        return item;
      })
    ).rejects.toThrow("item 2 failed");
    expect(started).toStrictEqual([1, 2]);
  });
});
