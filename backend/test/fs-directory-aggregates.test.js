import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FsSearchIndexStore } from "../src/storage/fs/search/FsSearchIndexStore.js";
import { DbTables } from "../src/constants/index.js";

function fixture(t, rows) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE ${DbTables.FS_SEARCH_INDEX_ENTRIES} (
    mount_id TEXT, fs_path TEXT, is_dir INTEGER, size INTEGER, modified_ms INTEGER,
    UNIQUE (mount_id, fs_path)
  )`);
  const insert = sqlite.prepare(`INSERT INTO ${DbTables.FS_SEARCH_INDEX_ENTRIES} VALUES (?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(...row);
  return new FsSearchIndexStore({
    prepare: sql => ({
      bind: (...params) => ({
        all: async () => ({ results: sqlite.prepare(sql).all(...params).map(row => ({ ...row })) }),
      }),
    }),
  });
}

test("long directory prefixes aggregate only their literal descendants and mount", async t => {
  const parent = "/telegram/_cloudpaste_diagnostics/move-check-20261120/long_%_folder/";
  const store = fixture(t, [
    ["m", parent + "child/", 1, 0, 10],
    ["m", parent + "child/first.bin", 0, 12, 20],
    ["m", parent + "child/deeper/second.bin", 0, 8, 30],
    ["m", parent + "direct.bin", 0, 200, 100],
    ["m", parent.replace("long_%_folder", "long_XYZ_folder") + "child/other.bin", 0, 500, 900],
    ["other", parent + "child/other-mount.bin", 0, 600, 1000],
    ["m", parent.slice(0, -1) + "-sibling/child/other.bin", 0, 700, 1100],
  ]);
  assert.deepEqual(await store.getChildDirectoryAggregates("m", parent.slice(0, -1)), [{
    dir_path: parent + "child/", total_size: 20, latest_modified_ms: 30, entry_count: 3,
  }]);
});

test("Unicode and emoji directory names use SQLite character offsets", async t => {
  const parent = "/telegram/备份😀/归档/";
  const store = fixture(t, [["m", parent + "子目录/文件.txt", 0, 7, 42]]);
  assert.deepEqual(await store.getChildDirectoryAggregates("m", parent), [{
    dir_path: parent + "子目录/", total_size: 7, latest_modified_ms: 42, entry_count: 1,
  }]);
});

test("root aggregation keeps directory boundaries and is case sensitive", async t => {
  const store = fixture(t, [
    ["m", "/A/f.bin", 0, 1, 1],
    ["m", "/a/f.bin", 0, 2, 2],
    ["m", "/file.bin", 0, 3, 3],
  ]);
  assert.deepEqual(await store.getChildDirectoryAggregates("m", "/"), [
    { dir_path: "/A/", total_size: 1, latest_modified_ms: 1, entry_count: 1 },
    { dir_path: "/a/", total_size: 2, latest_modified_ms: 2, entry_count: 1 },
  ]);
  assert.deepEqual(await store.getChildDirectoryAggregates("m", "/absent"), []);
});
