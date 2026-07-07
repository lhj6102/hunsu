import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Editor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Code2, File, FileDiff, FileWarning, Folder, FolderOpen, GitCommit, LockKeyhole, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchMoveFileBlob, fetchMoveFileDiff, fetchMoveFileTree } from "@/shared/api/bridgeClient";
import type { MoveDiffFile, MoveDiffTreeNode, MoveFileBlob, MoveFileDiff, MoveFileNode, MoveFileTree } from "@/shared/api/bridgeTypes";
import { Button } from "@/shared/ui/button";

export function MoveFileExplorer({
  roadmapId,
  moveId,
  dark
}: {
  roadmapId?: string;
  moveId?: string;
  dark: boolean;
}) {
  const [treePath, setTreePath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [activeView, setActiveView] = useState<"tree" | "diff">("tree");

  const treeQuery = useQuery({
    queryKey: ["move-file-tree", roadmapId, moveId, treePath],
    queryFn: () => fetchMoveFileTree(roadmapId!, moveId!, treePath),
    enabled: Boolean(roadmapId && moveId),
    staleTime: 30_000
  });

  const blobQuery = useQuery({
    queryKey: ["move-file-blob", roadmapId, moveId, selectedPath],
    queryFn: () => fetchMoveFileBlob(roadmapId!, moveId!, selectedPath!),
    enabled: Boolean(roadmapId && moveId && selectedPath),
    staleTime: 30_000
  });

  const changedInView = useMemo(() => changedPathsInView(treeQuery.data), [treeQuery.data]);

  useEffect(() => {
    setTreePath("");
    setSelectedPath(undefined);
    setActiveView("tree");
  }, [roadmapId, moveId]);

  useEffect(() => {
    if (selectedPath || !treeQuery.data) return;
    const firstText = treeQuery.data.nodes.find(node => node.kind === "textFile");
    if (firstText) {
      setSelectedPath(firstText.path);
    }
  }, [selectedPath, treeQuery.data]);

  if (!roadmapId || !moveId) {
    return null;
  }

  return (
    <section className="min-w-0">
      <div className={cn("flex items-start justify-between gap-3 border-b pb-3", dark ? "border-white/10" : "border-[#d9dfda]")}>
        <div className="min-w-0">
          <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>MOVE Files</p>
          <h3 className="mt-1 truncate text-[13px] font-semibold leading-5">Read-only commit explorer</h3>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <FileViewButton active={activeView === "tree"} label="Tree" onClick={() => setActiveView("tree")} />
          <FileViewButton active={activeView === "diff"} label="Diff" onClick={() => setActiveView("diff")} />
          <span className={cn("font-mono text-[11px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{moveId}</span>
        </div>
      </div>

      {treeQuery.data ? <RuntimeCapsule tree={treeQuery.data} dark={dark} /> : null}

      {activeView === "tree" ? (
        <div className={cn("mt-4 grid min-w-0 border-y lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)]", dark ? "border-white/10" : "border-[#d9dfda]")}>
          <div className={cn("min-h-[420px] min-w-0 border-b py-3 lg:border-b-0 lg:border-r lg:pr-3", dark ? "border-white/10" : "border-[#d9dfda]")}>
            <MoveFileTreePane
              dark={dark}
              tree={treeQuery.data}
              pending={treeQuery.isLoading}
              error={treeQuery.error}
              selectedPath={selectedPath}
              changedPaths={changedInView}
              onOpenDirectory={setTreePath}
              onSelectFile={setSelectedPath}
              onRefresh={() => void treeQuery.refetch()}
            />
          </div>
          <div className="min-w-0 py-3 lg:pl-3">
            <MoveFilePreview dark={dark} path={selectedPath} blob={blobQuery.data} pending={blobQuery.isLoading} error={blobQuery.error} />
          </div>
        </div>
      ) : (
        <div className={cn("mt-4 border-y py-3", dark ? "border-white/10" : "border-[#d9dfda]")}>
          <MoveDiffPreview dark={dark} roadmapId={roadmapId} moveId={moveId} />
        </div>
      )}
    </section>
  );
}

function FileViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "border-b pb-1 text-[11px] font-semibold leading-4 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        active ? "border-[color:var(--apple-blue)] text-[color:var(--apple-blue)]" : "border-transparent text-muted-foreground hover:text-[color:var(--apple-ink)]"
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function RuntimeCapsule({ tree, dark }: { tree: MoveFileTree; dark: boolean }) {
  const capsule = tree.runtimeCapsule;
  return (
    <div className={cn("mt-4 border-l-2 pl-3", dark ? "border-[#9eb4aa]" : "border-[color:var(--detail-accent)]")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <LockKeyhole className="size-3.5 shrink-0 text-[color:var(--detail-accent)]" />
          <p className="truncate text-[12px] font-semibold">Runtime Capsule</p>
        </div>
        <span className={cn("shrink-0 text-[10px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{capsule.hiddenRuntimeFileCount} hidden</span>
      </div>
      <p className={cn("mt-1 text-[11px] leading-4", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{capsule.summary}</p>
    </div>
  );
}

function MoveFileTreePane({
  dark,
  tree,
  pending,
  error,
  selectedPath,
  changedPaths,
  onOpenDirectory,
  onSelectFile,
  onRefresh
}: {
  dark: boolean;
  tree?: MoveFileTree;
  pending: boolean;
  error: Error | null;
  selectedPath?: string;
  changedPaths: Set<string>;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}) {
  if (pending) {
    return <PaneMessage dark={dark} text="Loading commit tree..." />;
  }
  if (error) {
    return <PaneMessage dark={dark} text={error.message} actionLabel="Retry" onAction={onRefresh} />;
  }
  if (!tree) {
    return <PaneMessage dark={dark} text="No MOVE file tree is available." />;
  }
  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          className={cn("flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-medium", tree.parent ? "hover:bg-black/5" : "cursor-default opacity-70")}
          onClick={() => tree.parent !== undefined && onOpenDirectory(tree.parent)}
          disabled={tree.parent === undefined}
        >
          {tree.path ? <FolderOpen className="size-3.5 shrink-0" /> : <GitCommit className="size-3.5 shrink-0" />}
          <span className="truncate">{tree.path || tree.commit.slice(0, 8)}</span>
        </button>
        <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" onClick={onRefresh} aria-label="Refresh MOVE file tree">
          <RotateCw className="size-3.5" />
        </Button>
      </div>
      {tree.changedPaths.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-1">
          {tree.changedPaths.slice(0, 4).map(path => (
            <button
              key={path}
              type="button"
              className={cn("min-w-0 max-w-full truncate border-l px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--apple-blue)]", dark ? "border-white/15" : "border-[#d9dfda]")}
              title={path}
              onClick={() => onSelectFile(path)}
            >
              {path}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-1">
        {tree.nodes.length === 0 ? (
          <p className={cn("px-1.5 py-2 text-[12px] leading-5", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>This directory is empty.</p>
        ) : tree.nodes.map(node => (
          <MoveFileNodeRow
            key={`${node.kind}:${node.path}`}
            node={node}
            dark={dark}
            selected={selectedPath === node.path}
            changed={changedPaths.has(node.path)}
            onOpenDirectory={onOpenDirectory}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}

function MoveFileNodeRow({
  node,
  dark,
  selected,
  changed,
  onOpenDirectory,
  onSelectFile
}: {
  node: MoveFileNode;
  dark: boolean;
  selected: boolean;
  changed: boolean;
  onOpenDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const disabled = node.kind === "hiddenRuntime";
  return (
    <button
      type="button"
      className={cn(
        "group flex min-h-8 w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] leading-4",
        selected ? "bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]" : dark ? "hover:bg-white/10" : "hover:bg-black/5",
        disabled && "cursor-not-allowed opacity-60"
      )}
      disabled={disabled}
      onClick={() => node.kind === "directory" ? onOpenDirectory(node.path) : onSelectFile(node.path)}
    >
      {iconForNode(node)}
      <span className="min-w-0 flex-1 truncate font-mono" title={node.path}>{node.name}</span>
      {changed ? <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--apple-blue)]" /> : null}
      {node.kind === "directory" ? <ChevronRight className="size-3 shrink-0 opacity-60" /> : null}
    </button>
  );
}

function MoveFilePreview({
  dark,
  path,
  blob,
  pending,
  error
}: {
  dark: boolean;
  path?: string;
  blob?: MoveFileBlob;
  pending: boolean;
  error: Error | null;
}) {
  if (!path) {
    return <PreviewShell dark={dark}><PaneMessage dark={dark} text="Select a file to preview." /></PreviewShell>;
  }
  if (pending) {
    return <PreviewShell dark={dark}><PaneMessage dark={dark} text="Loading file..." /></PreviewShell>;
  }
  if (error) {
    return <PreviewShell dark={dark}><PaneMessage dark={dark} text={error.message} /></PreviewShell>;
  }
  if (!blob) {
    return <PreviewShell dark={dark}><PaneMessage dark={dark} text="No file preview is available." /></PreviewShell>;
  }
  return (
    <PreviewShell dark={dark} title={blob.path} meta={blob.kind === "text" ? `${blob.size} bytes` : blob.kind}>
      {blob.kind === "text" ? (
        <div className="h-[420px] min-w-0 overflow-hidden">
          <Editor
            height="420px"
            language={blob.language ?? "plaintext"}
            theme={dark ? "vs-dark" : "light"}
            value={blob.text}
            options={{
              domReadOnly: true,
              fontSize: 12,
              minimap: { enabled: false },
              readOnly: true,
              scrollBeyondLastLine: false,
              wordWrap: "on"
            }}
          />
        </div>
      ) : (
        <FilePlaceholder blob={blob} dark={dark} />
      )}
    </PreviewShell>
  );
}

function MoveDiffPreview({ dark, roadmapId, moveId }: { dark: boolean; roadmapId: string; moveId: string }) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const diffQuery = useQuery({
    queryKey: ["move-file-diff", roadmapId, moveId],
    queryFn: () => fetchMoveFileDiff(roadmapId, moveId),
    staleTime: 30_000
  });

  useEffect(() => {
    setSelectedPath(undefined);
  }, [roadmapId, moveId]);

  useEffect(() => {
    if (!diffQuery.data) return;
    if (selectedPath && diffQuery.data.files.some(file => file.path === selectedPath)) return;
    setSelectedPath(diffQuery.data.files[0]?.path);
  }, [diffQuery.data, selectedPath]);

  const selectedFile = diffQuery.data?.files.find(file => file.path === selectedPath) ?? diffQuery.data?.files[0];

  if (diffQuery.isLoading) {
    return <PaneMessage dark={dark} text="Loading diff..." />;
  }
  if (diffQuery.error) {
    return <PaneMessage dark={dark} text={diffQuery.error.message} />;
  }
  if (!diffQuery.data) {
    return <PaneMessage dark={dark} text="No MOVE diff is available." />;
  }
  if (diffQuery.data.files.length === 0) {
    return <PreviewShell dark={dark} title="MOVE diff" meta={moveDiffRangeLabel(diffQuery.data)}><PaneMessage dark={dark} text="No product file changes in this MOVE diff." /></PreviewShell>;
  }
  return (
    <div className="min-w-0">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold">MOVE diff</p>
          <p className={cn("mt-0.5 truncate font-mono text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{moveDiffRangeLabel(diffQuery.data)}</p>
        </div>
        <span className={cn("shrink-0 text-[10px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{diffQuery.data.files.length} files</span>
      </div>
      <div className={cn("grid min-w-0 border-y lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.4fr)]", dark ? "border-white/10" : "border-[#d9dfda]")}>
        <div className={cn("min-h-[420px] min-w-0 border-b py-3 lg:border-b-0 lg:border-r lg:pr-3", dark ? "border-white/10" : "border-[#d9dfda]")}>
          <MoveDiffTreePane dark={dark} tree={diffQuery.data.tree} selectedPath={selectedFile?.path} onSelectFile={setSelectedPath} />
        </div>
        <div className="min-w-0 py-3 lg:pl-3">
          <MoveDiffPatchPreview dark={dark} file={selectedFile} />
        </div>
      </div>
    </div>
  );
}

function MoveDiffTreePane({ dark, tree, selectedPath, onSelectFile }: { dark: boolean; tree: MoveDiffTreeNode[]; selectedPath?: string; onSelectFile: (path: string) => void }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center gap-1.5 px-1.5 text-[11px] font-semibold">
        <FileDiff className="size-3.5 shrink-0 text-[color:var(--detail-accent)]" />
        <span className="truncate">Changed files</span>
      </div>
      <div className="grid gap-1">
        {tree.map(node => (
          <MoveDiffTreeNodeRow key={`${node.kind}:${node.path}`} node={node} dark={dark} selectedPath={selectedPath} depth={0} onSelectFile={onSelectFile} />
        ))}
      </div>
    </div>
  );
}

function MoveDiffTreeNodeRow({
  node,
  dark,
  selectedPath,
  depth,
  onSelectFile
}: {
  node: MoveDiffTreeNode;
  dark: boolean;
  selectedPath?: string;
  depth: number;
  onSelectFile: (path: string) => void;
}) {
  const paddingLeft = `${Math.min(depth, 5) * 0.75 + 0.375}rem`;
  if (node.kind === "directory") {
    return (
      <details open>
        <summary
          className={cn("flex min-h-8 cursor-pointer list-none items-center gap-2 rounded py-1 pr-1.5 text-left text-[12px] leading-4 hover:bg-black/5 [&::-webkit-details-marker]:hidden", dark && "hover:bg-white/10")}
          style={{ paddingLeft }}
        >
          <Folder className="size-3.5 shrink-0 text-[color:var(--detail-accent)]" />
          <span className="min-w-0 flex-1 truncate font-mono" title={node.path}>{node.name}</span>
          <span className={cn("shrink-0 text-[10px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{node.changedFileCount}</span>
          <ChevronRight className="size-3 shrink-0 opacity-60" />
        </summary>
        <div className="grid gap-1">
          {node.children.map(child => (
            <MoveDiffTreeNodeRow key={`${child.kind}:${child.path}`} node={child} dark={dark} selectedPath={selectedPath} depth={depth + 1} onSelectFile={onSelectFile} />
          ))}
        </div>
      </details>
    );
  }
  const selected = selectedPath === node.path;
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded py-1 pr-1.5 text-left text-[12px] leading-4",
        selected ? "bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]" : dark ? "hover:bg-white/10" : "hover:bg-black/5"
      )}
      style={{ paddingLeft }}
      onClick={() => onSelectFile(node.path)}
    >
      <FileDiff className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono" title={node.oldPath ? `${node.oldPath} -> ${node.path}` : node.path}>{node.name}</span>
      <span className={cn("shrink-0 text-[9px] font-semibold uppercase tracking-normal", changeKindTone(node.changeKind, dark))}>{changeKindLabel(node.changeKind)}</span>
    </button>
  );
}

function MoveDiffPatchPreview({ dark, file }: { dark: boolean; file?: MoveDiffFile }) {
  if (!file) {
    return <PreviewShell dark={dark}><PaneMessage dark={dark} text="Select a changed file." /></PreviewShell>;
  }
  return (
    <PreviewShell dark={dark} title={file.path} meta={changeKindLabel(file.kind)}>
      {file.oldPath && file.oldPath !== file.path ? (
        <p className={cn("mt-2 truncate font-mono text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{file.oldPath} -&gt; {file.path}</p>
      ) : null}
      <pre className={cn("mt-2 max-h-[520px] min-h-[360px] overflow-auto border-l p-3 font-mono text-[11px] leading-4", dark ? "border-white/10 bg-[#050807] text-[#dbe8df]" : "border-[#d9dfda] bg-[#fbfdfb] text-[#20251f]")}>
        <code>{file.patch || "No patch text is available for this changed file."}</code>
      </pre>
    </PreviewShell>
  );
}

function moveDiffRangeLabel(diff: MoveFileDiff): string {
  const base = diff.baseMoveId
    ? `${diff.baseMoveId} ${diff.baseCommit?.slice(0, 8) ?? ""}`.trim()
    : diff.baseCommit
      ? `source ${diff.baseCommit.slice(0, 8)}`
      : "root";
  const headCommit = diff.headCommit ?? diff.commit;
  const head = headCommit === diff.commit
    ? `${diff.moveId} ${diff.commit.slice(0, 8)}`
    : `path ${headCommit.slice(0, 8)} / ${diff.moveId} ${diff.commit.slice(0, 8)}`;
  return `${base} -> ${head}`;
}

function changeKindLabel(kind: MoveDiffFile["kind"]): string {
  if (kind === "typeChanged") return "type";
  return kind;
}

function changeKindTone(kind: MoveDiffFile["kind"], dark: boolean): string {
  if (kind === "added" || kind === "copied") return dark ? "text-[#86efac]" : "text-[#15803d]";
  if (kind === "removed") return dark ? "text-[#fda4af]" : "text-[#be123c]";
  if (kind === "renamed") return dark ? "text-[#93c5fd]" : "text-[#2563eb]";
  return dark ? "text-[#9eb4aa]" : "text-[#626b66]";
}

function PreviewShell({ dark, title, meta, children }: { dark: boolean; title?: string; meta?: string; children: ReactNode }) {
  return (
    <div className="min-h-[420px] min-w-0 overflow-hidden">
      {title ? (
        <div className={cn("flex min-w-0 items-center justify-between gap-2 border-b pb-2", dark ? "border-white/10" : "border-[#d9dfda]")}>
          <p className="min-w-0 truncate font-mono text-[11px]" title={title}>{title}</p>
          {meta ? <span className={cn("shrink-0 text-[10px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function FilePlaceholder({ blob, dark }: { blob: Exclude<MoveFileBlob, { kind: "text" }>; dark: boolean }) {
  const text = blob.kind === "tooLarge"
    ? `File is ${blob.size} bytes, above the ${blob.maxBytes} byte preview limit.`
    : blob.kind === "hiddenRuntime"
      ? "Hunsu runtime files are hidden from normal MOVE browsing."
      : `Binary file (${blob.size} bytes).`;
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 p-4 text-center">
      <FileWarning className="size-6 text-[color:var(--detail-accent)]" />
      <p className={cn("text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{text}</p>
    </div>
  );
}

function PaneMessage({ dark, text, actionLabel, onAction }: { dark: boolean; text: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 p-4 text-center">
      <p className={cn("text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{text}</p>
      {actionLabel && onAction ? (
        <Button type="button" size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function iconForNode(node: MoveFileNode) {
  if (node.kind === "directory") return <Folder className="size-3.5 shrink-0 text-[color:var(--detail-accent)]" />;
  if (node.kind === "hiddenRuntime") return <LockKeyhole className="size-3.5 shrink-0 text-[color:var(--detail-accent)]" />;
  if (node.kind === "tooLarge" || node.kind === "binaryFile") return <FileWarning className="size-3.5 shrink-0 text-[color:var(--apple-red)]" />;
  if (node.name.match(/\.(ts|tsx|js|jsx|json|css|md|py|go|rs)$/)) return <Code2 className="size-3.5 shrink-0" />;
  return <File className="size-3.5 shrink-0" />;
}

function changedPathsInView(tree: MoveFileTree | undefined): Set<string> {
  if (!tree) return new Set();
  const visible = new Set(tree.nodes.map(node => node.path));
  return new Set(tree.changedPaths.filter(path => visible.has(path)));
}
