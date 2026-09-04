// 工作区文件树组件（P9 · F-9-4）：侧栏「文件」区，懒加载子目录。
//
// 展现当前会话 cwd 单层目录列表；目录点击展开时才调 workspace_list_dir 拉子项。
// 文件节点 hover 提供「引用到输入框」（@file:/abs/path，与 P8 F-8-3 同路径）。
// 最近改动文件加「M」徽标（复用 tool_call diff 的 path 集合，不做 fs watch）。

import { useEffect, useState } from "react";
import { workspaceListDir, type DirEntry } from "../ipc/fslist";
import { filterExcluded, joinDirPath } from "../acp/fileTree";
import { ChevronRightIcon, FileTextIcon, WorkspaceIcon } from "./ui/icons";

interface Props {
  cwd?: string;
  /** 最近被 diff 修改过的绝对路径（F-9-4 已收集，用于「M」徽标） */
  modifiedPaths: Set<string>;
  /** 点文件 → 引用到输入框（绝对路径） */
  onRefFile: (path: string) => void;
}

export function FileTree({ cwd, modifiedPaths, onRefFile }: Props) {
  const [nodes, setNodes] = useState<Record<string, DirEntry[]>>({});
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cwd) return;
    setNodes({});
    setLoading(true);
    workspaceListDir(cwd)
      .then((entries) => {
        // 防御：后端异常返回非数组时（如 mock/降级环境），忽略不崩
        if (Array.isArray(entries)) setNodes((n) => ({ ...n, [cwd]: filterExcluded(entries) }));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cwd]);

  const baseEntries = cwd ? nodes[cwd] ?? [] : [];

  async function toggleDir(dir: string) {
    if (nodes[dir]) {
      // 已加载 → 收起
      setNodes((n) => {
        const copy = { ...n };
        delete copy[dir];
        return copy;
      });
      return;
    }
    setLoading(true);
    try {
      const entries = await workspaceListDir(dir);
      setNodes((n) => ({ ...n, [dir]: filterExcluded(entries) }));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="filetree">
      <button type="button" className="filetree-head" onClick={() => setOpen((v) => !v)}>
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <span>文件</span>
      </button>
      {open && (
        <div className="filetree-body">
          {loading && baseEntries.length === 0 && <div className="hint">加载中…</div>}
          {baseEntries.map((e) => (
            <FileRow
              key={`${cwd}/${e.name}`}
              depth={0}
              entrance={e}
              fullPath={joinDirPath(cwd ?? "", e.name)}
              nodes={nodes}
              modified={modifiedPaths}
              onToggleDir={toggleDir}
              onRefFile={onRefFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({
  entrance,
  fullPath,
  nodes,
  modified,
  depth,
  onToggleDir,
  onRefFile,
}: {
  entrance: DirEntry;
  fullPath: string;
  nodes: Record<string, DirEntry[]>;
  modified: Set<string>;
  depth: number;
  onToggleDir: (dir: string) => void;
  onRefFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isDir = entrance.is_dir;
  const child = nodes[fullPath];
  const isModified = modified.has(fullPath);

  return (
    <div>
      <div
        className="filetree-row group"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => {
          if (isDir) {
            setOpen((v) => !v);
            onToggleDir(fullPath);
          }
        }}
      >
        {isDir ? (
          <WorkspaceIcon style={{ width: 13, height: 13, strokeWidth: 1.75, color: "var(--text-secondary)", flexShrink: 0 }} />
        ) : (
          <FileTextIcon style={{ width: 13, height: 13, strokeWidth: 1.75, color: "var(--text-secondary)", flexShrink: 0 }} />
        )}
        <span className="filetree-name" title={fullPath}>{entrance.name}</span>
        {isModified && <span className="filetree-badge" title="最近改动">M</span>}
        {!isDir && (
          <button
            type="button"
            className="filetree-ref"
            aria-label={`引用 ${entrance.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRefFile(fullPath);
            }}
          >
            引用
          </button>
        )}
      </div>
      {isDir && open && child && (
        <div>
          {child.map((c) => (
            <FileRow
              key={`${fullPath}/${c.name}`}
              depth={depth + 1}
              entrance={c}
              fullPath={joinDirPath(fullPath, c.name)}
              nodes={nodes}
              modified={modified}
              onToggleDir={onToggleDir}
              onRefFile={onRefFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
