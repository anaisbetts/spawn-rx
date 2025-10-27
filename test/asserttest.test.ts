/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect } from "bun:test";

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("The test runner", () => {
  it("should pass this test", async () => {
    await delay(1000);
    expect(true).toBeTruthy();
  });
});
