export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffReviewFile {
  id: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  oldContent: string;
  newContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload;

export interface DiffReviewWindowData {
  repoRoot: string;
  files: DiffReviewFile[];
  /** File ids that were touched during this pi session (edit/write). Empty when nothing was tracked. */
  sessionFileIds: string[];
}
