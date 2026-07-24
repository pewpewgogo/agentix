import {
  defineFeatureContract,
  definePort,
  portOperation,
  schema,
  type Infer,
} from "@agentixdev/core";

export const NoteId = schema.id("note");
export const NonBlankText = schema.refine(
  schema.string(),
  (value) => value.trim().length > 0,
  { id: "notes.non-blank-text", message: "Text must not be blank" },
);
export const Note = schema.object({
  id: NoteId,
  title: NonBlankText,
  body: schema.string(),
});

export type Note = Infer<typeof Note>;

export const NoteStorage = definePort({
  id: "note-storage",
  operations: {
    save: portOperation({
      id: "note-storage.save",
      kind: "write",
      input: Note,
      output: Note,
      errors: {
        NOTE_ALREADY_EXISTS: schema.object({ id: NoteId }),
      },
    }),
    get: portOperation({
      id: "note-storage.get",
      kind: "read",
      input: schema.object({ id: NoteId }),
      output: schema.optional(Note),
      errors: {},
    }),
  },
});

export const notesContract = defineFeatureContract({
  id: "notes",
  exports: { Note, NoteId },
});
