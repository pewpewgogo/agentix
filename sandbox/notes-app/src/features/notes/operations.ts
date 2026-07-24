import {
  defineCommand,
  defineQuery,
  domainError,
  err,
  ok,
  schema,
} from "@agentix/core";

import {
  NonBlankText,
  Note,
  NoteId,
  NoteStorage,
} from "./contract.js";

export const CreateNoteInput = schema.object({
  id: NoteId,
  title: NonBlankText,
  body: schema.string(),
});

export const createNote = defineCommand({
  id: "notes.create",
  input: CreateNoteInput,
  output: Note,
  errors: {
    NOTE_ALREADY_EXISTS: schema.object({ id: NoteId }),
  },
  permissions: ["notes:create"],
  effects: { save: NoteStorage.operations.save },
  emits: {},
  async execute({ input, effects }) {
    return effects.save(Note.parse({
      id: input.id,
      title: input.title.trim(),
      body: input.body,
    }));
  },
});

export const getNote = defineQuery({
  id: "notes.get",
  input: schema.object({ id: NoteId }),
  output: Note,
  errors: {
    NOTE_NOT_FOUND: schema.object({ id: NoteId }),
  },
  permissions: ["notes:read"],
  effects: { get: NoteStorage.operations.get },
  async execute({ input, effects }) {
    const loaded = await effects.get(input);
    if (!loaded.ok) return loaded;
    return loaded.value === undefined
      ? err(domainError("NOTE_NOT_FOUND", { id: input.id }))
      : ok(loaded.value);
  },
});
