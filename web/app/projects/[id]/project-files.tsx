"use client";

import { useRef, useState } from "react";
import { Download, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type FileDto = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  uploaderId: string;
  uploaderName: string;
  createdAt: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectFiles({
  projectId,
  initialFiles,
  canUpload,
  canDeleteAll,
  myId,
}: {
  projectId: string;
  initialFiles: FileDto[];
  canUpload: boolean;
  canDeleteAll: boolean;
  myId: string;
}) {
  const [files, setFiles] = useState<FileDto[]>(initialFiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/files`);
    if (res.ok) setFiles(await res.json());
  }

  async function upload(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "上傳失敗,請再試一次。");
        return;
      }
      await refresh();
    } catch {
      setError("上傳失敗,請再試一次。");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(f: FileDto) {
    if (!confirm(`刪除檔案「${f.filename}」?`)) return;
    const res = await fetch(`/api/projects/${projectId}/files/${f.id}`, {
      method: "DELETE",
    });
    if (res.ok) setFiles((cur) => cur.filter((x) => x.id !== f.id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4" /> 文件 {files.length}
          {canUpload && (
            <>
              <input
                ref={inputRef}
                type="file"
                hidden
                onChange={(e) => upload(e.target.files)}
              />
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                上傳(≤20MB)
              </Button>
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-destructive mb-2 text-sm">{error}</p>}
        {files.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            還沒有文件。上傳規格、會議記錄、合約都行。
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                <FileText className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0">
                  <a
                    href={`/api/projects/${projectId}/files/${f.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {f.filename}
                  </a>
                  <span className="text-muted-foreground block text-xs">
                    {fmtSize(f.size)} · {f.uploaderName} ·{" "}
                    {new Date(f.createdAt).toLocaleDateString("zh-TW")}
                  </span>
                </span>
                <span className="ml-auto flex shrink-0 items-center">
                  <a
                    href={`/api/projects/${projectId}/files/${f.id}`}
                    title="下載"
                    className="text-muted-foreground hover:text-foreground p-1.5"
                  >
                    <Download className="size-3.5" />
                  </a>
                  {(canDeleteAll || f.uploaderId === myId) && (
                    <button
                      onClick={() => remove(f)}
                      title="刪除"
                      className="text-muted-foreground hover:text-destructive p-1.5"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
