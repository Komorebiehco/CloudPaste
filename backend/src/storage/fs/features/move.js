import { ValidationError, AppError, DriverError } from "../../../http/errors.js";
import { CAPABILITIES } from "../../interfaces/capabilities/index.js";
import { getBasename, getParentDir, normalizeFsViewPath, validateDirectoryPathSegments } from "../utils/FsInputValidator.js";

/**
 * Move within one mount, keeping the original name. Use the driver's native
 * rename rather than copy/delete, so Telegram only updates its directory index.
 */
export async function moveItem(fs, sourcePath, targetDirectory, userIdOrInfo, userType) {
  for (const path of [sourcePath, targetDirectory]) {
    if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f]/.test(path)) {
      throw new ValidationError("请提供有效的源路径和目标目录");
    }
    const validation = validateDirectoryPathSegments(path);
    if (!validation.valid) throw new ValidationError(validation.message);
  }
  const source = normalizeFsViewPath(sourcePath);
  const directory = normalizeFsViewPath(targetDirectory);
  const target = `${directory === "/" ? "" : directory}/${getBasename(source)}`;
  if (source === target) throw new ValidationError("文件已在此目录中");
  if (directory === source || directory.startsWith(`${source}/`)) {
    throw new ValidationError("不能将文件夹移动到自身或其子目录");
  }

  const sourceCtx = await fs.mountManager.getDriverByPath(source, userIdOrInfo, userType);
  const targetCtx = await fs.mountManager.getDriverByPath(target, userIdOrInfo, userType);
  const parentCtx = await fs.mountManager.getDriverByPath(directory, userIdOrInfo, userType);
  const { driver, mount, subPath } = sourceCtx;
  if (normalizeFsViewPath(subPath) === "/" || source === "/") {
    throw new ValidationError("不能移动存储挂载根目录");
  }
  if (mount.id !== targetCtx.mount.id || mount.id !== parentCtx.mount.id) {
    throw new ValidationError("请选择同一存储挂载内的目标文件夹");
  }
  if (!driver.hasCapability(CAPABILITIES.ATOMIC) || !driver.hasCapability(CAPABILITIES.WRITER)) {
    throw new ValidationError("此存储不支持移动");
  }

  const context = { mount, db: fs.mountManager.db, userIdOrInfo, userType };
  const sourceInfo = await driver.getFileInfo(subPath, { ...context, path: source, subPath });
  const parentInfo = await driver.getFileInfo(parentCtx.subPath, {
    ...context, path: directory, subPath: parentCtx.subPath,
  });
  if (!sourceInfo) throw new ValidationError("源路径不存在");
  if (!parentInfo?.isDirectory) throw new ValidationError("目标文件夹不存在");
  // Fail closed if the existence check fails; never overwrite a destination.
  if (await driver.exists(targetCtx.subPath, { ...context, path: target, subPath: targetCtx.subPath })) {
    throw new AppError("目标目录下已存在同名文件或文件夹，未移动", {
      status: 409, code: "FS.MOVE.TARGET_EXISTS",
    });
  }

  const isDirectory = sourceInfo.isDirectory === true;
  const oldPath = source + (isDirectory ? "/" : "");
  const newPath = target + (isDirectory ? "/" : "");
  const oldSubPath = subPath.replace(/\/+$/, "") + (isDirectory ? "/" : "");
  const newSubPath = targetCtx.subPath.replace(/\/+$/, "") + (isDirectory ? "/" : "");
  const result = await driver.renameItem(
    oldSubPath,
    newSubPath,
    { ...context, oldPath, newPath, oldSubPath, newSubPath, overwrite: false },
  );
  const confirmed = result === true || result?.success === true ||
    (result?.success === undefined && result?.status === "success");
  if (!confirmed) {
    throw new DriverError(result?.message || "未收到移动成功确认，请刷新源目录和目标目录核对", { expose: true });
  }
  fs.emitCacheInvalidation({
    mount, paths: [oldPath, newPath, getParentDir(source), `${directory}/`], reason: "rename",
  });
  return { source: oldPath, target: newPath };
}
