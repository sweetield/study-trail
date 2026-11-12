import { useState, type FormEvent } from "react";
import { PASSWORD_HINT, PASSWORD_PATTERN } from "@/lib/utils";
import { useNavigate } from "react-router";
import { ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { useToast } from "@/components/toast";
import { Button, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";

export default function AccountPage() {
  const { user, refresh } = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    if (form.get("newPassword") !== form.get("confirm")) return setError("两次输入的新密码不一致");
    setError("");
    setLoading(true);
    try {
      await api.post("/api/auth/password", { oldPassword: form.get("oldPassword"), newPassword: form.get("newPassword") });
      const wasForced = user?.must_change_password;
      await refresh();
      formEl.reset();
      toast("密码已更新");
      if (wasForced) navigate(user?.role === "admin" ? "/admin" : "/app", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="账号安全" description={`${user?.name} · ${user?.username}`} />
      {user?.must_change_password && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>你正在使用管理员设置的初始密码，为了账号安全，请先修改密码后再继续使用。</p>
        </div>
      )}
      <Card className="max-w-lg">
        <CardHeader title="修改密码" description="修改后其他设备上的登录会自动失效" />
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-5">
          <Field label="当前密码" htmlFor="oldPassword">
            <Input id="oldPassword" name="oldPassword" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="新密码" htmlFor="newPassword" hint={PASSWORD_HINT}>
            <Input id="newPassword" name="newPassword" type="password" required pattern={PASSWORD_PATTERN} title={PASSWORD_HINT} autoComplete="new-password" />
          </Field>
          <Field label="确认新密码" htmlFor="confirm">
            <Input id="confirm" name="confirm" type="password" required pattern={PASSWORD_PATTERN} title={PASSWORD_HINT} autoComplete="new-password" />
          </Field>
          {error && (
            <p className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" loading={loading} className="self-start">
            保存新密码
          </Button>
        </form>
      </Card>
    </div>
  );
}
