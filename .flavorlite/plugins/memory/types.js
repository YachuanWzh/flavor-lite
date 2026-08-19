/** Memory type taxonomy. */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

/** Routing-index title for the V1 codec. */
export const V1_TITLE = "# FlavorLite Project Memory Index";
export const INDEX_MARKER = "flavorlite-memory-index-v1";
export const TASK_MARKER = "flavorlite-task-memory-v1";
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const HEAT_EMOJI = {
  hot: "[hot]",
  cold: "[cold]",
  normal: "",
};

export const TYPE_LABEL = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
};
