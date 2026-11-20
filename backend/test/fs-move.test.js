import test from "node:test";
import assert from "node:assert/strict";
import { moveItem } from "../src/storage/fs/features/move.js";
import { CAPABILITIES } from "../src/storage/interfaces/capabilities/index.js";
import { enforceDriverContract } from "../src/storage/factory/DriverContractEnforcer.js";

function fixture(options = {}) {
  const calls = [];
  const driver = {
    hasCapability: capability => options.readOnly ? capability === CAPABILITIES.READER : true,
    getFileInfo: async path => {
      if (options.missingSource && path === "/source/file.txt") return null;
      return { isDirectory: path === "/target" ? !options.invalidParent : options.directory === true };
    },
    exists: async () => {
      if (options.checkFailed) throw new Error("upstream unavailable");
      return options.conflict === true;
    },
    renameItem: async (...args) => {
      calls.push(args);
      return options.result ?? { success: true };
    },
  };
  const fs = {
    mountManager: {
      db: {},
      getDriverByPath: async path => ({
        driver,
        mount: { id: path.startsWith("/other/") ? "other" : "telegram" },
        subPath: path.replace(/^\/(telegram|other)/, "") || "/",
      }),
    },
    emitCacheInvalidation: event => calls.push({ event }),
  };
  return { fs, calls };
}

test("same-mount move keeps filename, calls native rename once and invalidates both folders", async () => {
  const { fs, calls } = fixture();
  const result = await moveItem(fs, "/telegram/source/file.txt", "/telegram/target/", "admin", "admin");
  assert.deepEqual(result, { source: "/telegram/source/file.txt", target: "/telegram/target/file.txt" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["/source/file.txt", "/target/file.txt"]);
  assert.equal(calls[0][2].overwrite, false);
  assert.ok(calls[1].event.paths.includes("/telegram/source/"));
  assert.ok(calls[1].event.paths.includes("/telegram/target/"));
});

test("directory moves keep directory semantics and do not copy or delete contents", async () => {
  const { fs, calls } = fixture({ directory: true });
  const result = await moveItem(fs, "/telegram/source/folder/", "/telegram/target", "admin", "admin");
  assert.equal(result.target, "/telegram/target/folder/");
  assert.deepEqual(calls[0].slice(0, 2), ["/source/folder/", "/target/folder/"]);
});

test("directory moves satisfy the real driver path and receipt contract", async () => {
  const { fs, calls } = fixture({ directory: true });
  const resolve = fs.mountManager.getDriverByPath;
  fs.mountManager.getDriverByPath = async (...args) => {
    const context = await resolve(...args);
    context.driver.renameItem = enforceDriverContract({
      getType: () => "TELEGRAM",
      renameItem: async (...renameArgs) => {
        calls.push(renameArgs);
        return { success: true, source: renameArgs[2].oldPath, target: renameArgs[2].newPath };
      },
    }).renameItem;
    return context;
  };
  const result = await moveItem(fs, "/telegram/source/folder/", "/telegram/target", "admin", "admin");
  assert.equal(result.target, "/telegram/target/folder/");
});

for (const [name, source, destination, options, message] of [
  ["same directory", "/telegram/source/file.txt", "/telegram/source", {}, /已在此目录/],
  ["folder into itself", "/telegram/source/folder", "/telegram/source/folder", {}, /自身/],
  ["folder into descendant without trailing slash", "/telegram/source/folder", "/telegram/source/folder/sub", {}, /自身/],
  ["mount root", "/telegram/", "/other/target", {}, /挂载根/],
  ["cross mount", "/telegram/source/file.txt", "/other/target", {}, /同一存储/],
  ["path traversal", "/telegram/source/file.txt", "/telegram/target/../else", {}, /名称不能/],
  ["read only", "/telegram/source/file.txt", "/telegram/target", { readOnly: true }, /不支持移动/],
  ["missing source", "/telegram/source/file.txt", "/telegram/target", { missingSource: true }, /源路径不存在/],
  ["destination is a file", "/telegram/source/file.txt", "/telegram/target", { invalidParent: true }, /目标文件夹/],
  ["name conflict", "/telegram/source/file.txt", "/telegram/target", { conflict: true }, /同名/],
  ["existence check failure", "/telegram/source/file.txt", "/telegram/target", { checkFailed: true }, /upstream unavailable/],
]) {
  test(`rejects ${name} before any mutation`, async () => {
    const { fs, calls } = fixture(options);
    await assert.rejects(moveItem(fs, source, destination, "admin", "admin"), message);
    assert.equal(calls.length, 0);
  });
}

test("a negative driver result cannot become a successful move", async () => {
  const { fs, calls } = fixture({ result: { success: false, message: "source changed" } });
  await assert.rejects(moveItem(fs, "/telegram/source/file.txt", "/telegram/target", "admin", "admin"), /source changed/);
  assert.equal(calls.length, 1);
});

test("an explicit failure takes precedence over a legacy success status", async () => {
  const { fs, calls } = fixture({ result: { success: false, status: "success", message: "source changed" } });
  await assert.rejects(moveItem(fs, "/telegram/source/file.txt", "/telegram/target", "admin", "admin"), /source changed/);
  assert.equal(calls.length, 1);
});

test("similar directory prefix is not mistaken for a descendant", async () => {
  const { fs } = fixture();
  fs.mountManager.getDriverByPath = async path => ({
    driver: {
      hasCapability: () => true,
      getFileInfo: async () => ({ isDirectory: true }),
      exists: async () => false,
      renameItem: async () => ({ success: true }),
    },
    mount: { id: "telegram" },
    subPath: path.replace("/telegram", ""),
  });
  await moveItem(fs, "/telegram/folder", "/telegram/folder-other", "admin", "admin");
});
