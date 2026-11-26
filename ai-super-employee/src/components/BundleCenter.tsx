import { friendlyError } from "../cloud/friendlyError";
import { useMemo, useState } from "react";
import { Archive, Download, FileText, Package, Presentation } from "lucide-react";
import { zipSync, strToU8 } from "fflate";
import { BUNDLE_KIND_META, buildBundle, formatBytes, type BundleItem, type BundleKind } from "../cloud/bundle";

export interface BundleSource {
  kind: BundleKind;
  title: string;
  ext: string;
  /** 文本类给内容；二进制类给 base64 */
  data: string;
  encoding?: "utf8" | "base64";
  source?: string;
}

interface BundleCenterProps {
  sources: BundleSource[];
  /** 打包文件名的前缀，如「交付包」 */
  namePrefix?: string;
}

const KIND_ICON: Record<string, typeof FileText> = {
  content: FileText,
  "office-ppt": Presentation,
  "office-doc": FileText,
  "digital-plan": Package,
  "mixcut-plan": Package,
};

/**
 * 交付物打包中心：勾选要交付的产出 → 按分类分目录压成 zip（含 README 清单）。
 * zip 在本机生成（fflate），不上传任何文件。
 */
export function BundleCenter({ sources, namePrefix = "交付包" }: BundleCenterProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const key = (item: BundleSource) => `${item.kind}|${item.title}|${item.ext}|${item.data.length}`;

  const grouped = useMemo(() => {
    const map = new Map<BundleKind, BundleSource[]>();
    for (const item of sources) {
      if (!item.data.trim()) continue;
      const list = map.get(item.kind) ?? [];
      list.push(item);
      map.set(item.kind, list);
    }
    return BUNDLE_KIND_META.filter((meta) => map.has(meta.kind)).map((meta) => ({
      ...meta,
      items: map.get(meta.kind) ?? [],
    }));
  }, [sources]);

  /** 预览：用当前选中项算一遍清单（不压包），让用户先看目录结构与体积 */
  const preview = useMemo(() => {
    const picked = sources.filter((item) => selected.has(key(item)));
    const items: BundleItem[] = picked.map((item) => ({
      kind: item.kind,
      title: item.title,
      ext: item.ext,
      data: item.data,
      encoding: item.encoding,
      source: item.source,
    }));
    return buildBundle(items);
  }, [sources, selected]);

  const toggle = (item: BundleSource) => {
    const k = key(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectKind = (_kind: BundleKind, items: BundleSource[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const keys = items.map(key);
      const allSelected = keys.every((k) => next.has(k));
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const download = () => {
    if (preview.entries.length === 0) {
      setNotice("先勾选要打包的文件");
      return;
    }
    setBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const entry of preview.entries) {
        files[entry.path] = entry.encoding === "base64" ? Uint8Array.from(atob(entry.data), (c) => c.charCodeAt(0)) : strToU8(entry.data);
      }
      files["README.md"] = strToU8(preview.readme);
      const zipped = zipSync(files, { level: 6 });
      const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `${namePrefix}-${stamp}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`已打包 ${preview.entries.length} 个文件（${formatBytes(blob.size)}）`);
    } catch (error) {
      setNotice(`打包失败：${friendlyError(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="console-card bundle-center">
      <div className="console-card-header">
        <div>
          <h2>
            <Archive size={15} /> 交付物打包
          </h2>
          <p>勾选要交付的产出，按类型分目录压成 zip（含 README 清单）· 本机生成，不上传</p>
        </div>
        <div className="service-actions">
          <button
            type="button"
            className="text-link"
            onClick={() => setSelected(new Set(grouped.flatMap((group) => group.items).map(key)))}
          >
            全选
          </button>
          <button type="button" className="text-link" onClick={() => setSelected(new Set())}>
            清空
          </button>
          <button type="button" className="button button-primary" onClick={download} disabled={busy || preview.entries.length === 0}>
            <Download size={14} />
            {busy ? "打包中" : `打包下载（${preview.entries.length}）`}
          </button>
        </div>
      </div>

      {notice && <p className="mapleads-notice">{notice}</p>}

      {grouped.length === 0 && <p className="service-empty">还没有可交付的产出——先在内容工厂 / AI 办公生成内容</p>}

      <div className="bundle-groups">
        {grouped.map((group) => {
          const Icon = KIND_ICON[group.kind] ?? FileText;
          const allSelected = group.items.every((item) => selected.has(key(item)));
          return (
            <div className="bundle-group" key={group.kind}>
              <button type="button" className="bundle-group-head" onClick={() => selectKind(group.kind, group.items)}>
                <Icon size={14} />
                <strong>{group.label}</strong>
                <span>{group.items.length} 项</span>
                <em>{allSelected ? "取消全选" : "全选本组"}</em>
              </button>
              <ul>
                {group.items.map((item) => {
                  const checked = selected.has(key(item));
                  return (
                    <li key={key(item)}>
                      <label className={checked ? "checked" : ""}>
                        <input type="checkbox" checked={checked} onChange={() => toggle(item)} />
                        <span className="bundle-title" title={item.title}>{item.title}</span>
                        <span className="bundle-ext">{item.ext}</span>
                        {item.source && <span className="bundle-source">{item.source}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {preview.entries.length > 0 && (
        <div className="bundle-preview">
          <h3>
            清单预览 · {preview.entries.length} 个文件 · {formatBytes(preview.totalBytes)}
          </h3>
          <ul>
            {preview.entries.map((entry) => (
              <li key={entry.path}>
                <code>{entry.path}</code>
                <span>{formatBytes(entry.bytes)}</span>
              </li>
            ))}
            <li>
              <code>README.md</code>
              <span>{formatBytes(preview.readme.length)}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export default BundleCenter;
