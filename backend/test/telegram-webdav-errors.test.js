import assert from "node:assert/strict";
import test from "node:test";
import { sendDocument, getFileInfo, getUploadSemaphore } from "../src/storage/drivers/telegram/TelegramOperations.js";
import { withWebDAVErrorHandling } from "../src/webdav/utils/errorUtils.js";

const driver = () => ({
  config: { id: "telegram-webdav-regression" },
  apiBaseUrl: "https://telegram.invalid",
  botToken: "test-token",
  targetChatId: "-100000",
  uploadConcurrency: 1,
  verifyAfterUpload: false,
  _sleep: async () => {
    throw new Error("Unexpected retry");
  },
});

const successfulReply = () =>
  Response.json({
    ok: true,
    result: { message_id: 7, document: { file_id: "test-file", file_unique_id: "test-unique" } },
  });

test("Telegram HTTP failure stays a gateway error through WebDAV and is not resent", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: false, error_code: 500, description: "Synthetic upstream failure" }, { status: 500 }),
  );
  const logMock = t.mock.method(console, "error", () => {});
  const response = await withWebDAVErrorHandling("PUT", () =>
    sendDocument(driver(), new Blob(["backup"]), { filename: "backup.bin" }),
  );
  assert.equal(fetchMock.mock.callCount(), 1);
  const error = logMock.mock.calls[0].arguments[1];
  assert.equal(error.code, "DRIVER_ERROR.TELEGRAM_SEND_DOCUMENT_FAILED");
  assert.equal(error.details.status, 500);
  assert.equal(error.retryable, false);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /HTTP\/1\.1 502 Bad Gateway/);
});

test("Malformed successful Telegram receipt is rejected without a second upload", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ok: true, result: { message_id: 7 } }),
  );
  t.mock.method(console, "error", () => {});
  const response = await withWebDAVErrorHandling("PUT", () =>
    sendDocument(driver(), new Blob(["backup"]), { filename: "backup.bin" }),
  );
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(response.status, 502);
});

test("Successful multipart upload preserves file bytes and receipt", async (t) => {
  const file = new Blob([Uint8Array.from([0, 1, 255, 13, 10])]);
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(init.body.get("chat_id"), "-100000");
    const document = init.body.get("document");
    assert.equal(document.name, "backup.bin");
    assert.deepEqual(await document.arrayBuffer(), await file.arrayBuffer());
    return successfulReply();
  });
  assert.deepEqual(await sendDocument(driver(), file, { filename: "backup.bin" }), {
    messageId: 7,
    fileId: "test-file",
    fileUniqueId: "test-unique",
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("Explicit Telegram rate limiting may retry once before succeeding", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
      : successfulReply();
  });
  const d = driver();
  const waits = [];
  d._sleep = async (ms) => waits.push(ms);
  const result = await sendDocument(d, new Blob(["backup"]), { filename: "backup.bin" });
  assert.equal(result.fileId, "test-file");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1200]);
});

test("An unrelated internal exception still returns HTTP 500", async (t) => {
  t.mock.method(console, "error", () => {});
  const response = await withWebDAVErrorHandling("PUT", async () => {
    throw new Error("Synthetic internal failure");
  });
  assert.equal(response.status, 500);
});

const verifiedReply = (size) =>
  Response.json({
    ok: true,
    result: { message_id: 7, document: { file_id: "test-file", file_unique_id: "test-unique", file_size: size } },
  });

test("Confirmed upload survives an unavailable getFile without retrying either request", async (t) => {
  const d = { ...driver(), verifyAfterUpload: true };
  const calls = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return url.endsWith("/sendDocument")
      ? verifiedReply(6)
      : Response.json({ ok: false, error_code: 500 }, { status: 500 });
  });
  const result = await sendDocument(d, new Blob(["backup"]));
  assert.equal(result.fileId, "test-file");
  assert.equal(calls.length, 2);
});

test("Upload receipt size mismatch always fails before getFile", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => verifiedReply(5));
  await assert.rejects(
    sendDocument({ ...driver(), verifyAfterUpload: true }, new Blob(["backup"])),
    (e) => e.code === "DRIVER_ERROR.TELEGRAM_UPLOAD_VERIFY_FAILED" && e.retryable === false,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("getFile size mismatch is never ignored even when receipt size matched", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("/sendDocument")
      ? verifiedReply(6)
      : Response.json({ ok: true, result: { file_path: "synthetic.bin", file_size: 5 } }),
  );
  await assert.rejects(
    sendDocument({ ...driver(), verifyAfterUpload: true }, new Blob(["backup"])),
    (e) => e.code === "DRIVER_ERROR.TELEGRAM_UPLOAD_VERIFY_FAILED",
  );
});

test("Unverified receipt cannot turn failed getFile into a successful upload", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("/sendDocument")
      ? successfulReply()
      : Response.json({ ok: false, error_code: 500 }, { status: 500 }),
  );
  await assert.rejects(
    sendDocument({ ...driver(), verifyAfterUpload: true }, new Blob(["backup"])),
    (e) => e.code === "DRIVER_ERROR.TELEGRAM_GET_FILE_FAILED" && e.retryable === false,
  );
});

test("Slow getFile is aborted after five seconds and uses the checked receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = t.mock.method(console, "warn", () => {});
  let notifyGetFile;
  const getFileStarted = new Promise((resolve) => { notifyGetFile = resolve; });
  let verificationSignal;
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/sendDocument")) return verifiedReply(6);
    verificationSignal = init.signal;
    notifyGetFile();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    });
  });
  const pending = sendDocument({ ...driver(), verifyAfterUpload: true }, new Blob(["backup"]));
  await getFileStarted;
  t.mock.timers.tick(4999);
  assert.equal(verificationSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).fileId, "test-file");
  assert.equal(verificationSignal.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(JSON.parse(warnings.mock.calls[0].arguments[0]).getFile, "timeout");
});

test("Missing sizes in both Telegram responses cannot pass verification", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("/sendDocument")
      ? successfulReply()
      : Response.json({ ok: true, result: { file_path: "synthetic.bin" } }),
  );
  await assert.rejects(
    sendDocument({ ...driver(), verifyAfterUpload: true }, new Blob(["backup"])),
    (e) => e.code === "DRIVER_ERROR.TELEGRAM_UPLOAD_VERIFY_FAILED" && e.retryable === false,
  );
});

test("A queued metadata query aborts without taking another request's permit", async (t) => {
  const d = { ...driver(), config: { id: "telegram-queue-abort" } };
  const sem = getUploadSemaphore(d.config.id, 1);
  const release = await sem.acquire();
  const controller = new AbortController();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Canceled queued query must never fetch");
  });
  const pending = getFileInfo(d, "test-file", { signal: controller.signal, maxAttempts: 1 });
  const rejected = assert.rejects(pending, (e) => e.name === "AbortError");
  assert.equal(sem.queue.length, 1);
  controller.abort();
  await rejected;
  assert.equal(sem.queue.length, 0);
  assert.equal(sem.current, 1);
  assert.equal(fetchMock.mock.callCount(), 0);
  release();
  assert.equal(sem.current, 0);
  const releaseNext = await sem.acquire();
  releaseNext();
});

test("A metadata query aborted before admission never starts a request", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => successfulReply());
  await assert.rejects(
    getFileInfo(driver(), "test-file", { signal: controller.signal, maxAttempts: 1 }),
    (e) => e.name === "AbortError",
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});
