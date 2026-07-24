import {
  bindPort,
  createApplication,
  domainError,
  err,
  ok,
  principal,
  type DispatchResult,
  type Outcome,
} from "@agentixdev/core";

import {
  Note,
  NoteId,
  NoteStorage,
  type Note as NoteRecord,
} from "./features/notes/contract.js";
import { notes } from "./features/notes/feature.js";
import {
  createNote,
  CreateNoteInput,
  getNote,
} from "./features/notes/operations.js";

const actor = principal("sandbox-user", ["notes:create", "notes:read"]);

const unwrap = <T, E>(result: DispatchResult<T, E>): Outcome<T, E> => {
  if (result.kind !== "completed") {
    throw new Error(`Unexpected Agentix dispatch result: ${result.kind}`);
  }
  return result.outcome;
};

export const createNotesSystem = () => {
  const notesById = new Map<string, NoteRecord>();
  const storage = bindPort(NoteStorage, {
    save: (input) => {
      const note = Note.parse(input);
      if (notesById.has(note.id)) {
        return err(domainError("NOTE_ALREADY_EXISTS", { id: note.id }));
      }
      notesById.set(note.id, note);
      return ok(note);
    },
    get: ({ id }) => ok(notesById.get(id)),
  });
  const application = createApplication({
    features: [notes],
    adapters: [storage],
    mode: "test",
  });

  return Object.freeze({
    async create(input: { readonly id: string; readonly title: string; readonly body: string }) {
      return unwrap(await application.dispatch(createNote, {
        input: CreateNoteInput.parse(input),
        principal: actor,
      }));
    },
    async get(id: string) {
      return unwrap(await application.dispatch(getNote, {
        input: { id: NoteId.parse(id) },
        principal: actor,
      }));
    },
  });
};
