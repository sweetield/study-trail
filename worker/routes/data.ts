import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth } from "../lib/session";
import { verifyPassword } from "../lib/crypto";
import { HttpError } from "../lib/validate";
import { audit } from "../lib/audit";

export const dataRoutes = new Hono<AppEnv>();
dataRoutes.use("*", requireAuth, requireAdmin);

const BACKUP_FORMAT = "xueji-backup";
const BACKUP_VERSION = 2;
const MAX_ROWS = 200_000;

// 按外键依赖顺序排列：插入时正序，删除时倒序
const TABLES = {
  classes: ["id", "name", "created_at"],
  users: [
    "id", "username", "name", "password_hash", "role", "class_id", "active",
    "must_change_password", "failed_attempts", "locked_until", "last_login_at", "created_at",
  ],
  tasks: ["id", "title", "description", "tech_tags", "class_id", "due_date", "status", "require_review", "created_at", "updated_at"],
  task_steps: ["id", "task_id", "title", "position"],
  progress: [
    "task_id", "user_id", "status", "percent", "note", "link", "review_comment", "score", "reviewer_id",
    "submitted_at", "reviewed_at", "updated_at",
  ],
  step_checks: ["user_id", "step_id", "task_id", "checked_at"],
  study_logs: ["id", "user_id", "task_id", "minutes", "content", "log_date", "created_at"],
  progress_events: ["id", "task_id", "user_id", "action", "comment", "score", "actor_id", "created_at"],
} as const satisfies Record<string, readonly string[]>;

type TableName = keyof typeof TABLES;
const TABLE_NAMES = Object.keys(TABLES) as TableName[];
type Cell = string | number | null;

dataRoutes.get("/export", async (c) => {
  const results = await c.env.DB.batch(
    TABLE_NAMES.map((t) => c.env.DB.prepare(`SELECT ${TABLES[t].join(", ")} FROM ${t} ORDER BY rowid`)),
  );
  const tables = Object.fromEntries(TABLE_NAMES.map((t, i) => [t, results[i].results]));
  await audit(c, "导出数据备份").run();
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  c.header("Content-Disposition", `attachment; filename="xueji-backup-${stamp}.json"`);
  return c.json({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now.toISOString(), tables });
});

function readRows(tables: Record<string, unknown>, name: TableName): Cell[][] {
  const raw = tables[name] ?? [];
  if (!Array.isArray(raw)) throw new HttpError(400, `备份文件中的 ${name} 数据格式错误`);
  const columns = TABLES[name];
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new HttpError(400, `备份文件中的 ${name} 数据格式错误`);
    return columns.map((col) => {
      const value = (row as Record<string, unknown>)[col];
      if (value === undefined || value === null) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      throw new HttpError(400, `备份文件中的 ${name}.${col} 数据格式错误`);
    });
  });
}

dataRoutes.post("/import", async (c) => {
  const body = await c.req.json<{ password?: unknown; backup?: unknown }>();
  const me = c.get("user");

  const current = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first<{ password_hash: string }>();
  if (!current || typeof body.password !== "string" || !(await verifyPassword(body.password, current.password_hash))) {
    throw new HttpError(403, "当前管理员密码错误");
  }

  const backup = body.backup as { format?: unknown; version?: unknown; tables?: unknown } | null;
  if (!backup || backup.format !== BACKUP_FORMAT || typeof backup.tables !== "object" || !backup.tables) {
    throw new HttpError(400, "不是有效的学迹备份文件");
  }
  if (backup.version !== BACKUP_VERSION) throw new HttpError(400, "备份文件版本不受支持");

  const tables = backup.tables as Record<string, unknown>;
  const data = Object.fromEntries(TABLE_NAMES.map((t) => [t, readRows(tables, t)])) as Record<TableName, Cell[][]>;

  const total = TABLE_NAMES.reduce((sum, t) => sum + data[t].length, 0);
  if (total > MAX_ROWS) throw new HttpError(400, "备份数据量过大");

  const roleIdx = TABLES.users.indexOf("role");
  const activeIdx = TABLES.users.indexOf("active");
  if (!data.users.some((u) => u[roleIdx] === "admin" && Number(u[activeIdx]) === 1)) {
    throw new HttpError(400, "备份中没有可用的管理员账号，恢复后将无法登录，已取消");
  }

  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM notifications"),
    ...[...TABLE_NAMES].reverse().map((t) => db.prepare(`DELETE FROM ${t}`)),
  ];
  for (const t of TABLE_NAMES) {
    // 插入任务与进度会触发通知和历史触发器，恢复时需清掉这些副作用后再写入备份中的历史
    if (t === "progress_events") statements.push(db.prepare("DELETE FROM notifications"), db.prepare("DELETE FROM progress_events"));
    const columns = TABLES[t];
    const insert = db.prepare(`INSERT INTO ${t} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of data[t]) statements.push(insert.bind(...row));
  }

  try {
    // D1 batch 在单个事务中执行，任一语句失败会整体回滚
    await db.batch(statements);
  } catch (err) {
    console.error(err);
    throw new HttpError(400, "备份数据不完整或存在冲突，恢复失败，原有数据未改动");
  }

  await audit(c, "从备份恢复数据", `共 ${total} 条记录`, { id: null, name: me.name }).run();
  const counts = Object.fromEntries(TABLE_NAMES.map((t) => [t, data[t].length]));
  return c.json({ ok: true, counts });
});
