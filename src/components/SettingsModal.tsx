// 设置页：适配器增删改查。
// 验收目标（plan.md AC-P2-1/6）：新增一条自定义适配器 → 保存后新会话下拉可用，全程不改代码；
// 配置损坏时应用不崩溃并提示修复。

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Adapter } from "../config/adapters";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface EditableAdapter {
  id: string;
  name: string;
  program: string;
  argsText: string; // 每行一个参数
  cwd: string;
  logo: string; // 编辑态为空串；保存时转 null
  available: boolean | null; // null = 探测中
}

function toEditable(a: Adapter): EditableAdapter {
  return { ...a, argsText: a.args.join("\n"), logo: a.logo ?? "", available: null };
}

function fromEditable(a: EditableAdapter): Adapter {
  return {
    id: a.id,
    name: a.name,
    program: a.program,
    args: a.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
    cwd: a.cwd,
    logo: a.logo.trim() || null,
  };
}

export function SettingsModal({ open, onClose, onSaved }: Props) {
  const [items, setItems] = useState<EditableAdapter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    invoke<Adapter[]>("adapters_list")
      .then((list) => setItems(list.map(toEditable)))
      .catch((e) => setError(`读取适配器失败：${String(e)}`))
      .finally(() => setLoading(false));
  }, [open]);

  // 逐项探测可用性
  useEffect(() => {
    if (!open) return;
    items.forEach((a) => {
      if (a.available !== null) return;
      invoke<boolean>("adapter_available", { program: a.program }).then((ok) => {
        setItems((prev) =>
          prev.map((x) => (x.id === a.id ? { ...x, available: ok } : x)),
        );
      });
    });
  }, [items, open]);

  function update(id: string, patch: Partial<EditableAdapter>) {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function addRow() {
    const id = `custom-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      { id, name: "自定义 harness", program: "", argsText: "", cwd: ".", logo: "", available: null },
    ]);
  }

  function removeRow(id: string) {
    setItems((prev) => prev.filter((a) => a.id !== id));
  }

  async function save() {
    setError(null);
    // 客户端校验：id/program 非空
    for (const a of items) {
      if (!a.id.trim() || !a.program.trim()) {
        setError("每条适配器都必须有 id 与 program");
        return;
      }
    }
    const adapters = items.map(fromEditable);
    try {
      await invoke("adapters_save", { adapters });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>harness 设置</DialogTitle>
        </DialogHeader>
        {loading && <p>加载中…</p>}
        {error && <p className="modal-error">{error}</p>}
        <div className="adapter-list">
          {items.map((a) => (
            <div key={a.id} className="adapter-row">
              <input
                placeholder="id"
                value={a.id}
                onChange={(e) => update(a.id, { id: e.target.value })}
              />
              <input
                placeholder="名称"
                value={a.name}
                onChange={(e) => update(a.id, { name: e.target.value })}
              />
              <input
                placeholder="program"
                value={a.program}
                onChange={(e) => update(a.id, { program: e.target.value, available: null })}
              />
              <input
                placeholder="cwd"
                value={a.cwd}
                onChange={(e) => update(a.id, { cwd: e.target.value })}
              />
              <input
                placeholder="logo 色 (#rrggbb)"
                value={a.logo}
                onChange={(e) => update(a.id, { logo: e.target.value })}
              />
              <textarea
                placeholder={'启动参数（每行一个）\n例如：\nacp\n--model\nopus'}
                value={a.argsText}
                rows={3}
                onChange={(e) => update(a.id, { argsText: e.target.value })}
              />
              <span className={a.available === null ? "" : a.available ? "ok" : "bad"}>
                {a.available === null ? "探测中…" : a.available ? "✓ 可用" : "✗ 未安装"}
              </span>
              <button onClick={() => removeRow(a.id)}>删除</button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={addRow}>新增 harness</button>
          <button onClick={save}>保存</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
