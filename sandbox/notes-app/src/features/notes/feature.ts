import { defineFeature } from "@agentix/core";

import { notesContract, NoteStorage } from "./contract.js";
import { createNote, getNote } from "./operations.js";

export const notes = defineFeature({
  id: "notes",
  contract: notesContract,
  dependencies: [],
  operations: [createNote, getNote],
  invariants: [],
  ports: [NoteStorage],
});
