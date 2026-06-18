"use client";

import { basename } from "@lathe/shared";
import type { ChangedFile } from "@/lib/types";
import { FolderIcon, indentClass, statusGlyph, type TreeRow } from "./model";

export function FileTree({
  files,
  active,
  visibleTree,
  collapsedFolders,
  onToggleFolder,
  onSelectFile,
}: {
  files: ChangedFile[];
  active: ChangedFile | undefined;
  visibleTree: TreeRow[];
  collapsedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
}) {
  return (
    <div className="sidebar" data-testid="sidebar">
      <div className="filetree-head" data-testid="filetree-head">
        <div className="title" data-testid="title">Changed Files</div>
        <div className="sub" data-testid="sub">{files.length} files changed</div>
      </div>
      <div className="filetree" data-testid="filetree">
        {visibleTree.map((row, i) => {
          if (row.kind === "folder") {
            const collapsed = collapsedFolders.has(row.path);
            return (
              <div
                key={`folder-${row.path}-${i}`}
                data-row-kind="folder"
                className={`file-row is-folder ${indentClass(row.depth)}`}
                data-testid="file-row"
                role="button"
                tabIndex={0}
                onClick={() => onToggleFolder(row.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggleFolder(row.path);
                  }
                }}
              >
                <span className="twisty" data-testid="twisty">{collapsed ? "▸" : "▾"}</span>
                <span className="ficon folder" data-testid="ficon" data-ficon-kind="folder" aria-hidden>
                  <FolderIcon />
                </span>
                <span className="fname" data-testid="fname" title={row.path}>
                  {row.name}
                </span>
                <span className="counts" data-testid="counts">
                  <span className="add" data-testid="add">+{row.additions}</span>
                  <span className="del" data-testid="del">-{row.deletions}</span>
                </span>
              </div>
            );
          }
          const file = row.file;
          const isActive = !!active && file.id === active.id;
          return (
            <div
              key={file.id}
              data-file-id={file.id}
              data-row-kind="file"
              data-active={isActive ? "true" : undefined}
              className={`file-row is-file ${indentClass(row.depth)}${isActive ? " active" : ""}`}
              data-testid="file-row"
              role="button"
              tabIndex={0}
              onClick={() => onSelectFile(file.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectFile(file.id);
                }
              }}
            >
              <span className="twisty" data-testid="twisty" />
              <span className={`status-chip ${file.status}`} data-testid="status-chip" data-status={file.status} title={file.status} aria-hidden>
                {statusGlyph(file.status)}
              </span>
              <span className="fname" data-testid="fname" title={file.path}>
                {basename(file.path)}
              </span>
              <span className="counts" data-testid="counts">
                <span className="add" data-testid="add">+{file.additions}</span>
                <span className="del" data-testid="del">-{file.deletions}</span>
              </span>
            </div>
          );
        })}
        {files.length === 0 && (
          <div className="empty" data-testid="empty" style={{ padding: 12 }}>
            No changed files in this session.
          </div>
        )}
      </div>
    </div>
  );
}
