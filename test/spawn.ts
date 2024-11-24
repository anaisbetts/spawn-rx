/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-expressions */
import { expect } from "chai";
import "./support";

import { spawn, spawnPromise, spawnDetachedPromise } from "../src/index";

import type { Observable } from "rxjs";
import { of } from "rxjs";

const uuidRegex =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("The spawnPromise method", function () {
  it("should return a uuid when we call uuid", async function () {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    const result = await spawnPromise("uuid", []);
    expect(result.match(uuidRegex)).to.be.ok;
  });

  it("should split stdout and stderr when we call uuid", async function () {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    const result = await spawnPromise("uuid", [], { split: true });
    expect(result[0].match(uuidRegex)).to.be.ok;
    expect(result[1].match(uuidRegex)).to.not.be.ok;
  });

  it("should retur nthe exit code", async function () {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    try {
      await spawnPromise("false", [], { split: true });
      expect(false).to.be.true;
    } catch (e) {
      expect(e.code).to.be.equal(1);
    }
  });

  it("should not stdout and stderr when we call uuid with split false", async function () {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    const result = await spawnPromise("uuid", [], { split: false });
    expect(result.match(uuidRegex)).to.be.ok;
  });
});

describe("The spawnDetachedPromise method", function () {
  it("should return a uuid when we call uuid", async function () {
    // NB: Since we get run via npm run test, we know that npm bins are in our
    // PATH.
    const result = await spawnDetachedPromise("uuid", ["--help"]);
    expect(result.length > 10).to.be.ok;
  });
});

function wrapSplitObservableInPromise(
  obs: Observable<{
    source: any;
    text: any;
  }>,
): Promise<{
  stderr: string;
  stdout: string;
  error: Error | undefined;
}> {
  return new Promise((res) => {
    const out = { stderr: "", stdout: "", error: undefined };

    obs.subscribe(
      (x) => {
        if (x.source === "stdout") {
          out.stdout += x.text;
        } else {
          out.stderr += x.text;
        }
      },
      (e) => {
        out.error = e;
        res(out);
      },
      () => res(out),
    );
  });
}

describe("The spawn method", function () {
  it("should return a disposable subscription", async function () {
    // this only check the unsubscribe goes w/o error, not that the spawned process is killed
    // (difficult to do that, maybe iterate through child processes and check ?)
    spawn("sleep", ["2"]).subscribe().unsubscribe();
  });

  it("should return split stderr in a inner tag when called with split", async function () {
    // provide an invalid param to uuid so it complains on stderr
    const rxSpawn: Observable<{ source: any; text: any }> = spawn(
      "uuid",
      ["foo"],
      { split: true },
    ) as any;
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.stderr.length > 10).to.be.ok;
    expect(result.stdout).to.be.empty;
    expect(result.error).to.be.an("error");
  });

  it("should return split stdout in a inner tag when called with split", async function () {
    const rxSpawn: Observable<{ source: any; text: any }> = spawn("uuid", [], {
      split: true,
    });
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.stdout.match(uuidRegex)).to.be.ok;
    expect(result.stderr).to.be.empty;
    expect(result.error).to.be.undefined;
  });

  it("should ignore stderr if options.stdio = ignore", async function () {
    const rxSpawn: Observable<{ source: any; text: any }> = spawn(
      "uuid",
      ["foo"],
      { split: true, stdio: [null, null, "ignore"] },
    );
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.stderr).to.be.empty;
  });

  it("should ignore stdout if options.stdio = inherit", async function () {
    const rxSpawn: Observable<{ source: any; text: any }> = spawn("uuid", [], {
      split: true,
      stdio: [null, "inherit", null],
    });
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.stdout).to.be.empty;
  });

  it("should croak if stdin is provided but stdio.stdin is disabled", async function () {
    const stdin = of("a");
    const rxSpawn: Observable<{ source: any; text: any }> = spawn(
      "marked",
      [],
      {
        split: true,
        stdin: stdin,
        stdio: ["ignore", null, null],
      },
    );
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.error).to.be.an("error");
  });

  it("should subscribe to provided stdin", async function () {
    const stdin = of("a");
    const rxSpawn: Observable<{ source: any; text: any }> = spawn(
      "marked",
      [],
      {
        split: true,
        stdin: stdin,
      },
    );
    const result = await wrapSplitObservableInPromise(rxSpawn);
    expect(result.stdout.trim()).to.be.equal("<p>a</p>");
  });
});
