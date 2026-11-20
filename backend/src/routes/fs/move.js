import { jsonOk } from "../../utils/common.js";
import { MountManager } from "../../storage/managers/MountManager.js";
import { FileSystem } from "../../storage/fs/FileSystem.js";
import { moveItem } from "../../storage/fs/features/move.js";
import { usePolicy } from "../../security/policies/policies.js";
import { getEncryptionSecret } from "../../utils/environmentUtils.js";
import { ValidationError } from "../../http/errors.js";

export function registerMoveRoute(router, { getServiceParams }) {
  router.post(
    "/api/fs/move",
    async (c, next) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        throw new ValidationError("请求内容必须为有效 JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ValidationError("请提供源路径和目标目录");
      }
      c.set("jsonBody", body);
      await next();
    },
    usePolicy("fs.rename", {
      pathResolver: (c) => {
        const body = c.get("jsonBody");
        return [body?.sourcePath, body?.targetDirectory].filter((path) => typeof path === "string");
      },
    }),
    async (c) => {
      const { userIdOrInfo, userType } = getServiceParams(c.get("userInfo"));
      const { sourcePath, targetDirectory } = c.get("jsonBody");
      const manager = new MountManager(c.env.DB, getEncryptionSecret(c), c.get("repos"), { env: c.env });
      const result = await moveItem(new FileSystem(manager), sourcePath, targetDirectory, userIdOrInfo, userType);
      return jsonOk(c, result, "移动成功");
    },
  );
}
