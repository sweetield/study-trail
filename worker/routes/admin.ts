import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth } from "../lib/session";
import { hashPassword } from "../lib/crypto";
import { audit } from "../lib/audit";
import { HttpError, dateStr, int, password, str, username } from "../lib/validate";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAuth, requireAdmin);

const ELIGIBLE = "u.role = 'student' AND u.active = 1 AND (t.class_id IS NULL OR t.class_id = u.class_id)";

function normalizeTags(value: unknown): string {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，\s]+/) : [];
  const tags = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
  if (tags.some((t) => t.length > 24)) throw new HttpError(400, "单个技术标签不能超过 24 个字符");
  return tags.join(",");
}

function normalizeSteps(value: unknown): { id?: number; title: string }[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 50) throw new HttpError(400, "学习步骤最多 50 个");
  return value
    .map((s) => (typeof s === "string" ? { title: s } : { id: s?.id ? Number(s.id) : undefined, title: String(s?.title ?? "") }))
    .map((s) => ({ ...s, title: s.title.trim() }))
    .filter((s) => s.title)
    .map((s) => {
      if (s.title.length > 200) throw new HttpError(400, "步骤标题不能超过 200 个字符");
      return s;
    });
}

/* ---------------- 概览 ---------------- */

adminRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const [counts, assigned, taskStats, activity, leaders] = await db.batch([
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role = 'student' AND active = 1) AS students,
         (SELECT COUNT(*) FROM tasks WHERE status = 'published') AS tasks,
         (SELECT COUNT(*) FROM progress p JOIN tasks t ON t.id = p.task_id WHERE p.status = 'submitted' AND t.status = 'published') AS pending,
         (SELECT COALESCE(SUM(minutes), 0) FROM study_logs WHERE created_at >= ?) AS week_minutes,
         (SELECT COUNT(DISTINCT user_id) FROM study_logs WHERE created_at >= ?) AS week_active`,
    ).bind(weekAgo, weekAgo),
    db.prepare(
      `SELECT COUNT(*) AS assigned, SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published'`,
    ),
    db.prepare(
      `SELECT t.id, t.title, t.due_date, COUNT(u.id) AS assigned,
              SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN p.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
              SUM(CASE WHEN p.status IN ('doing', 'rejected') THEN 1 ELSE 0 END) AS doing
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published'
        GROUP BY t.id ORDER BY t.id DESC LIMIT 8`,
    ),
    db.prepare(
      `SELECT * FROM (
         SELECT 'progress' AS kind, p.updated_at AS at, u.name AS user_name, t.title AS task_title, p.status AS detail, p.percent AS extra
           FROM progress p JOIN users u ON u.id = p.user_id JOIN tasks t ON t.id = p.task_id
         UNION ALL
         SELECT 'log' AS kind, l.created_at AS at, u.name, t.title, l.content, l.minutes
           FROM study_logs l JOIN users u ON u.id = l.user_id LEFT JOIN tasks t ON t.id = l.task_id
       ) ORDER BY at DESC LIMIT 12`,
    ),
    db.prepare(
      `SELECT u.id, u.name, c.name AS class_name,
              (SELECT COUNT(*) FROM progress p JOIN tasks t ON t.id = p.task_id
                WHERE p.user_id = u.id AND p.status = 'approved' AND t.status = 'published'
                  AND (t.class_id IS NULL OR t.class_id = u.class_id)) AS completed,
              (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.user_id = u.id) AS minutes
         FROM users u LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.role = 'student' AND u.active = 1
        ORDER BY completed DESC, minutes DESC LIMIT 5`,
    ),
  ]);
  return c.json({
    counts: counts.results[0],
    completion: assigned.results[0],
    tasks: taskStats.results,
    activity: activity.results,
    leaders: leaders.results,
  });
});

/* ---------------- 班级 ---------------- */

adminRoutes.get("/classes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.created_at, (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS student_count
       FROM classes c ORDER BY c.id`,
  ).all();
  return c.json({ classes: results });
});

adminRoutes.post("/classes", async (c) => {
  const body = await c.req.json();
  const name = str(body.name, "班级名称", { max: 40 });
  try {
    const row = await c.env.DB.prepare("INSERT INTO classes (name) VALUES (?) RETURNING id").bind(name).first();
    await audit(c, "新建班级", name).run();
    return c.json({ class: row });
  } catch {
    throw new HttpError(409, "班级名称已存在");
  }
});

adminRoutes.patch("/classes/:id", async (c) => {
  const id = int(c.req.param("id"), "班级ID")!;
  const name = str((await c.req.json()).name, "班级名称", { max: 40 });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE classes SET name = ? WHERE id = ?").bind(name, id),
    audit(c, "重命名班级", `#${id} → ${name}`),
  ]);
  return c.json({ ok: true });
});

adminRoutes.delete("/classes/:id", async (c) => {
  const id = int(c.req.param("id"), "班级ID")!;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET class_id = NULL WHERE class_id = ?").bind(id),
    c.env.DB.prepare("UPDATE tasks SET class_id = NULL WHERE class_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM classes WHERE id = ?").bind(id),
    audit(c, "删除班级", `#${id}`),
  ]);
  return c.json({ ok: true });
});

/* ---------------- 学员 ---------------- */

adminRoutes.get("/students", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.class_id, c.name AS class_name, u.active, u.must_change_password,
            u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM tasks t WHERE t.status = 'published' AND (t.class_id IS NULL OR t.class_id = u.class_id)) AS assigned,
            (SELECT COUNT(*) FROM progress p JOIN tasks t ON t.id = p.task_id
              WHERE p.user_id = u.id AND p.status = 'approved' AND t.status = 'published'
                AND (t.class_id IS NULL OR t.class_id = u.class_id)) AS completed,
            (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.user_id = u.id) AS minutes,
            (SELECT MAX(at) FROM (SELECT MAX(updated_at) AS at FROM progress WHERE user_id = u.id
                                  UNION ALL SELECT MAX(created_at) FROM study_logs WHERE user_id = u.id)) AS last_active_at
       FROM users u LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.role = 'student'
      ORDER BY u.active DESC, u.id DESC`,
  ).all();
  return c.json({ students: results });
});

adminRoutes.get("/students/:id", async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const db = c.env.DB;
  const [userRes, tasksRes, logsRes] = await db.batch([
    db.prepare(
      `SELECT u.id, u.username, u.name, u.class_id, c.name AS class_name, u.active, u.last_login_at, u.created_at
         FROM users u LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ? AND u.role = 'student'`,
    ).bind(id),
    db.prepare(
      `SELECT t.id, t.title, t.due_date, p.status, COALESCE(p.percent, 0) AS percent, p.note, p.link, p.score, p.updated_at
         FROM tasks t JOIN users u ON u.id = ? AND (t.class_id IS NULL OR t.class_id = u.class_id)
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published' ORDER BY t.id DESC`,
    ).bind(id),
    db.prepare(
      `SELECT l.id, l.minutes, l.content, l.log_date, l.task_id, t.title AS task_title
         FROM study_logs l LEFT JOIN tasks t ON t.id = l.task_id
        WHERE l.user_id = ? ORDER BY l.log_date DESC, l.id DESC LIMIT 200`,
    ).bind(id),
  ]);
  if (!userRes.results[0]) throw new HttpError(404, "学员不存在");
  return c.json({ student: userRes.results[0], tasks: tasksRes.results, logs: logsRes.results });
});

adminRoutes.post("/students", async (c) => {
  const body = await c.req.json();
  const u = username(body.username);
  const name = str(body.name, "姓名", { max: 32 });
  const classId = int(body.class_id, "班级", { optional: true });
  const hash = await hashPassword(password(body.password));
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO users (username, name, password_hash, role, class_id, must_change_password) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id",
    )
      .bind(u, name, hash, classId)
      .first();
    await audit(c, "新增学员", `${name}（${u}）`).run();
    return c.json({ student: row });
  } catch {
    throw new HttpError(409, "用户名已存在");
  }
});

// 批量导入：所有新学员共享同一个初始密码，只需计算一次哈希，避免超出 Worker CPU 限制
adminRoutes.post("/students/batch", async (c) => {
  const body = await c.req.json();
  const classId = int(body.class_id, "班级", { optional: true });
  const hash = await hashPassword(password(body.password));
  const lines = String(body.lines ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new HttpError(400, "请至少输入一行学员信息");
  if (lines.length > 500) throw new HttpError(400, "单次最多导入 500 名学员");

  const rows = lines.map((line, i) => {
    const [rawUser, ...rest] = line.split(/[,，\t\s]+/);
    try {
      return { username: username(rawUser), name: str(rest.join(" ") || rawUser, "姓名", { max: 32 }) };
    } catch (e) {
      throw new HttpError(400, `第 ${i + 1} 行：${(e as Error).message}`);
    }
  });

  const results = await c.env.DB.batch(
    rows.map((r) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO users (username, name, password_hash, role, class_id, must_change_password) VALUES (?, ?, ?, 'student', ?, 1)",
      ).bind(r.username, r.name, hash, classId),
    ),
  );
  const created = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (created) await audit(c, "批量导入学员", `${created} 名`).run();
  return c.json({ created, skipped: rows.length - created });
});

adminRoutes.patch("/students/:id", async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const body = await c.req.json();
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const student = await db.prepare("SELECT name, username FROM users WHERE id = ? AND role = 'student'").bind(id).first<{ name: string; username: string }>();
  if (!student) throw new HttpError(404, "学员不存在");
  const label = `${student.name}（${student.username}）`;

  if (body.name !== undefined) stmts.push(db.prepare("UPDATE users SET name = ? WHERE id = ? AND role = 'student'").bind(str(body.name, "姓名", { max: 32 }), id));
  if (body.class_id !== undefined) stmts.push(db.prepare("UPDATE users SET class_id = ? WHERE id = ? AND role = 'student'").bind(int(body.class_id, "班级", { optional: true }), id));
  if (body.active !== undefined) {
    stmts.push(db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'student'").bind(body.active ? 1 : 0, id));
    if (!body.active) stmts.push(db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
    stmts.push(audit(c, body.active ? "启用学员" : "停用学员", label));
  }
  if (body.password !== undefined) {
    const hash = await hashPassword(password(body.password));
    stmts.push(
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = 0 WHERE id = ? AND role = 'student'").bind(hash, id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
      audit(c, "重置学员密码", label),
    );
  }
  if (body.class_id !== undefined || body.name !== undefined) stmts.push(audit(c, "编辑学员信息", label));
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

adminRoutes.delete("/students/:id", async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const student = await c.env.DB.prepare("SELECT name, username FROM users WHERE id = ? AND role = 'student'").bind(id).first<{ name: string; username: string }>();
  if (!student) throw new HttpError(404, "学员不存在");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").bind(id),
    audit(c, "删除学员", `${student.name}（${student.username}）`),
  ]);
  return c.json({ ok: true });
});

/* ---------------- 任务 ---------------- */

adminRoutes.get("/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.tech_tags, t.class_id, cl.name AS class_name, t.due_date, t.status, t.require_review, t.created_at,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
            COUNT(u.id) AS assigned,
            COALESCE(SUM(p.status = 'approved'), 0) AS approved,
            COALESCE(SUM(p.status = 'submitted'), 0) AS submitted,
            COALESCE(SUM(p.status IN ('doing', 'rejected')), 0) AS doing
       FROM tasks t LEFT JOIN classes cl ON cl.id = t.class_id
       LEFT JOIN users u ON ${ELIGIBLE}
       LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
      GROUP BY t.id
      ORDER BY CASE t.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.id DESC`,
  ).all();
  return c.json({ tasks: results });
});

function parseTask(body: any) {
  const status = ["draft", "published", "archived"].includes(body.status) ? body.status : "published";
  return {
    title: str(body.title, "任务标题", { max: 100 }),
    description: str(body.description, "任务说明", { optional: true, max: 10000 }),
    tech_tags: normalizeTags(body.tech_tags),
    class_id: int(body.class_id, "班级", { optional: true }),
    due_date: dateStr(body.due_date, "截止日期"),
    status,
    require_review: body.require_review === false || body.require_review === 0 ? 0 : 1,
    steps: normalizeSteps(body.steps),
  };
}

adminRoutes.post("/tasks", async (c) => {
  const t = parseTask(await c.req.json());
  const db = c.env.DB;
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, description, tech_tags, class_id, due_date, status, require_review)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(t.title, t.description, t.tech_tags, t.class_id, t.due_date, t.status, t.require_review)
    .first<{ id: number }>();
  await db.batch([
    ...t.steps.map((s, i) => db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(row!.id, s.title, i)),
    audit(c, "创建任务", t.title),
  ]);
  return c.json({ task: row });
});

adminRoutes.get("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const db = c.env.DB;
  const [taskRes, stepsRes, rosterRes] = await db.batch([
    db.prepare("SELECT t.*, cl.name AS class_name FROM tasks t LEFT JOIN classes cl ON cl.id = t.class_id WHERE t.id = ?").bind(id),
    db.prepare("SELECT id, title, position FROM task_steps WHERE task_id = ? ORDER BY position, id").bind(id),
    db.prepare(
      `SELECT u.id AS user_id, u.name, u.username, cl.name AS class_name,
              p.status, COALESCE(p.percent, 0) AS percent, p.note, p.link, p.review_comment, p.score, p.submitted_at, p.updated_at
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN classes cl ON cl.id = u.class_id
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.id = ?
        ORDER BY CASE p.status WHEN 'submitted' THEN 0 WHEN 'rejected' THEN 1 WHEN 'doing' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END,
                 COALESCE(p.percent, 0) DESC, u.id`,
    ).bind(id),
  ]);
  if (!taskRes.results[0]) throw new HttpError(404, "任务不存在");
  return c.json({ task: taskRes.results[0], steps: stepsRes.results, roster: rosterRes.results });
});

adminRoutes.put("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const t = parseTask(await c.req.json());
  const db = c.env.DB;
  const [found, existing] = await db.batch<{ id: number }>([
    db.prepare("SELECT id FROM tasks WHERE id = ?").bind(id),
    db.prepare("SELECT id FROM task_steps WHERE task_id = ?").bind(id),
  ]);
  if (!found.results[0]) throw new HttpError(404, "任务不存在");
  const existingIds = new Set(existing.results.map((r) => r.id));
  const keepIds = new Set(t.steps.filter((s) => s.id && existingIds.has(s.id)).map((s) => s.id!));

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, tech_tags = ?, class_id = ?, due_date = ?, status = ?, require_review = ?, updated_at = unixepoch()
          WHERE id = ?`,
      )
      .bind(t.title, t.description, t.tech_tags, t.class_id, t.due_date, t.status, t.require_review, id),
  ];
  for (const oldId of existingIds) {
    if (!keepIds.has(oldId)) stmts.push(db.prepare("DELETE FROM task_steps WHERE id = ?").bind(oldId));
  }
  t.steps.forEach((s, i) => {
    stmts.push(
      s.id && keepIds.has(s.id)
        ? db.prepare("UPDATE task_steps SET title = ?, position = ? WHERE id = ?").bind(s.title, i, s.id)
        : db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(id, s.title, i),
    );
  });
  if (t.steps.length) {
    stmts.push(
      db
        .prepare(
          `UPDATE progress SET percent = (SELECT CAST(COUNT(*) * 100 / CAST(?2 AS INTEGER) AS INTEGER) FROM step_checks sc WHERE sc.task_id = ?1 AND sc.user_id = progress.user_id)
            WHERE task_id = ?1 AND status IN ('doing', 'rejected')`,
        )
        .bind(id, t.steps.length),
    );
  }
  stmts.push(audit(c, "编辑任务", t.title));
  await db.batch(stmts);
  return c.json({ ok: true });
});

adminRoutes.post("/tasks/:id/duplicate", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const db = c.env.DB;
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, description, tech_tags, class_id, due_date, status, require_review)
       SELECT substr(title || '（副本）', 1, 100), description, tech_tags, class_id, NULL, 'draft', require_review FROM tasks WHERE id = ?
       RETURNING id, title`,
    )
    .bind(id)
    .first<{ id: number; title: string }>();
  if (!row) throw new HttpError(404, "任务不存在");
  await db.batch([
    db.prepare("INSERT INTO task_steps (task_id, title, position) SELECT ?, title, position FROM task_steps WHERE task_id = ? ORDER BY position, id").bind(row.id, id),
    audit(c, "复制任务", row.title),
  ]);
  return c.json({ task: row });
});

adminRoutes.delete("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const db = c.env.DB;
  const task = await db.prepare("SELECT title FROM tasks WHERE id = ?").bind(id).first<{ title: string }>();
  if (!task) throw new HttpError(404, "任务不存在");
  await db.batch([db.prepare("DELETE FROM tasks WHERE id = ?").bind(id), audit(c, "删除任务", task.title)]);
  return c.json({ ok: true });
});

/* ---------------- 审核 ---------------- */

adminRoutes.get("/reviews", async (c) => {
  const status = c.req.query("status") === "done" ? "done" : "pending";
  const where = status === "pending" ? "p.status = 'submitted'" : "p.status IN ('approved', 'rejected') AND p.reviewed_at IS NOT NULL";
  const { results } = await c.env.DB.prepare(
    `SELECT p.task_id, p.user_id, p.status, p.percent, p.note, p.link, p.review_comment, p.score, p.submitted_at, p.reviewed_at,
            u.name AS user_name, u.username, cl.name AS class_name, t.title AS task_title, t.tech_tags, r.name AS reviewer_name,
            (SELECT COUNT(*) FROM progress_events e WHERE e.task_id = p.task_id AND e.user_id = p.user_id AND e.action = 'submit') AS attempts
       FROM progress p
       LEFT JOIN users r ON r.id = p.reviewer_id
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN classes cl ON cl.id = u.class_id
      WHERE ${where}
      ORDER BY ${status === "pending" ? "p.submitted_at ASC" : "p.reviewed_at DESC"} LIMIT 200`,
  ).all();
  return c.json({ reviews: results });
});

adminRoutes.post("/reviews", async (c) => {
  const body = await c.req.json();
  const action = body.action === "reject" ? "rejected" : "approved";
  const comment = str(body.comment, "评语", { optional: true, max: 1000 });
  const score = action === "approved" ? (int(body.score, "评分", { min: 1, max: 5, optional: true }) ?? null) : null;
  const items: { task_id: number; user_id: number }[] = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  if (items.length === 0) throw new HttpError(400, "请选择要审核的记录");
  if (action === "rejected" && !comment) throw new HttpError(400, "退回时请填写原因，方便学员修改");
  const me = c.get("user");
  const results = await c.env.DB.batch(
    items.map((it) =>
      c.env.DB.prepare(
        `UPDATE progress SET status = ?, review_comment = ?, score = ?, reviewer_id = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
          WHERE task_id = ? AND user_id = ? AND status = 'submitted' RETURNING task_id`,
      ).bind(action, comment, score, me.id, int(it.task_id, "任务ID"), int(it.user_id, "学员ID")),
    ),
  );
  const updated = results.reduce((n, r) => n + r.results.length, 0);
  if (updated) await audit(c, action === "approved" ? "审核通过" : "审核退回", `${updated} 条提交`).run();
  return c.json({ updated });
});

adminRoutes.get("/progress/:taskId/:userId/events", async (c) => {
  const taskId = int(c.req.param("taskId"), "任务ID")!;
  const userId = int(c.req.param("userId"), "学员ID")!;
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.action, e.comment, e.score, e.created_at, a.name AS actor_name
       FROM progress_events e LEFT JOIN users a ON a.id = e.actor_id
      WHERE e.task_id = ? AND e.user_id = ? ORDER BY e.id DESC LIMIT 50`,
  )
    .bind(taskId, userId)
    .all();
  return c.json({ events: results });
});

/* ---------------- 进度矩阵 ---------------- */

adminRoutes.get("/matrix", async (c) => {
  const classId = int(c.req.query("class_id"), "班级", { optional: true });
  const db = c.env.DB;
  const classFilter = classId ? "AND u.class_id = ?" : "";
  const taskFilter = classId ? "AND (t.class_id IS NULL OR t.class_id = ?)" : "";
  const bind = (s: D1PreparedStatement) => (classId ? s.bind(classId) : s);
  const [students, tasks, cells] = await db.batch([
    bind(db.prepare(`SELECT u.id, u.name, u.class_id FROM users u WHERE u.role = 'student' AND u.active = 1 ${classFilter} ORDER BY u.class_id, u.id`)),
    bind(db.prepare(`SELECT t.id, t.title, t.class_id, t.due_date FROM tasks t WHERE t.status = 'published' ${taskFilter} ORDER BY t.id`)),
    bind(
      db.prepare(
        `SELECT p.task_id, p.user_id, p.status, p.percent FROM progress p
           JOIN users u ON u.id = p.user_id JOIN tasks t ON t.id = p.task_id
          WHERE t.status = 'published' AND u.active = 1 ${classFilter}`,
      ),
    ),
  ]);
  return c.json({ students: students.results, tasks: tasks.results, cells: cells.results });
});
